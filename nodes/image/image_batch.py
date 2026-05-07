import torch
import torch.nn.functional as F

from comfy_api.latest import io


# Number of image input slots the node exposes. Each slot is optional —
# the user can connect any subset; unconnected slots are simply skipped.
NUM_SLOTS = 8


class NewflowImageBatch(io.ComfyNode):
    """Combines an arbitrary subset of images into a single IMAGE batch.

    Unlike the native Batch Images node (which fails when input dimensions
    differ), this node pads smaller images with white to match the largest
    H × W in the batch. Each image's aspect ratio is preserved — only padding
    is added; the image is never stretched or cropped.

    Inputs are fixed (image_1 … image_N), all optional. Connect any subset.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowImageBatch",
            display_name="Newflow Image Batch",
            category="newflow/image",
            description=(
                "Batches multiple images into one IMAGE output. Smaller images "
                "are padded with white to match the largest dimensions so each "
                "image keeps its original aspect ratio. All input slots are "
                "optional — connect any subset, skipped slots are ignored."
            ),
            inputs=[
                io.Image.Input(f"image_{i + 1}", optional=True)
                for i in range(NUM_SLOTS)
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Image.Output("IMAGE_LIST", is_output_list=True),
            ],
        )

    @classmethod
    def execute(cls, **kwargs):
        # Collect connected image tensors in slot order, skipping unconnected ones.
        flat: list[torch.Tensor] = []
        for i in range(NUM_SLOTS):
            tensor = kwargs.get(f"image_{i + 1}")
            if tensor is None:
                continue
            t = tensor
            if t.dim() == 3:
                t = t.unsqueeze(0)
            for j in range(t.shape[0]):
                flat.append(t[j : j + 1])

        if not flat:
            # Nothing wired in: return a 1×64×64 white placeholder so downstream
            # nodes don't crash on a zero-batch tensor.
            placeholder = torch.ones((1, 64, 64, 3))
            return io.NodeOutput(placeholder, [placeholder])

        max_h = max(t.shape[1] for t in flat)
        max_w = max(t.shape[2] for t in flat)
        max_c = max(t.shape[3] for t in flat)

        padded: list[torch.Tensor] = []
        for t in flat:
            _, h, w, c = t.shape

            # Match channel count (rare to differ, but cover the edge case).
            if c < max_c:
                extra = torch.full(
                    (1, h, w, max_c - c),
                    1.0,
                    dtype=t.dtype,
                    device=t.device,
                )
                t = torch.cat([t, extra], dim=-1)
            elif c > max_c:
                t = t[..., :max_c]

            pad_top = (max_h - h) // 2
            pad_bottom = max_h - h - pad_top
            pad_left = (max_w - w) // 2
            pad_right = max_w - w - pad_left

            # F.pad on (B, H, W, C): order is (C_left, C_right, W_left, W_right, H_left, H_right).
            t_padded = F.pad(
                t,
                (0, 0, pad_left, pad_right, pad_top, pad_bottom),
                mode="constant",
                value=1.0,
            )
            padded.append(t_padded)

        # IMAGE: padded batch (back-compat with samplers/preview).
        # IMAGE_LIST: original tensors at native dimensions (for vision LLMs).
        return io.NodeOutput(torch.cat(padded, dim=0), flat)
