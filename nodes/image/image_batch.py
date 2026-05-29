"""Merged Image Batch node — combines the former NewflowImageBatch and
NewflowImageArray (Clothing) into one node with a flat schema and a
simple ``mode`` Combo widget.

- ``Slots`` mode (default): the original ImageBatch behaviour — 8 fixed
  ``image_N`` IMAGE input sockets. Existing saved workflows continue
  working since the input ids are unchanged.
- ``Wardrobe`` mode: 4 ``IMAGE_N`` external sockets plus 8 ``garment_N``
  Combo upload widgets (drag-drop files directly, the LoadImage pattern).
  Old ``NewflowImageArray`` workflows auto-migrate via NodeReplace + a
  small JS ``beforeConfigureGraph`` shim that expands the legacy
  ``containers`` JSON widget into N positional ``garment_N`` values.

Both modes produce the same outputs: a white-padded ``IMAGE`` batch and an
``IMAGE_LIST`` at native resolutions. The padding/stacking logic lives in
:func:`pad_and_batch` and is shared.

The schema is intentionally flat — no DynamicCombo, no nested options.
DynamicCombo turned out to be incompatible with String/Image sockets
that need to be wired from upstream (nested sockets either don't render
or sit at zero-width). The JS reads the ``mode`` widget value and
hides/shows the appropriate widget rows.
"""

from __future__ import annotations

import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
from comfy_api.latest import io

from ._shared import pad_and_batch


# Slot count for the Slots-mode fixed inputs. Kept at 8 to preserve the
# old NewflowImageBatch socket layout exactly — old saved workflows wired
# to image_1..image_8 keep working without a NodeReplace.
NUM_SLOTS = 8

# Wardrobe-mode external IMAGE_N sockets inherited from NewflowImageArray.
# Preserved verbatim so existing Clothing workflows migrate cleanly.
NUM_WARDROBE_EXTERNAL = 4

# Fixed garment-slot count. Each garment is an io.Combo.Input with
# upload=image — mirrors LoadImage's pattern for drag-drop + file picker.
# (io.Autogrow can't be used here: it forces force_input=True on every
# WidgetInput template, stripping the upload widget.)
NUM_WARDROBE_SLOTS = 8

MODE_SLOTS = "Slots"
MODE_WARDROBE = "Wardrobe"


class NewflowImageBatch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        external_inputs = [
            io.Image.Input(
                f"IMAGE_{i + 1}",
                optional=True,
                tooltip=(
                    "Wardrobe-mode external image socket. Prepended to the "
                    "output in order. Ignored in Slots mode."
                ),
            )
            for i in range(NUM_WARDROBE_EXTERNAL)
        ]
        slot_inputs = [
            io.Image.Input(
                f"image_{i + 1}",
                optional=True,
                tooltip="Slots-mode image socket. Ignored in Wardrobe mode.",
            )
            for i in range(NUM_SLOTS)
        ]
        garment_inputs = [
            io.Combo.Input(
                f"garment_{i + 1}",
                options=[],
                optional=True,
                upload=io.UploadType.image,
                image_folder=io.FolderType.input,
                tooltip=(
                    "Wardrobe-mode garment slot. Drag-drop or pick an image; "
                    "stored in ComfyUI's input/ folder. Ignored in Slots mode."
                ),
            )
            for i in range(NUM_WARDROBE_SLOTS)
        ]

        return io.Schema(
            node_id="NewflowImageBatch",
            display_name="Newflow Image Batch",
            category="newflow/image",
            description=(
                "Combines multiple images into an IMAGE batch + a native-"
                "resolution IMAGE_LIST. Smaller images are padded with white "
                "to match the largest H × W; each image keeps its original "
                "aspect ratio.\n\n"
                "Slots mode: 8 optional image_N input sockets for chaining "
                "upstream image producers.\n\n"
                "Wardrobe mode: 4 IMAGE_N external sockets plus 8 garment "
                "upload widgets (drag-drop files directly). Replaces the "
                "former Newflow Clothing / Image Array node."
            ),
            inputs=[
                *external_inputs,
                *slot_inputs,
                *garment_inputs,
                io.Boolean.Input(
                    "flatten_batches",
                    default=True,
                    tooltip=(
                        "Slots mode: if true, multi-frame inputs are split "
                        "into individual frames before batching."
                    ),
                ),
                io.Combo.Input(
                    "mode",
                    options=[MODE_SLOTS, MODE_WARDROBE],
                    default=MODE_SLOTS,
                    tooltip=(
                        "Slots: use the image_N sockets. "
                        "Wardrobe: use IMAGE_N + garment_N (upload widgets)."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Image.Output("IMAGE_LIST", is_output_list=True),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, mode=MODE_SLOTS, flatten_batches=True, **kwargs):
        selected = mode if isinstance(mode, str) else MODE_SLOTS
        if selected == MODE_WARDROBE:
            tensors = cls._collect_wardrobe(kwargs)
        else:
            tensors = cls._collect_slots(kwargs, flatten_batches)

        if not tensors:
            # Nothing wired in: emit a 1×64×64 white placeholder so downstream
            # nodes don't crash on a zero-batch tensor.
            placeholder = torch.ones((1, 64, 64, 3))
            return io.NodeOutput(placeholder, [placeholder])

        batched, image_list = pad_and_batch(tensors)
        return io.NodeOutput(batched, image_list)

    # ---- mode-specific tensor collection --------------------------------

    @staticmethod
    def _collect_slots(kwargs: dict, flatten: bool) -> list[torch.Tensor]:
        """Slots mode — gather image_1..image_N in slot order."""
        flat: list[torch.Tensor] = []
        for i in range(NUM_SLOTS):
            tensor = kwargs.get(f"image_{i + 1}")
            if tensor is None:
                continue
            t = tensor
            if t.dim() == 3:
                t = t.unsqueeze(0)
            if flatten:
                for j in range(t.shape[0]):
                    flat.append(t[j : j + 1])
            else:
                flat.append(t)
        return flat

    @classmethod
    def _collect_wardrobe(cls, kwargs: dict) -> list[torch.Tensor]:
        """Wardrobe mode — externally wired IMAGE_N (first frame only) followed
        by each garment_N upload slot loaded from ComfyUI's input/ folder."""
        tensors: list[torch.Tensor] = []
        for i in range(NUM_WARDROBE_EXTERNAL):
            slot = kwargs.get(f"IMAGE_{i + 1}")
            if slot is None:
                continue
            t = slot
            if t.dim() == 3:
                t = t.unsqueeze(0)
            if t.shape[0] >= 1:
                tensors.append(t[0:1])
        for i in range(NUM_WARDROBE_SLOTS):
            filename = kwargs.get(f"garment_{i + 1}")
            tensor = cls._load_input_image(filename)
            if tensor is not None:
                tensors.append(tensor)
        return tensors

    @staticmethod
    def _load_input_image(filename) -> torch.Tensor | None:
        """Load a single image from ComfyUI's input/ folder as a (1, H, W, 3)
        float tensor in 0-1 range. Returns None for any failure (missing file,
        unreadable, unsupported format) so a single bad slot can't break the
        whole node."""
        if not isinstance(filename, str) or not filename.strip():
            return None
        try:
            base_dir = folder_paths.get_input_directory()
            path = os.path.join(base_dir, filename)
            if not os.path.isfile(path):
                return None
            img = Image.open(path)
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
            arr = np.asarray(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)
        except Exception:
            return None
