"""Merged Image Batch node — combines the former NewflowImageBatch and
NewflowImageArray (Clothing) into one node with a mode toggle.

- ``Slots`` mode (default): the original ImageBatch behaviour — 8 fixed
  IMAGE input sockets (``image_1`` .. ``image_8``). Existing saved
  workflows continue working since the input ids are unchanged.
- ``Wardrobe`` mode: rebuilt on ``io.Autogrow``. Each garment slot uses
  ComfyUI's built-in image-upload widget (drag-drop + file picker, same
  UX as LoadImage). Old ``NewflowImageArray`` workflows auto-migrate via
  NodeReplace + a small JS ``beforeConfigureGraph`` shim that expands the
  legacy ``containers`` JSON widget into N positional ``garment_N`` widgets.

Both modes produce the same outputs: a white-padded ``IMAGE`` batch and an
``IMAGE_LIST`` at native resolutions. The padding/stacking logic lives in
:func:`pad_and_batch` and is shared.
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

# Per-slot caps for the Autogrow garments. min=1 means the user sees at
# least one slot when a fresh node is dropped; max=16 is plenty for any
# wardrobe and well within Autogrow's hard limit of 100.
WARDROBE_MIN = 1
WARDROBE_MAX = 16

MODE_SLOTS = "Slots"
MODE_WARDROBE = "Wardrobe"


class NewflowImageBatch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        # External IMAGE sockets carried over from NewflowImageArray. Hoisted
        # to the top level (above the DynamicCombo) for two reasons:
        #  1. io.DynamicCombo.Input cannot be the *first* schema input —
        #     the frontend's dynamicComboWidget wiring fails with "Failed to
        #     find input socket for mode" when it is. Every working api_node
        #     in the ComfyUI codebase puts a regular input first.
        #  2. The old NewflowImageArray had these as top-level sockets, so
        #     keeping them top-level makes the NodeReplace mapping a clean
        #     1:1 (IMAGE_N -> IMAGE_N) instead of needing dot-notation.
        # In Slots mode these are simply ignored — execute() only consumes
        # them when mode == Wardrobe.
        external_inputs = [
            io.Image.Input(
                f"IMAGE_{i + 1}",
                optional=True,
                tooltip=(
                    "External image socket. Consumed in Wardrobe mode "
                    "(prepended to the output in order); ignored in Slots mode."
                ),
            )
            for i in range(NUM_WARDROBE_EXTERNAL)
        ]
        # NOTE: a DynamicCombo.Option whose sub-inputs are all sockets crashes
        # the frontend's dynamicComboWidget. Each Option needs at least one
        # widget. `flatten_batches` is the meaningful one here — controls
        # whether multi-frame inputs get flattened into individual frames
        # (default True, preserving the original NewflowImageBatch behaviour).
        slot_inputs = [
            io.Boolean.Input(
                "flatten_batches",
                default=True,
                tooltip=(
                    "If true, multi-frame inputs are split into individual "
                    "frames before batching. If false, each input contributes "
                    "its full batch as one entry (uncommon — leave on)."
                ),
            ),
            *[io.Image.Input(f"image_{i + 1}", optional=True) for i in range(NUM_SLOTS)],
        ]
        # io.Autogrow.TemplateNames (not TemplatePrefix) is the pattern proven
        # to work when nested inside a DynamicCombo Option — see
        # comfy_api_nodes/nodes_openrouter.py for the canonical example.
        garments_input = io.Autogrow.Input(
            "garments",
            template=io.Autogrow.TemplateNames(
                input=io.Combo.Input(
                    "file",
                    options=[],
                    upload=io.UploadType.image,
                    image_folder=io.FolderType.input,
                    tooltip="Drag-drop or pick a file. Stored in ComfyUI's input/ folder.",
                ),
                names=[f"garment_{i}" for i in range(WARDROBE_MAX)],
                min=WARDROBE_MIN,
            ),
            tooltip="Wardrobe slots — add/remove via the standard Autogrow controls.",
        )

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
                "Wardrobe mode: the IMAGE_N sockets are consumed (prepended "
                "in order) and an Autogrow list of per-slot garments lets "
                "you drag-drop files directly into each slot. Replaces the "
                "former Newflow Clothing / Image Array node."
            ),
            inputs=[
                *external_inputs,
                io.DynamicCombo.Input(
                    "mode",
                    options=[
                        io.DynamicCombo.Option(MODE_SLOTS, slot_inputs),
                        io.DynamicCombo.Option(MODE_WARDROBE, [garments_input]),
                    ],
                    tooltip=(
                        "Slots: 8 fixed IMAGE sockets. "
                        "Wardrobe: per-slot upload widgets (IMAGE_N sockets above are also used)."
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
    def execute(cls, mode, **kwargs):
        # Top-level IMAGE_N sockets arrive as direct kwargs (they live above
        # the DynamicCombo). The DynamicCombo dict carries Slot/Wardrobe-
        # specific sub-inputs (image_1..image_8 or garments).
        if not isinstance(mode, dict):
            mode = {}
        selected = mode.get("mode", MODE_SLOTS)

        if selected == MODE_WARDROBE:
            tensors = cls._collect_wardrobe(mode, kwargs)
        else:
            tensors = cls._collect_slots(mode)

        if not tensors:
            # Nothing wired in: emit a 1×64×64 white placeholder so downstream
            # nodes don't crash on a zero-batch tensor.
            placeholder = torch.ones((1, 64, 64, 3))
            return io.NodeOutput(placeholder, [placeholder])

        batched, image_list = pad_and_batch(tensors)
        return io.NodeOutput(batched, image_list)

    # ---- mode-specific tensor collection --------------------------------

    @staticmethod
    def _collect_slots(mode: dict) -> list[torch.Tensor]:
        """Slots mode — gather image_1..image_N in slot order. When
        ``flatten_batches`` is true (the default, matching the old
        NewflowImageBatch behaviour) multi-frame inputs are split into
        individual frames before batching; when false each input contributes
        its whole batch as a single entry."""
        flatten = mode.get("flatten_batches", True)
        flat: list[torch.Tensor] = []
        for i in range(NUM_SLOTS):
            tensor = mode.get(f"image_{i + 1}")
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
    def _collect_wardrobe(cls, mode: dict, top_level: dict) -> list[torch.Tensor]:
        """Wardrobe mode — externally wired IMAGE_N (first frame only) followed
        by each Autogrow garment slot loaded from input/."""
        tensors: list[torch.Tensor] = []

        # External sockets first, in numeric order. Matches the old
        # NewflowImageArray semantics where IMAGE_N prepended to the output.
        # IMAGE_N lives at the top level (above the DynamicCombo).
        for i in range(NUM_WARDROBE_EXTERNAL):
            slot = top_level.get(f"IMAGE_{i + 1}")
            if slot is None:
                continue
            t = slot
            if t.dim() == 3:
                t = t.unsqueeze(0)
            if t.shape[0] >= 1:
                tensors.append(t[0:1])

        # Autogrow garments — each slot value is a filename string under input/.
        garments = mode.get("garments")
        if isinstance(garments, dict):
            # Preserve slot order (garment_0, garment_1, …) regardless of the
            # dict's internal iteration order in case ComfyUI ever changes it.
            ordered_keys = sorted(
                garments.keys(),
                key=lambda k: cls._garment_index(k),
            )
            for key in ordered_keys:
                filename = garments.get(key)
                tensor = cls._load_input_image(filename)
                if tensor is not None:
                    tensors.append(tensor)

        return tensors

    @staticmethod
    def _garment_index(key: str) -> int:
        # garment_0 -> 0, garment_12 -> 12; non-conforming keys sort last.
        prefix = "garment_"
        if key.startswith(prefix):
            try:
                return int(key[len(prefix):])
            except ValueError:
                return 10_000
        return 10_000

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
