# Newflow Nodes for ComfyUI

> A toolkit of ComfyUI custom nodes for templated prompting, batched image inputs, and human-reviewable image pipelines.

All nodes live under the `newflow/` category in the ComfyUI node menu.

<!-- TODO: hero screenshot or GIF showing a workflow that uses Composer + Image Batch + Human in the Loop together -->

## Highlights

- **Prompt Composer** — rich-text USER/SYSTEM editors with `[[Key]]` templating, an Ollama-powered LLM Output editor, and vision-model image inputs.
- **Image Batch** — autogrowing `IMAGE_N` sockets plus labeled container uploads, with a padded batch output for samplers and a native-resolution list output for vision LLMs.
- **Dynamic Dropdowns** — a single node holding any number of user-configured dropdowns, feeding `[[Key]]` substitution in the Composer.
- **Utility nodes** — Array Split / Array Pick for working with delimited strings, and a Human in the Loop pause for approve/reject review.

## Requirements

- ComfyUI with the **V3 node API** (recent builds)
- Python 3.10+
- Optional: [Ollama](https://ollama.com) — required only for the Prompt Composer's LLM Output feature

## Install

After any method: **restart ComfyUI**.

### A — ComfyUI Manager (recommended)

Open Manager's **Install Custom Nodes** dialog and search for **Newflow**.

If the package isn't listed yet, use Manager's **Install via Git URL** field with:

```
https://github.com/philipphaunstetter/comfyui-newflow-nodes
```

Manager handles future updates via its **Update** button.

### B — Git

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/philipphaunstetter/comfyui-newflow-nodes
```

Update later with `git pull` from the cloned folder.

### C — Release ZIP

1. Download `comfyui-newflow-nodes-<version>.zip` from the [Releases page](https://github.com/philipphaunstetter/comfyui-newflow-nodes/releases).
2. Unzip into `ComfyUI/custom_nodes/`. You should end up with `ComfyUI/custom_nodes/comfyui-newflow-nodes/__init__.py`.

There are no Python dependencies to install — `requirements.txt` is empty by design (everything used is shipped with ComfyUI).

## LLM features (requires Ollama)

The **Newflow Prompt Composer** node's LLM Output feature streams from a local [Ollama](https://ollama.com) instance. All other nodes work without Ollama.

To enable it:

```bash
ollama serve              # starts the API on localhost:11434
ollama pull llama3.2      # or any model you prefer
```

The Composer's URL field is configurable per-instance and defaults to `http://localhost:11434`.

## Nodes

| Node | Category | What it does |
|---|---|---|
| **Newflow Prompt Composer** | `newflow/prompt` | Rich-text USER/SYSTEM prompt editors with optional `[[Key]]` templating and an Ollama LLM Output editor. |
| **Newflow Image Batch** | `newflow/image` | Combines autogrowing external `IMAGE_N` sockets with labeled directly-uploaded image containers into one batch. |
| **Newflow Dynamic Dropdowns** | `newflow/inputs` | Any number of user-configured dropdowns, emitted as a JSON `{label: value}` string for `[[Key]]` substitution. |
| **Newflow Human in the Loop** | `newflow/utils` | Pauses the workflow and shows the input IMAGE with Approve / Reject buttons. |
| **Newflow Array Split** | `newflow/utils` | Splits a STRING by a user-configured separator into a list of items. |
| **Newflow Array Pick** | `newflow/utils` | Picks one item from a string array by index (clamped). |

## Node reference

### Newflow Prompt Composer

<!-- TODO: screenshot of the Composer node with USER/SYSTEM/LLM editors and the chip strip -->

A single mode-aware node with a top-level **mode** combo. The same rich USER/SYSTEM editors are shared across both modes — content carries through mode switches.

- **Templated mode** (default) — supports `[[Key]]` placeholders with slash-menu insertion and draggable variable chips. Wire `OPTIONS` from a **Newflow Dynamic Dropdowns** node to provide values; missing keys render as red pills and substitute to `[MISSING: Key]`.
- **Plain mode** — hides the `OPTIONS` socket and chip strip; prompts are emitted verbatim.

Optional `USER` and `SYSTEM` input sockets accept upstream STRINGs that override the corresponding editor (the editor dims and locks). Both modes share:

- The **LLM Output** editor, streamed from a local Ollama model with a per-node settings dialog.
- Image inputs (`IMAGES` padded batch and `IMAGE_LIST` native-resolution list, typically wired from **Newflow Image Batch**) forwarded to vision-capable models.
- An **Auto-generate on workflow run** option that pre-runs Composers before queuing the rest of the graph.

### Newflow Image Batch

<!-- TODO: screenshot of Image Batch with a few IMAGE_N inputs wired and a container grid populated -->

Combines two image sources into a single batch:

- Up to **16 autogrowing `IMAGE_N` sockets** for upstream image producers. Only `IMAGE_1` shows initially; `IMAGE_2` appears once `IMAGE_1` is wired, and so on.
- A **container grid** of labeled cards with directly-uploaded images. Each card supports drag-drop / file picker, per-card image browsing, include toggle, remove, and drag-reorder. An **+ Add container** button appends new cards.

Outputs:

- `IMAGE` — a white-padded batch compatible with samplers and preview nodes.
- `IMAGE_LIST` — a native-resolution list, suitable for vision LLM inputs.
- Per-container `IMAGE1`, `IMAGE2`, … — each carrying just that container's selected image. The sockets autogrow to match the number of containers. A container's include toggle gates only the aggregate outputs; the per-container socket emits an empty 0-image batch when the container is excluded or has no image, so socket indices stay stable.

### Newflow Dynamic Dropdowns

<!-- TODO: screenshot of Dynamic Dropdowns with a few labeled rows configured -->

A single node holding any number of user-configured dropdown rows. Each row has a label and a comma-separated option list (edited via the row's `…` menu). Outputs a JSON string of `{label: selected_value}`. Rows set to `(none)` are skipped.

Typically wired into a **Prompt Composer** in Templated mode, where each label becomes a `[[Key]]` token.

### Newflow Human in the Loop

<!-- TODO: screenshot of the node displaying an image with Approve / Reject buttons -->

Pauses the workflow at this node and shows the input `IMAGE` in the node body with **Approve** (continue) and **Reject** (stop) buttons.

- Approve passes the image through to the output.
- Reject raises ComfyUI's standard interrupt exception.
- ComfyUI's global Cancel button is honored while waiting.
- Times out after 10 minutes.

### Newflow Array Split

<!-- TODO: screenshot of Array Split with its numbered preview -->

Splits a `STRING` by a user-configured separator (default `*`) into a list of items.

- Output is a list of strings (`is_output_list=True`).
- Empty / whitespace items are dropped.
- Falls back to newline split when the separator field is empty.
- Preview shows numbered items inside the node body.

Pair with **Newflow Array Pick**.

### Newflow Array Pick

<!-- TODO: screenshot of Array Pick selecting an item from a Split output -->

Picks one item from a string array (e.g. the output of **Newflow Array Split**) by index.

- Index is clamped to a valid range.
- Schema uses `is_input_list=True` so the connected list flows through without auto-iteration.
- Preview shows the selected item.

## Example workflows

<!-- TODO: ship a couple of example workflow JSONs under `examples/` and link them here, e.g.:
- `examples/templated-prompt.json` — Dynamic Dropdowns → Prompt Composer (Templated) → LLM Output
- `examples/image-batch-vision.json` — Image Batch → Prompt Composer with vision model
- `examples/review-loop.json` — generation → Human in the Loop → save
-->

Example workflows will be added here.

## Contributing

Issues and pull requests are welcome at [github.com/philipphaunstetter/comfyui-newflow-nodes](https://github.com/philipphaunstetter/comfyui-newflow-nodes).

When adding a new node, follow the workflow described in [CLAUDE.md](CLAUDE.md) — plan first, then implement.

## Releases

Maintainers can build a release ZIP with:

```bash
./scripts/build.sh
```

It reads the version from `pyproject.toml` and writes `dist/comfyui-newflow-nodes-<version>.zip`. Bump the version in `pyproject.toml` before each release.

## License

MIT © 2026 Newflow
