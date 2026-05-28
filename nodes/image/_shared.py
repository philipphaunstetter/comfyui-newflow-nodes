"""Shared image helpers used by the image nodes."""

from __future__ import annotations

import torch
import torch.nn.functional as F


def pad_and_batch(
    tensors: list[torch.Tensor],
) -> tuple[torch.Tensor, list[torch.Tensor]]:
    """Pad a list of (B, H, W, C) tensors up to the largest (H, W, C) with
    white and stack them into a single batch tensor.

    Returns ``(batched, image_list)``:
    - ``batched`` — single tensor concatenated on dim 0, all frames padded to
      the same (max_h, max_w, max_c). Compatible with samplers/preview.
    - ``image_list`` — the original tensors at their native dimensions, in the
      same order. Suitable for vision LLMs that don't want padding artefacts.

    Empty input is the caller's problem — caller decides how to handle the
    "nothing wired in" case (typically by emitting a small white placeholder).
    """
    if not tensors:
        raise ValueError("pad_and_batch requires at least one tensor")

    # Normalise to 4D (B, H, W, C). Single-frame 3D tensors are tolerated.
    normalised: list[torch.Tensor] = []
    for t in tensors:
        if t.dim() == 3:
            t = t.unsqueeze(0)
        normalised.append(t)

    max_h = max(t.shape[1] for t in normalised)
    max_w = max(t.shape[2] for t in normalised)
    max_c = max(t.shape[3] for t in normalised)

    padded: list[torch.Tensor] = []
    for t in normalised:
        _, h, w, c = t.shape

        # Match channel count (rare to differ, but cover the edge case).
        if c < max_c:
            extra = torch.full(
                (t.shape[0], h, w, max_c - c),
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

    return torch.cat(padded, dim=0), normalised
