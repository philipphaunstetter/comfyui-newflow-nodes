from __future__ import annotations

import asyncio
import base64
import io as _io
import json
import logging
import os

import aiohttp
from aiohttp import web
from server import PromptServer

log = logging.getLogger(__name__)

DEFAULT_OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

# Module-level image cache for vision LLM support.
# Populated by NewflowPromptComposer.execute() when an `images` tensor is wired in.
# Keyed by node unique_id (string). Each value is a list of base64-PNG strings.
# Cleared when ComfyUI restarts. Bounded by INSTANCE_CACHE_LIMIT.
IMAGE_CACHE: dict[str, list[str]] = {}
INSTANCE_CACHE_LIMIT = 64  # max distinct node unique_ids retained


def cache_images(unique_id: str, b64_pngs: list[str]) -> None:
    """Store base64 PNG list for a Composer node. Evicts oldest if over limit."""
    if not unique_id:
        return
    IMAGE_CACHE[str(unique_id)] = list(b64_pngs)
    while len(IMAGE_CACHE) > INSTANCE_CACHE_LIMIT:
        # FIFO eviction; dict preserves insertion order in modern Python.
        IMAGE_CACHE.pop(next(iter(IMAGE_CACHE)))


def _single_tensor_to_b64_pngs(tensor) -> list[str]:
    """Convert a (B, H, W, C) torch tensor in 0-1 range to base64 PNGs (one per batch frame)."""
    if tensor is None:
        return []
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
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
    out: list[str] = []
    for img_arr in arr:
        if img_arr.shape[-1] == 1:
            img = Image.fromarray(img_arr[..., 0], mode="L")
        else:
            img = Image.fromarray(img_arr)
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        out.append(base64.b64encode(buf.getvalue()).decode("ascii"))
    return out


def tensor_to_b64_pngs(images) -> list[str]:
    """Convert images to a list of base64 PNGs.

    Accepts either:
    - A single tensor (B, H, W, C) — iterates the batch dim, one PNG per frame.
    - A list of tensors — iterates the list, then each tensor's batch dim.
      Each list element keeps its own native dimensions (no padding required).
    - None — returns [].
    """
    if images is None:
        return []
    if isinstance(images, list):
        out: list[str] = []
        for t in images:
            if t is None:
                continue
            out.extend(_single_tensor_to_b64_pngs(t))
        return out
    return _single_tensor_to_b64_pngs(images)


def _resolve_url(url: str | None) -> str:
    if url and url.strip():
        return url.strip().rstrip("/")
    return DEFAULT_OLLAMA_URL.rstrip("/")


@PromptServer.instance.routes.post("/newflow/llm/cache_files")
async def newflow_llm_cache_files(request: web.Request) -> web.Response:
    """Just-in-time cache populator. Receives a list of {filename, subfolder, type}
    file references, loads each from the appropriate ComfyUI directory, and stores
    the base64 PNGs in IMAGE_CACHE keyed by node_id.

    Used by the Composer's Generate flow to load images BEFORE calling Ollama,
    so the user doesn't need to run the workflow first.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    node_id = str(body.get("node_id", ""))
    files = body.get("files", [])
    if not node_id:
        return web.json_response({"error": "node_id required"}, status=400)
    if not isinstance(files, list):
        return web.json_response({"error": "files must be an array"}, status=400)

    try:
        import folder_paths
        from PIL import Image, ImageOps
    except ImportError as e:
        return web.json_response({"error": f"missing dependency: {e}"}, status=500)

    pngs: list[str] = []
    skipped: list[str] = []
    for f in files:
        if not isinstance(f, dict):
            continue
        filename = f.get("filename")
        if not filename:
            continue
        subfolder = f.get("subfolder", "") or ""
        file_type = f.get("type", "input") or "input"
        try:
            if file_type == "input":
                base_dir = folder_paths.get_input_directory()
            elif file_type == "temp":
                base_dir = folder_paths.get_temp_directory()
            elif file_type == "output":
                base_dir = folder_paths.get_output_directory()
            else:
                skipped.append(f"{filename} (unknown type {file_type})")
                continue
            path = (
                os.path.join(base_dir, subfolder, filename)
                if subfolder
                else os.path.join(base_dir, filename)
            )
            if not os.path.isfile(path):
                skipped.append(f"{filename} (not found at {path})")
                continue

            img = Image.open(path)
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
            buf = _io.BytesIO()
            img.save(buf, format="PNG")
            pngs.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        except Exception as e:
            skipped.append(f"{filename} ({e})")
            continue

    cache_images(node_id, pngs)
    return web.json_response({
        "node_id": node_id,
        "cached": len(pngs),
        "skipped": skipped,
    })


@PromptServer.instance.routes.get("/newflow/llm/images_count")
async def newflow_llm_images_count(request: web.Request) -> web.Response:
    """Returns how many images are cached for a given Composer node id.
    Used by the frontend to show a small "🖼 N" indicator in the LLM head row.

    Also returns `all_keys` so the UI / a developer can see WHICH node ids
    have populated cache entries — useful for diagnosing key mismatches.
    """
    node_id = request.query.get("node_id", "")
    count = len(IMAGE_CACHE.get(str(node_id), []) or [])
    return web.json_response({
        "node_id": str(node_id),
        "count": count,
        "all_keys": [{"id": k, "count": len(v or [])} for k, v in IMAGE_CACHE.items()],
    })


@PromptServer.instance.routes.get("/newflow/llm/healthz")
async def newflow_llm_healthz(request: web.Request) -> web.Response:
    url = _resolve_url(request.query.get("url"))
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=4)) as s:
            async with s.get(f"{url}/api/version") as r:
                if r.status == 200:
                    data = await r.json()
                    return web.json_response(
                        {"ok": True, "url": url, "version": data.get("version", "?")}
                    )
                return web.json_response(
                    {"ok": False, "url": url, "error": f"HTTP {r.status}"},
                    status=502,
                )
    except Exception as e:
        return web.json_response(
            {"ok": False, "url": url, "error": str(e)}, status=502
        )


@PromptServer.instance.routes.get("/newflow/llm/models")
async def newflow_llm_models(request: web.Request) -> web.Response:
    url = _resolve_url(request.query.get("url"))
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
            async with s.get(f"{url}/api/tags") as r:
                if r.status != 200:
                    return web.json_response(
                        {"url": url, "models": [], "error": f"HTTP {r.status}"},
                        status=502,
                    )
                data = await r.json()
                return web.json_response(
                    {"url": url, "models": data.get("models", [])}
                )
    except Exception as e:
        return web.json_response(
            {"url": url, "models": [], "error": str(e)}, status=502
        )


@PromptServer.instance.routes.post("/newflow/llm/generate")
async def newflow_llm_generate(request: web.Request) -> web.StreamResponse:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    model = body.get("model")
    user = body.get("user", "")
    system = body.get("system", "")
    options = body.get("options", {}) or {}
    url = _resolve_url(body.get("ollama_url"))

    if not model or not isinstance(model, str):
        return web.json_response({"error": "model is required"}, status=400)

    node_id = body.get("node_id")
    images = []
    if node_id is not None:
        images = IMAGE_CACHE.get(str(node_id), []) or []

    messages = []
    if isinstance(system, str) and system.strip():
        messages.append({"role": "system", "content": system})

    user_msg: dict = {"role": "user", "content": user or ""}
    if images:
        user_msg["images"] = images
    messages.append(user_msg)

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": options,
    }

    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
    await response.prepare(request)

    async def _write_line(obj: dict) -> None:
        try:
            await response.write((json.dumps(obj) + "\n").encode("utf-8"))
        except (ConnectionResetError, asyncio.CancelledError):
            pass

    # Preload the model with a bounded timeout so big models (which may take
    # minutes to fault into VRAM on first use) get a distinct "loading" phase
    # instead of tripping the chat stream's sock_read timeout mid-load.
    # Forward `options` (esp. num_ctx) so the preload exercises the same
    # memory footprint as the upcoming chat call — otherwise Ollama loads
    # with the model's native context, which for long-context models can be
    # 2M+ tokens and blow past available memory.
    await _write_line({"newflow_status": "loading model"})
    preload_payload = {
        "model": model,
        "prompt": "",
        "stream": False,
        "options": options,
    }
    try:
        preload_timeout = aiohttp.ClientTimeout(total=900)
        async with aiohttp.ClientSession(timeout=preload_timeout) as s:
            async with s.post(
                f"{url}/api/generate",
                json=preload_payload,
            ) as r:
                if r.status != 200:
                    err_text = await r.text()
                    await _write_line({
                        "error": f"Model preload failed (HTTP {r.status})",
                        "detail": err_text[:500],
                    })
                    await response.write_eof()
                    return response
                await r.read()
    except aiohttp.ClientConnectorError as e:
        await _write_line({
            "error": f"Cannot reach Ollama at {url}",
            "detail": str(e),
        })
        await response.write_eof()
        return response
    except asyncio.TimeoutError:
        await _write_line({
            "error": "Model preload timed out after 900s",
            "detail": f"model={model}",
        })
        await response.write_eof()
        return response
    except Exception as e:
        log.exception("newflow_llm_generate preload failed")
        await _write_line({"error": "Model preload failed", "detail": str(e)})
        await response.write_eof()
        return response

    await _write_line({"newflow_status": "streaming"})

    try:
        timeout = aiohttp.ClientTimeout(total=None, sock_read=600)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(f"{url}/api/chat", json=payload) as r:
                if r.status != 200:
                    err_text = await r.text()
                    err = json.dumps(
                        {"error": f"Ollama HTTP {r.status}", "detail": err_text[:500]}
                    ) + "\n"
                    await response.write(err.encode("utf-8"))
                    await response.write_eof()
                    return response
                async for line in r.content:
                    if not line:
                        continue
                    try:
                        await response.write(line)
                    except (ConnectionResetError, asyncio.CancelledError):
                        break
                await response.write_eof()
    except aiohttp.ClientConnectorError as e:
        try:
            err = json.dumps(
                {"error": f"Cannot reach Ollama at {url}", "detail": str(e)}
            ) + "\n"
            await response.write(err.encode("utf-8"))
            await response.write_eof()
        except Exception:
            pass
    except Exception as e:
        log.exception("newflow_llm_generate failed")
        try:
            err = json.dumps({"error": "Generation failed", "detail": str(e)}) + "\n"
            await response.write(err.encode("utf-8"))
            await response.write_eof()
        except Exception:
            pass

    return response
