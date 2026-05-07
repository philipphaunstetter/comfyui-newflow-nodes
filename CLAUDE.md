# comfyui-newflow-nodes

A single ComfyUI custom-node package shipping multiple nodes under the `newflow/` namespace. Users install the whole repo into `ComfyUI/custom_nodes/comfyui-newflow-nodes/` and get all nodes at once.

## API: V3 only

This project uses the **V3 ComfyUI node API** (`io.ComfyNode`, `io.Schema`, `ComfyExtension`, `comfy_entrypoint()`). Do not use the legacy V1 style (`INPUT_TYPES`, `NODE_CLASS_MAPPINGS`, return tuples) for new code. If porting V1 code from elsewhere, migrate it before merging.

When writing or modifying nodes, consult the relevant skill:

- `/comfyui-node-basics` — V3 node structure, schema, inputs/outputs, registration
- `/comfyui-node-outputs` — `NodeOutput`, previews, saved files
- `/comfyui-node-advanced` — `MatchType`, `Autogrow`, `DynamicCombo`, node expansion, wildcards
- `/comfyui-node-frontend` — JS extensions, widgets, sidebar tabs, commands
- `/comfyui-node-packaging` — project layout, `__init__.py`, `pyproject.toml`, publishing
- `/comfyui-node-migration` — V1 → V3 conversion

## Project layout

```
comfyui-newflow-nodes/
├── __init__.py              # ComfyExtension + comfy_entrypoint(), exports WEB_DIRECTORY
├── pyproject.toml           # registry metadata ([tool.comfy])
├── requirements.txt         # only deps NOT shipped with ComfyUI
├── README.md
├── nodes/
│   ├── __init__.py          # assembles ALL_NODES from subpackages
│   ├── <feature>/
│   │   ├── __init__.py
│   │   └── *.py             # one file per node, or grouped by feature
│   └── ...
├── js/                      # all frontend extensions (single WEB_DIRECTORY)
└── docs/                    # optional per-node help pages
```

One package, many nodes. Group node files by feature/theme under `nodes/`, not one folder per node unless a node is large enough to warrant it.

## Conventions

- **Node IDs** (`node_id` in `Schema`): prefix with `Newflow` and keep globally unique, e.g. `NewflowImageUpscale`. These are stable identifiers — renaming breaks user workflows.
- **Display names**: human-readable, e.g. `"Newflow Image Upscale"`.
- **Categories**: always under `newflow/...` (e.g. `newflow/image`, `newflow/utils`, `newflow/io`) so all nodes group together in the menu.
- **Dependencies**: don't list packages shipped with ComfyUI (`torch`, `numpy`, `PIL`, `scipy`, `safetensors`, `transformers`, `accelerate`). Pin minimums, not exact versions.
- **No comments unless the *why* is non-obvious.** V3 schemas are self-documenting.

## Node-specific notes

### Prompt Composer variants

Two nodes share LLM streaming logic, settings, image-cache helpers, and the queue-interceptor auto-regen path:

- `NewflowPromptComposer` — rich variant with `[[Key]]` variable templating, chip strip, slash-menu, display modes.
- `NewflowPromptComposerSimple` — plain-text variant, no variables.

Shared frontend helpers (`DEFAULT_LLM_SETTINGS`, `deserializeLlmState`, `hasDownstreamConsumer`, `openLlmSettings`, `preloadImageCache`) are exported from [js/prompt_composer.js](js/prompt_composer.js) and imported by [js/prompt_composer_simple.js](js/prompt_composer_simple.js). The queue interceptor in `prompt_composer.js` matches both `comfyClass` values.

**When changing either node, check whether the other needs the same change**, especially for: LLM streaming, settings dialog, Generate/Auto/badge/status UI, image-cache logic, queue interceptor, persistence shape. The two `runGenerate`/badge implementations are partially duplicated; if drift becomes painful, extract a shared `js/llm_block.js` module.

## Local development

Symlink the repo into a local ComfyUI install instead of copying:

```bash
ln -s /Users/de01675/development/tools/comfyui-newflow-nodes \
      ~/ComfyUI/custom_nodes/comfyui-newflow-nodes
```

Restart ComfyUI to pick up Python changes. Frontend (`js/`) changes only need a browser refresh.

## Registration pattern

Root `__init__.py` aggregates every node class into one `ComfyExtension`:

```python
from typing_extensions import override
from comfy_api.latest import ComfyExtension, io

from .nodes import ALL_NODES  # list[type[io.ComfyNode]]

WEB_DIRECTORY = "./js"

class NewflowExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return ALL_NODES

async def comfy_entrypoint() -> NewflowExtension:
    return NewflowExtension()
```

`nodes/__init__.py` builds `ALL_NODES` from each subpackage so adding a new node = write the class + append to the list.

## Adding a new node — workflow

**Always plan before coding.** For every new node, produce a written plan first and get approval before implementation. No skipping straight to code, even for "small" nodes.

### Step 1 — Plan (required)

Write the plan as a short structured doc covering:

1. **Purpose** — one sentence: what the node does and why it exists.
2. **Node identity** — `node_id` (PascalCase, `Newflow`-prefixed), `display_name`, `category` (`newflow/...`).
3. **Inputs** — table of name, type (`io.Image`, `io.Float`, etc.), required vs optional, defaults, min/max, tooltip.
4. **Outputs** — list of output types and what each represents.
5. **Execution logic** — bullet steps of what `execute` will do (no code yet).
6. **Edge cases & validation** — empty inputs, type mismatches, invalid ranges, GPU/CPU concerns.
7. **Dependencies** — any new packages needed (and justify if not already in ComfyUI's stack).
8. **Frontend** — does it need custom JS? If yes, sketch the widget/behavior.
9. **File placement** — which `nodes/<feature>/` bucket, new file or existing.
10. **Test plan** — how the node will be verified in a workflow.

Keep it tight — plans are for clarity, not ceremony. A simple node fits in ~15 lines.

### Step 2 — Implement (only after plan is approved)

1. Create/locate the file under `nodes/<feature>/`.
2. Write the class (`io.ComfyNode` + `define_schema` + `@classmethod execute`) — see `/comfyui-node-basics`.
3. Append the class to `ALL_NODES` in `nodes/__init__.py`.
4. If UI is needed, add JS to `js/` — see `/comfyui-node-frontend`.
5. Restart ComfyUI, run through the test plan.
