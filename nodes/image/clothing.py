import json
import os

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

import folder_paths
from comfy_api.latest import io


class NewflowClothing(io.ComfyNode):
    """A self-contained image batcher for clothing/wardrobe references.

    Each row in the node is one labeled container (e.g. "Top", "Trousers",
    "Shoes", "Accessory #1"). The user uploads images directly into the node
    via drag-drop or file picker — no separate Load Image nodes needed.

    Output is the same as NewflowImageBatch: a padded IMAGE batch where each
    image keeps its original aspect ratio (smaller ones are white-padded to
    the largest H × W in the set).

    The optional SET CARD input, when connected, becomes Image 1 in the
    output batch (containers shift to Image 2+).
    """

    WIDGET_NAME = "containers"

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowClothing",
            display_name="Newflow Clothing",
            category="newflow/image",
            description=(
                "A wardrobe of labeled clothing image uploads. Add containers, "
                "upload images directly, drag to reorder. Outputs a padded "
                "IMAGE batch with original aspect ratios preserved. Optional "
                "SET CARD input becomes Image 1 when connected."
            ),
            inputs=[
                io.Image.Input("set_card", optional=True),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Image.Output("IMAGE_LIST", is_output_list=True),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, set_card=None):
        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        raw = node_inputs.get(cls.WIDGET_NAME, "[]")

        try:
            containers = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            containers = []
        if not isinstance(containers, list):
            containers = []

        tensors: list[torch.Tensor] = []

        # Prepend SET CARD if connected (single image only — first frame of any batch).
        if set_card is not None:
            sc = set_card
            if sc.dim() == 3:
                sc = sc.unsqueeze(0)
            if sc.shape[0] >= 1:
                tensors.append(sc[0:1])

        for c in containers:
            if not isinstance(c, dict):
                continue
            # Per-container include toggle (defaults to True for back-compat).
            if c.get("included", True) is False:
                continue

            # New multi-image shape: c["images"] is a list of {filename, subfolder, type}.
            # Old single-image shape: c["filename"] (kept for back-compat).
            images_meta = c.get("images")
            if not isinstance(images_meta, list):
                if c.get("filename"):
                    images_meta = [{
                        "filename": c.get("filename"),
                        "subfolder": c.get("subfolder", ""),
                        "type": c.get("type", "input"),
                    }]
                else:
                    continue

            if not images_meta:
                continue

            # Each container holds a gallery of variants; only the currently
            # selected one (the visible thumbnail) flows into the output.
            current_idx = c.get("currentIdx", 0)
            if not isinstance(current_idx, int) or current_idx < 0 or current_idx >= len(images_meta):
                current_idx = 0
            img_meta = images_meta[current_idx]
            if not isinstance(img_meta, dict):
                continue
            filename = img_meta.get("filename")
            if not filename:
                continue
            subfolder = img_meta.get("subfolder", "") or ""
            file_type = img_meta.get("type", "input") or "input"

            try:
                if file_type == "input":
                    base_dir = folder_paths.get_input_directory()
                elif file_type == "temp":
                    base_dir = folder_paths.get_temp_directory()
                else:
                    continue
                path = (
                    os.path.join(base_dir, subfolder, filename)
                    if subfolder
                    else os.path.join(base_dir, filename)
                )
                if not os.path.isfile(path):
                    continue

                img = Image.open(path)
                img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")
                arr = np.asarray(img, dtype=np.float32) / 255.0
                tensors.append(torch.from_numpy(arr).unsqueeze(0))  # (1, H, W, 3)
            except Exception:
                continue

        if not tensors:
            placeholder = torch.ones((1, 64, 64, 3))
            return io.NodeOutput(placeholder, [placeholder])

        max_h = max(t.shape[1] for t in tensors)
        max_w = max(t.shape[2] for t in tensors)

        padded: list[torch.Tensor] = []
        for t in tensors:
            _, h, w, _ = t.shape
            pad_top = (max_h - h) // 2
            pad_bottom = max_h - h - pad_top
            pad_left = (max_w - w) // 2
            pad_right = max_w - w - pad_left
            t_padded = F.pad(
                t,
                (0, 0, pad_left, pad_right, pad_top, pad_bottom),
                mode="constant",
                value=1.0,
            )
            padded.append(t_padded)

        # IMAGE: padded batch (back-compat with samplers/preview).
        # IMAGE_LIST: original tensors at native dimensions (for vision LLMs).
        return io.NodeOutput(torch.cat(padded, dim=0), tensors)
