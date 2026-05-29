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

### Prompt Composer

`NewflowPromptComposer` is a single mode-aware node (the former
`NewflowPromptComposerSimple` was merged into it). A plain `mode` Combo widget
switches behaviour; the USER/SYSTEM rich editors and the LLM Output editor are
**identical and shared across both modes** — there is only one set of editors,
so prompt content survives mode switches with no value/format mismatch.

- `Templated` (default) — `[[Key]]` substitution from the `OPTIONS` socket
  (wired from Newflow Dynamic Dropdowns), chip strip + slash-menu visible.
- `Plain` — the `OPTIONS` input socket is removed (via `removeInput`/`addInput`
  in [js/prompt_composer.js](js/prompt_composer.js)), the chip strip is hidden,
  and prompts are emitted verbatim (no substitution).

Mode only gates: the `OPTIONS` socket, the chip strip, and whether
`runGenerate` substitutes `[[Key]]` tokens (`ctx.isTemplated()`). Old
`NewflowPromptComposerSimple` workflows auto-migrate via `io.NodeReplace`
(registered in [__init__.py](__init__.py), sets `mode=Plain`) plus a JS
`beforeConfigureGraph` shim (`migrateLegacySimpleNode`) that reshapes the old
plain-text USER/SYSTEM widget values into the new
`user_prompt_state`/`system_prompt_state` JSON DOM-widget states.

Pre-merge `NewflowPromptComposer` nodes (same `node_id`, but saved before the
`mode` combo existed) are realigned by a second `beforeConfigureGraph` shim,
`realignLegacyComposerNode`. The merged node inserts `mode` as widget[0], so an
old node's saved `widgets_values` are shifted one slot — the USER prompt JSON
lands in the `mode` combo and the editors read empty. The shim can't shift
blindly (some nodes were re-saved half-migrated, leaving a duplicate empty USER
state), so it re-derives each editor's state by JSON shape — `settings` blob →
LLM, longest `displayMode` blob → USER, remaining bare `{text}` → SYSTEM — and
rebuilds the canonical `[mode, user, system, llm]` order with `mode=Templated`.
Nodes whose widget[0] is already `"Templated"`/`"Plain"` are left untouched.

Shared frontend helpers (`DEFAULT_LLM_SETTINGS`, `deserializeLlmState`,
`hasDownstreamConsumer`, `openLlmSettings`, `preloadImageCache`) are exported
from [js/prompt_composer.js](js/prompt_composer.js) and reused by
[js/skill_prompt.js](js/skill_prompt.js). The queue interceptor matches only
`NewflowPromptComposer`.

### Image Batch

`NewflowImageBatch` is a single node with **no mode switcher** (an earlier
two-mode Slots/Wardrobe design was dropped). It combines two image sources into
one batch:

- up to four `IMAGE_N` external sockets (autogrow: `IMAGE_1` shows first,
  `IMAGE_2` appears once `IMAGE_1` is wired, … capped at 4) for upstream image
  producers, prepended to the output in order;
- an arbitrary number of labeled **containers** with directly-uploaded images
  (drag-drop / file picker, per-card browsing, include toggle, remove,
  drag-reorder, **+ Add container**). All container state lives in a single
  `containers` JSON DOM widget read in Python from the prompt — it is **not** a
  schema input.

Outputs: `IMAGE` (white-padded batch, sampler/preview compatible) and
`IMAGE_LIST` (native resolutions, for vision LLMs). The pad/stack logic lives in
`pad_and_batch` ([nodes/image/_shared.py](nodes/image/_shared.py)).

Old `NewflowImageArray` (Clothing) workflows auto-migrate via `io.NodeReplace`
(registered in [__init__.py](__init__.py): plain rename + 1:1 `IMAGE_N`
sockets) plus a JS `beforeConfigureGraph` shim (`reshapeImageBatchWidgets` in
[js/image_batch.js](js/image_batch.js)). The shim collapses the old positional
`widgets_values` (which across builds held a `flatten_batches` boolean, a
`mode` string, per-slot `garment_N` filename strings, and a `garment_N→label`
map) down to the single `[containers]` slot the current node expects. It
classifies values by JSON shape (order-independent), reconstructing one
container per non-empty garment filename paired with its label, and is
idempotent on already-collapsed `[containers]` data.

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
