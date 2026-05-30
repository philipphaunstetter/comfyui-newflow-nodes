"""Newflow Image Batch — a single Wardrobe node (no mode switcher).

The node combines images from two sources into one batch:

- up to sixteen ``IMAGE_N`` external sockets for upstream image producers. They
  grow one at a time (autogrow): ``IMAGE_1`` shows first, ``IMAGE_2`` appears
  once ``IMAGE_1`` is connected, and so on (capped at 16).
- an arbitrary number of labeled *containers* with directly-uploaded images
  (drag-drop / file picker), per-card image browsing, an include toggle,
  remove and drag-reorder, plus an "+ Add container" button. The container
  data lives in a single ``containers`` DOM widget (JSON) read here from the
  prompt.

Outputs: a white-padded ``IMAGE`` batch (samplers / preview compatible) and an
``IMAGE_LIST`` at native resolutions (for vision LLMs). The padding/stacking
logic lives in :func:`pad_and_batch` and is shared.

This replaces the earlier two-mode (Slots / Wardrobe) version and the former
Newflow Clothing / Image Array node. Old saved workflows auto-migrate to this
shape via a JS ``beforeConfigureGraph`` shim (see js/image_batch.js).
"""

from __future__ import annotations

import json
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
from comfy_api.latest import io

from ._shared import pad_and_batch


# External IMAGE_N sockets. The frontend reveals them progressively
# (IMAGE_1, then IMAGE_2 once IMAGE_1 is connected, …).
# Keep in sync with EXTERNAL_MAX in js/image_batch.js.
NUM_EXTERNAL = 16

# Per-container single-image outputs: IMAGE1, IMAGE2, … One is declared per
# possible container (capped here); the frontend reveals exactly as many as
# there are containers. Keep in sync with MAX_CONTAINER_OUTPUTS in
# js/image_batch.js.
MAX_CONTAINER_OUTPUTS = 32


def _empty_image() -> torch.Tensor:
    """A 0-image batch — an IMAGE output carrying 'nothing'. Used for a
    container whose include box is off (or that has no image), and for the
    unused trailing output slots. Downstream batch loops / previews get no
    frames; nodes that require ≥1 image will (expectedly) reject it."""
    return torch.zeros((0, 64, 64, 3))


class NewflowImageBatch(io.ComfyNode):
    # DOM widget (added by js/image_batch.js) holding the container array as
    # JSON. Not a schema input — read from the prompt in execute().
    WIDGET_NAME = "containers"

    @classmethod
    def define_schema(cls):
        external_inputs = [
            io.Image.Input(
                f"IMAGE_{i + 1}",
                optional=True,
                tooltip=(
                    "External image socket — prepended to the output in order. "
                    "Connect upstream image producers here; the sockets grow "
                    "one at a time as you wire them."
                ),
            )
            for i in range(NUM_EXTERNAL)
        ]

        per_container_outputs = [
            io.Image.Output(
                f"IMAGE{i + 1}",
                tooltip=(
                    f"Container {i + 1}'s selected image, on its own — empty "
                    "(0-image batch) when that container's include box is off "
                    "or it has no image."
                ),
            )
            for i in range(MAX_CONTAINER_OUTPUTS)
        ]

        return io.Schema(
            node_id="NewflowImageBatch",
            display_name="Newflow Image Batch",
            category="newflow/image",
            description=(
                "Combines externally-wired IMAGE_N sockets and a grid of "
                "labeled containers (directly-uploaded images with browse / "
                "include / reorder) into a single IMAGE batch + a native-"
                "resolution IMAGE_LIST, plus one IMAGE{n} output per container "
                "carrying just that container's image. Smaller images are "
                "padded with white to match the largest H × W; each image "
                "keeps its original aspect ratio. Replaces the former Newflow "
                "Clothing / Image Array node."
            ),
            inputs=[*external_inputs],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Image.Output("IMAGE_LIST", is_output_list=True),
                *per_container_outputs,
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, **kwargs):
        external = cls._collect_external(kwargs)
        states = cls._container_states()  # ordered: (tensor|None, included)

        # Aggregate IMAGE / IMAGE_LIST: external sockets + INCLUDED containers.
        batch_tensors = list(external) + [
            t for (t, included) in states if included and t is not None
        ]
        if batch_tensors:
            batched, image_list = pad_and_batch(batch_tensors)
        else:
            # Nothing wired/uploaded: emit a 1×64×64 white placeholder so
            # downstream nodes don't crash on a zero-batch tensor.
            placeholder = torch.ones((1, 64, 64, 3))
            batched, image_list = placeholder, [placeholder]

        # Per-container outputs IMAGE1..IMAGE{MAX}: container i → IMAGE{i+1},
        # by position regardless of include so toggling a box never shifts the
        # other sockets. Empty (0-image batch) when excluded, imageless, or
        # beyond the current container count.
        per_container: list[torch.Tensor] = []
        for i in range(MAX_CONTAINER_OUTPUTS):
            if i < len(states):
                tensor, included = states[i]
                per_container.append(
                    tensor if (included and tensor is not None) else _empty_image()
                )
            else:
                per_container.append(_empty_image())

        return io.NodeOutput(batched, image_list, *per_container)

    # ---- tensor collection ----------------------------------------------

    @classmethod
    def _collect_external(cls, kwargs: dict) -> list[torch.Tensor]:
        """Externally wired IMAGE_N sockets, first frame of each, in order."""
        tensors: list[torch.Tensor] = []
        for i in range(NUM_EXTERNAL):
            slot = kwargs.get(f"IMAGE_{i + 1}")
            if slot is None:
                continue
            t = slot
            if t.dim() == 3:
                t = t.unsqueeze(0)
            if t.shape[0] >= 1:
                tensors.append(t[0:1])
        return tensors

    @classmethod
    def _container_states(cls) -> list[tuple[torch.Tensor | None, bool]]:
        """Ordered ``(tensor_or_None, included)`` for EVERY container (not just
        included ones), parsed from the ``containers`` DOM widget JSON in the
        prompt. Drives both the batch (included only) and the per-container
        IMAGE{n} outputs (all, by position)."""
        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        raw = node_inputs.get(cls.WIDGET_NAME, "[]")

        try:
            containers = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            containers = []
        if not isinstance(containers, list):
            return []

        states: list[tuple[torch.Tensor | None, bool]] = []
        for c in containers:
            if not isinstance(c, dict):
                continue
            included = c.get("included", True) is not False
            img_meta = cls._selected_meta(c)
            tensor = cls._load_image_meta(img_meta) if img_meta else None
            states.append((tensor, included))
        return states

    @staticmethod
    def _selected_meta(c: dict) -> dict | None:
        """The currently-selected image meta dict for one container. A
        container stores either an ``images`` list (with a ``currentIdx``) or a
        flat ``filename`` (legacy single-image shape)."""
        images_meta = c.get("images")
        if not isinstance(images_meta, list):
            if c.get("filename"):
                images_meta = [
                    {
                        "filename": c.get("filename"),
                        "subfolder": c.get("subfolder", ""),
                        "type": c.get("type", "input"),
                    }
                ]
            else:
                return None
        if not images_meta:
            return None

        current_idx = c.get("currentIdx", 0)
        if (
            not isinstance(current_idx, int)
            or current_idx < 0
            or current_idx >= len(images_meta)
        ):
            current_idx = 0
        img_meta = images_meta[current_idx]
        return img_meta if isinstance(img_meta, dict) else None

    @staticmethod
    def _load_image_meta(img_meta: dict) -> torch.Tensor | None:
        """Load a single image described by a ``{filename, subfolder, type}``
        meta dict as a (1, H, W, 3) float tensor in 0-1 range. Returns None for
        any failure so a single bad container can't break the whole node."""
        filename = img_meta.get("filename")
        if not filename:
            return None
        subfolder = img_meta.get("subfolder", "") or ""
        file_type = img_meta.get("type", "input") or "input"
        try:
            if file_type == "input":
                base_dir = folder_paths.get_input_directory()
            elif file_type == "temp":
                base_dir = folder_paths.get_temp_directory()
            else:
                return None
            path = (
                os.path.join(base_dir, subfolder, filename)
                if subfolder
                else os.path.join(base_dir, filename)
            )
            if not os.path.isfile(path):
                return None
            img = Image.open(path)
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
            arr = np.asarray(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)
        except Exception:
            return None
