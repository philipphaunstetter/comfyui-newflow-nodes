"""NewflowHumanInTheLoop — pause workflow execution and wait for human Approve / Reject.

The node displays the input IMAGE in a custom DOM widget along with two buttons:
- Approve: passes the image through to the output, workflow continues.
- Reject: raises InterruptProcessingException so ComfyUI cleanly stops the run.

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
import torch
from aiohttp import web
from PIL import Image

import comfy.model_management as mm
import folder_paths
from comfy_api.latest import io
from server import PromptServer

log = logging.getLogger(__name__)

DECISION_TIMEOUT = 600  # 10 minutes
POLL_INTERVAL = 0.5     # check for cancel every 500 ms


class NewflowHumanInTheLoop(io.ComfyNode):
    # Module-level waiter registry keyed by node unique_id (string).
    # value = (threading.Event, dict {"approved": bool|None})
    _waiters: dict = {}

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowHumanInTheLoop",
            display_name="Newflow Human in the Loop",
            category="newflow/utils",
            description=(
                "Pauses workflow execution and shows the input IMAGE in the node "
                "body. Click Approve to continue (image passes through to the "
                "output), or Reject to stop the workflow. Cancellation by "
                "ComfyUI's global Cancel button is honored. Timeout: 10 minutes."
            ),
            inputs=[io.Image.Input("images")],
            outputs=[io.Image.Output("IMAGE")],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, images):
        unique_id = str(cls.hidden.unique_id)

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
                {"node_id": unique_id, "images": saved},
            )
        except Exception:
            log.exception("NewflowHumanInTheLoop: failed to send WS event")

        # 3. Set up the waiter and block until Approve / Reject / cancel / timeout.
        event = threading.Event()
        result: dict = {"approved": None}
        cls._waiters[unique_id] = (event, result)

        try:
            deadline = time.monotonic() + DECISION_TIMEOUT
            while True:
                # Wait up to POLL_INTERVAL; loop checks for cancel & timeout.
                if event.wait(POLL_INTERVAL):
                    break
                if mm.processing_interrupted():
                    # User clicked the global Cancel — let ComfyUI handle it
                    # by raising the canonical interrupt exception.
                    raise mm.InterruptProcessingException()
                if time.monotonic() > deadline:
                    cls._notify_settled(unique_id, "timeout")
                    raise RuntimeError(
                        "Newflow Human in the Loop: timed out after "
                        f"{DECISION_TIMEOUT} seconds waiting for user decision."
                    )
        finally:
            cls._waiters.pop(unique_id, None)

        # 4. Act on the decision.
        if not result.get("approved"):
            cls._notify_settled(unique_id, "rejected")
            # Use ComfyUI's canonical interrupt exception so the workflow
            # is shown as cancelled rather than errored.
            raise mm.InterruptProcessingException()

        cls._notify_settled(unique_id, "approved")
        return io.NodeOutput(images, ui={"images": saved})

    # ----- helpers -----

    @classmethod
    def _save_to_temp(cls, images, unique_id):
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        # Tensor expected shape: (B, H, W, C) in 0..1.
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
    def _notify_settled(unique_id: str, outcome: str):
        try:
            PromptServer.instance.send_sync(
                "newflow.hitl.settled",
                {"node_id": unique_id, "outcome": outcome},
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Server route — JS POSTs here when the user clicks Approve / Reject.
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.post("/newflow/hitl/decide")
async def newflow_hitl_decide(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_id = str(body.get("node_id", ""))
    approved = bool(body.get("approved"))
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
    event.set()
    return web.json_response({"ok": True, "node_id": node_id, "approved": approved})
