"""NewflowHumanInTheLoop v2 — per-image review with dynamic named outputs.

The node pauses workflow execution and renders the input IMAGE batch as a
per-image card grid in the frontend. Each card has its own approve/reject
state; rejection reasons are user-managed (add/rename/remove/reorder, capped at
:data:`MAX_REJECTION_SLOTS`) and each reason maps to its own labeled
``REJECTED_N`` output socket.

Output layout (frozen at registration; the JS hides/renames the REJECTED tail):

- idx 0  ``APPROVED``        IMAGE — ``torch.cat`` of approved frames; ``None``
  if zero approved.
- idx 1  ``REJECTION_REASON`` STRING — newline-joined per-image labels (empty
  line for approved positions). Always a real string. Fixed position so that
  the STRING output never collides with the REJECTED IMAGE positions when the
  JS hides trailing slots (ComfyUI maps the i-th visible output to schema
  index i, so heterogeneous types must live at fixed indices).
- idx 2..17 ``REJECTED_1..REJECTED_16`` IMAGE — one per possible reason. Each
  carries ``torch.cat`` of frames rejected with that ``reason_id``; ``None``
  for empty buckets or trailing hidden slots.

Decide protocol — POST ``/newflow/hitl/decide`` body::

    {"node_id": "...",
     "decisions": [{"image_index": 0, "approved": true, "reason_id": null},
                   {"image_index": 1, "approved": false, "reason_id": "r_abc"},
                   ...]}

Exactly one entry per input frame; ``image_index`` 0-based with no gaps and no
duplicates; ``reason_id`` ``null`` iff ``approved`` is true.

WebSocket events:

- ``newflow.hitl.awaiting`` ``{node_id, images:[{image_id, image_index,
  filename, subfolder, type}], reasons:[{id, label}]}``
- ``newflow.hitl.settled`` ``{node_id, outcome: 'settled'|'timeout'|
  'cancelled', approved_count, rejected_counts:{reason_id:count}, total}``

The reasons list lives in a DOM widget on the JS side (name ``reasons_state``,
``serialize=true``); Python reads its JSON from ``cls.hidden.prompt`` exactly
like ``NewflowImageBatch`` reads its ``containers`` widget.
"""

from __future__ import annotations

import json
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

# Static cap on rejection-reason output sockets. The frontend reveals exactly
# ``len(reasons_state)`` of them and hides the rest. Keep in sync with
# MAX_REJECTION_SLOTS in js/human_in_the_loop.js.
MAX_REJECTION_SLOTS = 16

# Name of the DOM widget that holds the JSON-serialized reasons list. Added by
# the JS extension with ``serialize: true`` so ComfyUI ships it inside the
# prompt's ``inputs`` map. Keep in sync with REASONS_WIDGET in js.
REASONS_WIDGET = "reasons_state"


class NewflowHumanInTheLoop(io.ComfyNode):
    # Module-level waiter registry keyed by node ``unique_id`` (string).
    # Value: ``(threading.Event, {"decisions": list[dict]|None,
    #                              "error": str|None})``.
    _waiters: dict = {}

    # Per-node list of temp preview files saved during the current awaiting
    # cycle, popped + unlinked once execute() finishes (success, timeout, or
    # interrupt). Without this, every run leaves N PNGs in temp_dir.
    _temp_files: dict = {}

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowHumanInTheLoop",
            display_name="Newflow Human in the Loop",
            category="newflow/utils",
            description=(
                "Pauses workflow execution and renders the IMAGE batch as a "
                "per-image card grid. Approve or reject each frame "
                "independently; rejected frames are routed to the labeled "
                "REJECTED_N output matching the chosen reason. Reasons (and "
                "their socket names) are user-editable on the node, up to 16. "
                "REJECTION_REASON carries newline-joined per-image labels in "
                "input order. Cancellation by ComfyUI's global Cancel button "
                "is honored; review times out after 10 minutes."
            ),
            inputs=[
                io.Image.Input("images"),
            ],
            outputs=[
                io.Image.Output("APPROVED"),
                io.String.Output("REJECTION_REASON"),
                *[
                    io.Image.Output(f"REJECTED_{i + 1}")
                    for i in range(MAX_REJECTION_SLOTS)
                ],
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # NaN is the canonical "never matches" sentinel: ComfyUI's cache
        # compares fingerprints with == and ``NaN != NaN``. Forces a fresh
        # human review every queue, even if the upstream inputs are identical
        # (the v1 bug was that an unchanged upstream silently skipped the
        # pause).
        return float("NaN")

    # ------------------------------------------------------------------
    # execute
    # ------------------------------------------------------------------

    @classmethod
    def execute(cls, images):
        unique_id = str(cls.hidden.unique_id)

        # 1. Validate input batch. Zero-frame batch has no sensible review
        # UX, and downstream None propagation would be indistinguishable from
        # a real reject — fail loud.
        batch_size = int(images.shape[0])
        if batch_size == 0:
            raise RuntimeError(
                "Newflow Human in the Loop: received an empty image batch."
            )

        # 2. Parse the live reasons list from the prompt (the JS DOM widget
        # writes here). Falls back to a single synthetic reason on any
        # corruption so the node never crashes mid-pause.
        reasons = cls._read_reasons(unique_id)

        # 3. Save one preview PNG per frame. Each saved entry carries an
        # ``image_id`` and ``image_index`` so the JS can address frames by
        # stable id rather than array position.
        try:
            saved = cls._save_to_temp(images, unique_id)
        except Exception as exc:
            log.exception("NewflowHumanInTheLoop: failed to save preview images")
            raise RuntimeError(f"HumanInTheLoop preview save failed: {exc}")
        cls._temp_files[unique_id] = [
            os.path.join(folder_paths.get_temp_directory(), s["filename"])
            for s in saved
        ]

        # 4. Notify the frontend that we're awaiting per-image decisions.
        try:
            PromptServer.instance.send_sync(
                "newflow.hitl.awaiting",
                {
                    "node_id": unique_id,
                    "images": saved,
                    "reasons": [{"id": r["id"], "label": r["label"]} for r in reasons],
                },
            )
        except Exception:
            log.exception("NewflowHumanInTheLoop: failed to send awaiting event")

        # 5. Register the waiter and block until the JS POSTs decisions
        # (or the user cancels, or the deadline passes).
        event = threading.Event()
        result: dict = {"decisions": None, "error": None}
        try:
            cls._waiters[unique_id] = (event, result)

            deadline = time.monotonic() + DECISION_TIMEOUT
            while True:
                if event.wait(POLL_INTERVAL):
                    break
                if mm.processing_interrupted():
                    cls._notify_settled(unique_id, "cancelled", 0, {}, batch_size)
                    raise mm.InterruptProcessingException()
                if time.monotonic() > deadline:
                    cls._notify_settled(unique_id, "timeout", 0, {}, batch_size)
                    raise RuntimeError(
                        "Newflow Human in the Loop: timed out after "
                        f"{DECISION_TIMEOUT} seconds waiting for user decision."
                    )
        finally:
            cls._waiters.pop(unique_id, None)

        # 6. Decisions ready (or HTTP-validation failure surfaced as error).
        try:
            if result.get("error"):
                raise RuntimeError(result["error"])
            decisions = result.get("decisions") or []

            # Belt-and-suspenders: the HTTP handler already validated shape,
            # but a stale-waiter race or hand-edited POST could still slip
            # through. Re-check against the live reasons list and batch size.
            cls._validate_decisions(decisions, batch_size, reasons)

            approved_tensor, rejected_slots, reason_string, summary = cls._bucket(
                images, decisions, reasons, batch_size
            )

            cls._notify_settled(
                unique_id,
                "settled",
                summary["approved_count"],
                summary["rejected_counts"],
                batch_size,
            )

            return io.NodeOutput(
                approved_tensor,
                reason_string,
                *rejected_slots,
                ui={"images": saved},
            )
        finally:
            cls._cleanup_temp(unique_id)

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @classmethod
    def _read_reasons(cls, unique_id: str) -> list[dict]:
        """Parse the ``reasons_state`` DOM-widget JSON from the prompt.

        Falls back to a single synthetic reason on any corruption so the node
        always has at least one rejection slot to route into.
        """
        prompt = cls.hidden.prompt or {}
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        raw = node_inputs.get(REASONS_WIDGET, "")
        try:
            parsed = json.loads(raw) if isinstance(raw, str) and raw else []
        except json.JSONDecodeError:
            parsed = []
        if not isinstance(parsed, list):
            parsed = []

        reasons: list[dict] = []
        for entry in parsed[:MAX_REJECTION_SLOTS]:
            if not isinstance(entry, dict):
                continue
            rid = entry.get("id")
            label = entry.get("label", "")
            if not isinstance(rid, str) or not rid:
                continue
            if not isinstance(label, str):
                label = ""
            reasons.append({"id": rid, "label": label})

        if not reasons:
            reasons = [{"id": "r_default", "label": "Rejected"}]
        return reasons

    @classmethod
    def _validate_decisions(cls, decisions, batch_size: int, reasons: list[dict]) -> None:
        if not isinstance(decisions, list):
            raise RuntimeError("decisions must be a list")
        if len(decisions) != batch_size:
            raise RuntimeError(
                f"decisions length {len(decisions)} does not match image count {batch_size}"
            )
        seen: set[int] = set()
        valid_ids = {r["id"] for r in reasons}
        for d in decisions:
            if not isinstance(d, dict):
                raise RuntimeError("decisions entries must be objects")
            idx = d.get("image_index")
            if not isinstance(idx, int) or idx < 0 or idx >= batch_size:
                raise RuntimeError(f"invalid image_index {idx!r}")
            if idx in seen:
                raise RuntimeError(f"duplicate image_index {idx}")
            seen.add(idx)
            if not d.get("approved"):
                rid = d.get("reason_id")
                if rid not in valid_ids:
                    raise RuntimeError(f"unknown reason_id {rid!r}")

    @classmethod
    def _bucket(
        cls,
        images: torch.Tensor,
        decisions: list[dict],
        reasons: list[dict],
        batch_size: int,
    ) -> tuple[torch.Tensor | None, list[torch.Tensor | None], str, dict]:
        """Bucket frames by decision, preserving input order within each
        bucket. Returns ``(approved_tensor, rejected_slots[16],
        reason_string, summary)``."""
        approved_indices: list[int] = []
        rejected_by_reason_id: dict[str, list[int]] = {r["id"]: [] for r in reasons}
        per_image_reason = [""] * batch_size
        label_by_id = {r["id"]: r["label"] for r in reasons}

        for d in decisions:
            idx = d["image_index"]
            if d["approved"]:
                approved_indices.append(idx)
            else:
                rid = d["reason_id"]
                rejected_by_reason_id[rid].append(idx)
                per_image_reason[idx] = label_by_id.get(rid, "")

        approved_tensor = images[approved_indices] if approved_indices else None

        rejected_slots: list[torch.Tensor | None] = [None] * MAX_REJECTION_SLOTS
        for i, r in enumerate(reasons):
            idxs = rejected_by_reason_id[r["id"]]
            if idxs:
                rejected_slots[i] = images[idxs]
        # Trailing slots (i >= len(reasons)) stay None.

        reason_string = "\n".join(per_image_reason)

        summary = {
            "approved_count": len(approved_indices),
            "rejected_counts": {
                rid: len(idxs)
                for rid, idxs in rejected_by_reason_id.items()
                if idxs
            },
        }
        return approved_tensor, rejected_slots, reason_string, summary

    @classmethod
    def _save_to_temp(cls, images: torch.Tensor, unique_id: str) -> list[dict]:
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        tensor = images
        if hasattr(tensor, "cpu"):
            arr = tensor.cpu().numpy()
        else:
            arr = np.asarray(tensor)
        if arr.ndim == 3:
            arr = arr[None, ...]
        if arr.ndim != 4:
            return []

        arr = (arr * 255.0).clip(0, 255).astype(np.uint8)
        # ns-resolution timestamp avoids sub-second collisions on loops.
        prefix = f"hitl_{unique_id}_{time.time_ns()}_"
        results: list[dict] = []
        for i, frame in enumerate(arr):
            if frame.shape[-1] == 1:
                img = Image.fromarray(frame[..., 0], mode="L")
            else:
                img = Image.fromarray(frame)
            filename = f"{prefix}{i:03d}.png"
            path = os.path.join(temp_dir, filename)
            img.save(path)
            results.append(
                {
                    "image_id": f"img_{i}",
                    "image_index": i,
                    "filename": filename,
                    "subfolder": "",
                    "type": "temp",
                }
            )
        return results

    @classmethod
    def _cleanup_temp(cls, unique_id: str) -> None:
        for path in cls._temp_files.pop(unique_id, []):
            try:
                os.remove(path)
            except OSError:
                pass

    @staticmethod
    def _notify_settled(
        unique_id: str,
        outcome: str,
        approved_count: int,
        rejected_counts: dict,
        total: int,
    ) -> None:
        try:
            PromptServer.instance.send_sync(
                "newflow.hitl.settled",
                {
                    "node_id": unique_id,
                    "outcome": outcome,
                    "approved_count": approved_count,
                    "rejected_counts": rejected_counts,
                    "total": total,
                },
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Server route — JS POSTs here with the per-image decisions array.
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.post("/newflow/hitl/decide")
async def newflow_hitl_decide(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_id = str(body.get("node_id", ""))
    if not node_id:
        return web.json_response({"error": "node_id required"}, status=400)

    decisions = body.get("decisions")
    if not isinstance(decisions, list):
        return web.json_response({"error": "decisions array required"}, status=400)

    waiter = NewflowHumanInTheLoop._waiters.get(node_id)
    if not waiter:
        return web.json_response(
            {"error": "no waiter registered for this node — workflow may not be running"},
            status=409,
        )

    # Shape-level validation. Semantic validation (length match vs batch_size,
    # reason_id resolution vs current reasons_state) is re-checked inside
    # execute() against the live state to protect against mid-pause edits.
    normalized: list[dict] = []
    seen: set[int] = set()
    for d in decisions:
        if not isinstance(d, dict):
            return web.json_response(
                {"error": "decisions entries must be objects"}, status=400
            )
        idx = d.get("image_index")
        if not isinstance(idx, int) or idx < 0:
            return web.json_response(
                {"error": f"invalid image_index {idx!r}"}, status=400
            )
        if idx in seen:
            return web.json_response(
                {"error": f"duplicate image_index {idx}"}, status=400
            )
        seen.add(idx)
        approved = bool(d.get("approved"))
        reason_id = d.get("reason_id") if not approved else None
        if not approved and not (isinstance(reason_id, str) and reason_id):
            return web.json_response(
                {"error": "rejected decisions must include reason_id"},
                status=400,
            )
        normalized.append(
            {"image_index": idx, "approved": approved, "reason_id": reason_id}
        )
    normalized.sort(key=lambda e: e["image_index"])

    event, result = waiter
    result["decisions"] = normalized
    event.set()

    approved_count = sum(1 for d in normalized if d["approved"])
    rejected_counts: dict[str, int] = {}
    for d in normalized:
        if not d["approved"]:
            rejected_counts[d["reason_id"]] = rejected_counts.get(d["reason_id"], 0) + 1

    return web.json_response(
        {
            "ok": True,
            "node_id": node_id,
            "summary": {
                "approved_count": approved_count,
                "rejected_counts": rejected_counts,
                "total": len(normalized),
            },
        }
    )
