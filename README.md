# comfyui-newflow-nodes

A collection of custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI), grouped under the `newflow/` category in the node menu.

## Install

Pick whichever method you have. After any of them: restart ComfyUI.

### A — Via ZIP (no git required)

1. Download `comfyui-newflow-nodes-<version>.zip`.
2. Unzip into your `ComfyUI/custom_nodes/` folder. You should end up with `ComfyUI/custom_nodes/comfyui-newflow-nodes/__init__.py`.
3. If `requirements.txt` is non-empty, run `pip install -r ComfyUI/custom_nodes/comfyui-newflow-nodes/requirements.txt`.

### Optional dependency: Ollama

The **Newflow Prompt Composer** node uses [Ollama](https://ollama.com) for its LLM Output feature. Other nodes work without it. Install Ollama, then:

```bash
ollama serve              # starts the API on localhost:11434
ollama pull llama3.2      # or any model you prefer
```

The node's URL field is configurable per-instance; defaults to `http://localhost:11434`.

### B — Via git (gets updates with `git pull`)

```bash
cd ComfyUI/custom_nodes
git clone <repo-url> comfyui-newflow-nodes
pip install -r comfyui-newflow-nodes/requirements.txt   # only if non-empty
```

To update later:
```bash
cd ComfyUI/custom_nodes/comfyui-newflow-nodes
git pull
```

### C — Via ComfyUI Manager

Paste the repo URL into Manager's "Install via Git URL" field. Manager then handles updates with its **Update** button.

## Local development

Symlink instead of cloning:

```bash
ln -s /path/to/comfyui-newflow-nodes ~/ComfyUI/custom_nodes/comfyui-newflow-nodes
```

## Nodes

| Node | Category | Description |
|---|---|---|
| **Newflow Dynamic Dropdowns** | `newflow/inputs` | A single node holding any number of user-configured dropdowns. Each row has a label and a comma-separated option list (edited via the row's `…` menu). Outputs a JSON string of `{label: selected_value}` — rows set to `(none)` are skipped. |
| **Newflow Image Batch** | `newflow/image` | Combines multiple images into a single IMAGE batch. Unlike the native Batch Images node, mismatched dimensions don't fail — smaller images are padded with white to match the largest H × W so each image keeps its original aspect ratio. Two outputs: `IMAGE` (padded batch, compatible with samplers/preview nodes) and `IMAGE_LIST` (native-resolution list, ideal for Composer's `images_list` input — vision LLMs see each image at full quality with no padding). |
| **Newflow Clothing** | `newflow/image` | A self-contained wardrobe node — add labeled containers (Top, Trousers, Shoes, Accessory #1, …), upload images directly via drag-drop or file picker (no separate Load Image nodes needed), drag the `≡` handle to reorder. Two outputs: `IMAGE` (padded batch, compatible with samplers/preview) and `IMAGE_LIST` (native-resolution, no-padding) for vision LLMs. Optional **SET CARD** input becomes Image 1 when connected. Pairs naturally with the Composer's `images_list` input. |
| **Newflow Array Split** | `newflow/utils` | Splits a STRING by a user-configured separator (default `*`) into a list of items. Output is a list of strings (`is_output_list=True`); empty/whitespace items dropped; falls back to newline split when the separator field is empty. Pair with **Newflow Array Pick**. Preview shows numbered items in the node body. |
| **Newflow Array Pick** | `newflow/utils` | Picks one item from a string array (e.g. the output of Newflow Array Split) by index. Index is clamped to a valid range. Schema uses `is_input_list=True` so the connected list flows through without auto-iteration. Preview shows the selected item. |
| **Newflow Human in the Loop** | `newflow/utils` | Pauses the workflow at this node and shows the input IMAGE in the node body with **Approve** (continue) and **Reject** (stop) buttons. Approve passes the image through to the output; Reject raises ComfyUI's standard interrupt exception. ComfyUI's global Cancel button is honored while waiting. Times out after 10 minutes. |
| **Newflow Prompt Composer** | `newflow/prompt` | Writes user-prompt and system-prompt templates with `[[Key]]` placeholders. Connect a variables JSON (e.g. from Dynamic Dropdowns) and use `/` to insert variables as inline pills. Missing keys render as red pills and substitute to `[MISSING: Key]`. A third **LLM Output** editor lets you fuse the two prompts through a local Ollama model — click Generate to stream the response, edit the result inline if needed, and the `prompt` output emits whatever's in the field. Two image inputs: `images` (padded IMAGE batch) and `images_list` (native-resolution IMAGE_LIST from Newflow Image Batch / Newflow Clothing) — both cached during workflow execution and forwarded to vision-capable models (llava, llama3.2-vision, gemma3-vision, …). Settings (URL, model, temperature, top-p, max tokens, num_ctx) per node. Optional **Auto-generate on workflow run** checkbox triggers regeneration when the global Run button is clicked, before the workflow submits. |

## Building a release ZIP

```bash
./scripts/build.sh
```

Reads version from `pyproject.toml`, writes `dist/comfyui-newflow-nodes-<version>.zip`. Bump the version in `pyproject.toml` before each release.

## License

MIT
