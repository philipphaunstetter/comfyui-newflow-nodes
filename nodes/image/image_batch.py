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

        return io.Schema(
            node_id="NewflowImageBatch",
            display_name="Newflow Image Batch",
            category="newflow/image",
            description=(
                "Combines externally-wired IMAGE_N sockets and a grid of "
                "labeled containers (directly-uploaded images with browse / "
                "include / reorder) into a single IMAGE batch + a native-"
                "resolution IMAGE_LIST. Smaller images are padded with white "
                "to match the largest H × W; each image keeps its original "
                "aspect ratio. Replaces the former Newflow Clothing / Image "
                "Array node."
            ),
            inputs=[*external_inputs],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Image.Output("IMAGE_LIST", is_output_list=True),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, **kwargs):
        tensors = cls._collect(kwargs)

        if not tensors:
            # Nothing wired/uploaded: emit a 1×64×64 white placeholder so
            # downstream nodes don't crash on a zero-batch tensor.
            placeholder = torch.ones((1, 64, 64, 3))
            return io.NodeOutput(placeholder, [placeholder])

        batched, image_list = pad_and_batch(tensors)
        return io.NodeOutput(batched, image_list)

    # ---- tensor collection ----------------------------------------------

    @classmethod
    def _collect(cls, kwargs: dict) -> list[torch.Tensor]:
        """Externally wired IMAGE_N (first frame only) followed by each
        included container's currently-selected uploaded image."""
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

        for img_meta in cls._iter_container_images():
            tensor = cls._load_image_meta(img_meta)
            if tensor is not None:
                tensors.append(tensor)
        return tensors

    @classmethod
    def _iter_container_images(cls):
        """Yield the currently-selected image meta dict for each included
        container, parsed from the ``containers`` DOM widget JSON in the
        prompt. A container may store either an ``images`` list (with a
        ``currentIdx``) or a flat ``filename`` (legacy single-image shape)."""
        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        raw = node_inputs.get(cls.WIDGET_NAME, "[]")

        try:
            containers = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            containers = []
        if not isinstance(containers, list):
            return

        for c in containers:
            if not isinstance(c, dict):
                continue
            if c.get("included", True) is False:
                continue

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
                    continue
            if not images_meta:
                continue

            current_idx = c.get("currentIdx", 0)
            if (
                not isinstance(current_idx, int)
                or current_idx < 0
                or current_idx >= len(images_meta)
            ):
                current_idx = 0
            img_meta = images_meta[current_idx]
            if isinstance(img_meta, dict):
                yield img_meta

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
