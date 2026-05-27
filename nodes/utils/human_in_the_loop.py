"""NewflowHumanInTheLoop — pause workflow execution and wait for human Approve / Reject.

The node displays the input IMAGE in a custom DOM widget along with decision buttons:
- Approve: passes the image through the APPROVED output, workflow continues.
- Reject (reason N): routes the image to the matching REJECTED_N output without
  stopping the workflow; other rejection outputs fire None so their branches are skipped.

Up to NUM_REJECTION_SLOTS rejection reason labels can be configured via string inputs.
`execute()` blocks on a `threading.Event` until JS POSTs the decision to
/newflow/hitl/decide. We poll comfy.model_management.processing_interrupted() so
ComfyUI's global Cancel button still works while we're waiting.
"""

from __future__ import annotations

import logging
import os
import threading
import time

import numpy as np
from aiohttp import web
from PIL import Image

import comfy.model_management as mm
import folder_paths
from comfy_api.latest import io
from server import PromptServer

log = logging.getLogger(__name__)

DECISION_TIMEOUT = 600  # 10 minutes
POLL_INTERVAL = 0.5     # check for cancel every 500 ms
NUM_REJECTION_SLOTS = 4


class NewflowHumanInTheLoop(io.ComfyNode):
    # Module-level waiter registry keyed by node unique_id (string).
    # value = (threading.Event, dict {"approved": bool|None, "reason_index": int|None})
    _waiters: dict = {}

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowHumanInTheLoop",
            display_name="Newflow Human in the Loop",
            category="newflow/utils",
            description=(
                "Pauses workflow execution and shows the input IMAGE for review. "
                "Approve passes the image through the APPROVED output. "
                "Reject routes the image to the matching REJECTED_N output (based on "
                "the selected reason) without stopping the workflow — branches wired "
                "to unselected rejection outputs are simply skipped. "
                "Cancellation by ComfyUI's global Cancel button is honored. Timeout: 10 minutes."
            ),
            inputs=[
                io.Image.Input("images"),
                *[
                    io.String.Input(
                        f"rejection_reason_{i + 1}",
                        default="Reason 1" if i == 0 else "",
                    )
                    for i in range(NUM_REJECTION_SLOTS)
                ],
            ],
            outputs=[
                io.Image.Output("APPROVED"),
                *[io.Image.Output(f"REJECTED_{i + 1}") for i in range(NUM_REJECTION_SLOTS)],
                io.String.Output("REJECTION_REASON"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, images,
                rejection_reason_1="Reason 1",
                rejection_reason_2="",
                rejection_reason_3="",
                rejection_reason_4=""):
        unique_id = str(cls.hidden.unique_id)
        labels = [rejection_reason_1, rejection_reason_2, rejection_reason_3, rejection_reason_4]

        # 1. Save preview images to temp dir so the UI can render them via /view.
        try:
            saved = cls._save_to_temp(images, unique_id)
        except Exception as e:
            log.exception("NewflowHumanInTheLoop: failed to save preview images")
            raise RuntimeError(f"HumanInTheLoop preview save failed: {e}")

        # 2. Tell the UI we're awaiting a decision.
        try:
            PromptServer.instance.send_sync(
                "newflow.hitl.awaiting",
                {"node_id": unique_id, "images": saved, "labels": labels},
            )
        except Exception:
            log.exception("NewflowHumanInTheLoop: failed to send WS event")

        # 3. Set up the waiter and block until Approve / Reject / cancel / timeout.
        event = threading.Event()
        result: dict = {"approved": None, "reason_index": None}
        cls._waiters[unique_id] = (event, result)

        try:
            deadline = time.monotonic() + DECISION_TIMEOUT
            while True:
                if event.wait(POLL_INTERVAL):
                    break
                if mm.processing_interrupted():
                    raise mm.InterruptProcessingException()
                if time.monotonic() > deadline:
                    cls._notify_settled(unique_id, "timeout", "")
                    raise RuntimeError(
                        "Newflow Human in the Loop: timed out after "
                        f"{DECISION_TIMEOUT} seconds waiting for user decision."
                    )
        finally:
            cls._waiters.pop(unique_id, None)

        # 4. Act on the decision.
        if result.get("approved"):
            cls._notify_settled(unique_id, "approved", "")
            # APPROVED fires; all REJECTED_N outputs are None (their branches skip).
            return io.NodeOutput(images, None, None, None, None, "", ui={"images": saved})

        # Rejected: route image to the selected rejection slot.
        reason_index = result.get("reason_index") or 0
        reason_index = max(0, min(reason_index, NUM_REJECTION_SLOTS - 1))
        reason_text = labels[reason_index] if reason_index < len(labels) else ""

        cls._notify_settled(unique_id, "rejected", reason_text)

        rejected = [None] * NUM_REJECTION_SLOTS
        rejected[reason_index] = images
        # Output order: APPROVED, REJECTED_1..N, REJECTION_REASON
        return io.NodeOutput(None, *rejected, reason_text, ui={"images": saved})

    # ----- helpers -----

    @classmethod
    def _save_to_temp(cls, images, unique_id):
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        tensor = images
        if tensor is None:
            return []
        if hasattr(tensor, "cpu"):
            arr = tensor.cpu().numpy()
        else:
            arr = np.asarray(tensor)
        if arr.ndim == 3:
            arr = arr[None, ...]
        if arr.ndim != 4:
            return []

        arr = (arr * 255.0).clip(0, 255).astype(np.uint8)
        prefix = f"hitl_{unique_id}_{int(time.time())}_"
        results = []
        for i, frame in enumerate(arr):
            if frame.shape[-1] == 1:
                img = Image.fromarray(frame[..., 0], mode="L")
            else:
                img = Image.fromarray(frame)
            filename = f"{prefix}{i:03d}.png"
            path = os.path.join(temp_dir, filename)
            img.save(path)
            results.append(
                {"filename": filename, "subfolder": "", "type": "temp"}
            )
        return results

    @staticmethod
    def _notify_settled(unique_id: str, outcome: str, reason: str):
        try:
            PromptServer.instance.send_sync(
                "newflow.hitl.settled",
                {"node_id": unique_id, "outcome": outcome, "reason": reason},
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Server route — JS POSTs here when the user clicks Approve / a Reject reason.
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.post("/newflow/hitl/decide")
async def newflow_hitl_decide(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_id = str(body.get("node_id", ""))
    approved = bool(body.get("approved"))
    reason_index = int(body.get("reason_index", 0))

    if not node_id:
        return web.json_response({"error": "node_id required"}, status=400)

    waiter = NewflowHumanInTheLoop._waiters.get(node_id)
    if not waiter:
        return web.json_response(
            {"error": "no waiter registered for this node — workflow may not be running"},
            status=409,
        )

    event, result = waiter
    result["approved"] = approved
    result["reason_index"] = reason_index
    event.set()
    return web.json_response({
        "ok": True,
        "node_id": node_id,
        "approved": approved,
        "reason_index": reason_index,
    })
