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
| **Newflow Image Batch** | `newflow/image` | One node, two modes via the top **mode** combo. *Slots* mode: 8 fixed optional IMAGE sockets for chaining upstream images (the original Image Batch behaviour). *Wardrobe* mode: 4 optional IMAGE sockets plus an Autogrow list of upload-per-slot garments — drag-drop files directly into each slot via ComfyUI's built-in upload widget; user-editable labels (Top, Trousers, …) live in a small sidecar panel. Both modes produce `IMAGE` (padded batch, samplers/preview compatible) and `IMAGE_LIST` (native-resolution list, for vision LLMs). Replaces the former *Newflow Clothing* / *Image Array* node — old workflows auto-migrate to Wardrobe mode. |
| **Newflow Array Split** | `newflow/utils` | Splits a STRING by a user-configured separator (default `*`) into a list of items. Output is a list of strings (`is_output_list=True`); empty/whitespace items dropped; falls back to newline split when the separator field is empty. Pair with **Newflow Array Pick**. Preview shows numbered items in the node body. |
| **Newflow Array Pick** | `newflow/utils` | Picks one item from a string array (e.g. the output of Newflow Array Split) by index. Index is clamped to a valid range. Schema uses `is_input_list=True` so the connected list flows through without auto-iteration. Preview shows the selected item. |
| **Newflow Human in the Loop** | `newflow/utils` | Pauses the workflow at this node and shows the input IMAGE in the node body with **Approve** (continue) and **Reject** (stop) buttons. Approve passes the image through to the output; Reject raises ComfyUI's standard interrupt exception. ComfyUI's global Cancel button is honored while waiting. Times out after 10 minutes. |
| **Newflow Prompt Composer** | `newflow/prompt` | One node, two modes via the top **mode** combo. *Templated* mode: rich user/system editors with `[[Key]]` placeholders, slash-menu insertion, draggable variable chips — wire OPTIONS from Dynamic Dropdowns; missing keys render as red pills and substitute to `[MISSING: Key]`. *Plain* mode: direct multiline USER and SYSTEM string fields, no substitution. Both modes share the **LLM Output** editor (streamed from a local Ollama model), settings dialog, image inputs (`IMAGES` padded batch + `IMAGE_LIST` native-resolution from Newflow Image Batch — both forwarded to vision models), and the **Auto-generate on workflow run** option that pre-runs Composers before queuing. Replaces the former *Newflow Prompt Composer (Simple)* — old workflows auto-migrate to Plain mode. |

## Building a release ZIP

```bash
./scripts/build.sh
```

Reads version from `pyproject.toml`, writes `dist/comfyui-newflow-nodes-<version>.zip`. Bump the version in `pyproject.toml` before each release.

## License

MIT
