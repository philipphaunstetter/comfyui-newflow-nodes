import json
import os

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

import folder_paths
from comfy_api.latest import io


class NewflowImageArray(io.ComfyNode):
    WIDGET_NAME = "containers"
    IMAGE_INPUT_NAMES = ("IMAGE_1", "IMAGE_2", "IMAGE_3", "IMAGE_4")

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowImageArray",
            display_name="Newflow Image Array",
            category="newflow/image",
            description=(
                "A flexible image array. Up to four optional IMAGE inputs "
                "(IMAGE_1..IMAGE_4) prepend their first frame to the output "
                "when connected. Then an arbitrary number of labeled containers "
                "(images uploaded directly via drag-drop or file picker) follow. "
                "Outputs a padded IMAGE batch (samplers/preview compatible) and "
                "an IMAGE_LIST at native resolution (for vision LLMs)."
            ),
            inputs=[
                io.Image.Input("IMAGE_1", optional=True),
                io.Image.Input("IMAGE_2", optional=True),
                io.Image.Input("IMAGE_3", optional=True),
                io.Image.Input("IMAGE_4", optional=True),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Image.Output("IMAGE_LIST", is_output_list=True),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, IMAGE_1=None, IMAGE_2=None, IMAGE_3=None, IMAGE_4=None):
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

        # Prepend each connected IMAGE_N input in order — first frame only,
        # matching the original SET CARD semantics.
        for slot in (IMAGE_1, IMAGE_2, IMAGE_3, IMAGE_4):
            if slot is None:
                continue
            t = slot
            if t.dim() == 3:
                t = t.unsqueeze(0)
            if t.shape[0] >= 1:
                tensors.append(t[0:1])

        for c in containers:
            if not isinstance(c, dict):
                continue
            if c.get("included", True) is False:
                continue

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
                tensors.append(torch.from_numpy(arr).unsqueeze(0))
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

        return io.NodeOutput(torch.cat(padded, dim=0), tensors)
