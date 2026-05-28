// Frontend for the merged NewflowImageBatch node.
//
// Slots mode needs no custom JS — eight fixed image_N sockets render with
// ComfyUI's default chrome. Wardrobe mode uses io.Autogrow with built-in
// `upload=image` combo widgets per slot (drag-drop + file picker handled by
// ComfyUI itself), plus a small "wardrobe_labels" sidecar widget we add here
// so users can name each garment ("Top", "Trousers", …).
//
// Also handles the legacy migration: old NewflowImageArray nodes in saved
// workflows are rewritten in `beforeConfigureGraph` so they load as the new
// NewflowImageBatch with mode=Wardrobe, with each `containers` entry expanded
// into a positional garment_N value and a wardrobe_labels JSON payload.

import { app } from "../../scripts/app.js";

const NODE_NAME = "NewflowImageBatch";
const LEGACY_NODE_NAME = "NewflowImageArray";
const LABELS_WIDGET = "wardrobe_labels";
const DEFAULT_LABELS = ["Top", "Trousers", "Shoes"];

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./image_array.css", import.meta.url).href;
document.head.appendChild(css);

// Capture-phase shield so typing in the label inputs doesn't trigger
// ComfyUI's global shortcuts.
const isInLabelInput = (target) =>
    target instanceof Element && target.closest(".newflow-wardrobe-label-input") != null;
["keydown", "keyup", "keypress", "copy", "cut", "paste"].forEach((evt) => {
    document.addEventListener(
        evt,
        (e) => {
            if (isInLabelInput(e.target)) e.stopPropagation();
        },
        true,
    );
});

function pickLabel(index, existingLabels) {
    if (index < DEFAULT_LABELS.length && !existingLabels.has(DEFAULT_LABELS[index])) {
        return DEFAULT_LABELS[index];
    }
    let n = 1;
    while (existingLabels.has(`Accessory #${n}`)) n++;
    return `Accessory #${n}`;
}

function parseLabels(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function findGarmentWidgets(node) {
    return (node.widgets || [])
        .filter((w) => typeof w?.name === "string" && /^garment_\d+$/.test(w.name))
        .sort((a, b) => {
            const ai = parseInt(a.name.slice("garment_".length), 10) || 0;
            const bi = parseInt(b.name.slice("garment_".length), 10) || 0;
            return ai - bi;
        });
}

function renderLabelsPanel(host, node, getLabels, setLabels) {
    const garments = findGarmentWidgets(node);
    host.replaceChildren();

    if (garments.length === 0) {
        const empty = document.createElement("div");
        empty.className = "newflow-wardrobe-empty";
        empty.textContent = "(no garment slots yet — use the + button below)";
        host.appendChild(empty);
        return;
    }

    const labels = getLabels();
    const used = new Set(Object.values(labels).filter((v) => typeof v === "string" && v));
    let touched = false;

    garments.forEach((w, i) => {
        if (!labels[w.name]) {
            const next = pickLabel(i, used);
            labels[w.name] = next;
            used.add(next);
            touched = true;
        }

        const row = document.createElement("div");
        row.className = "newflow-wardrobe-row";

        const slotTag = document.createElement("span");
        slotTag.className = "newflow-wardrobe-slot";
        slotTag.textContent = w.name;
        slotTag.title = "Autogrow slot id (used by Python)";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "newflow-wardrobe-label-input";
        input.value = labels[w.name] || "";
        input.placeholder = "Label";
        input.maxLength = 64;
        input.addEventListener("input", () => {
            const next = { ...getLabels(), [w.name]: input.value };
            setLabels(next);
        });

        row.append(slotTag, input);
        host.appendChild(row);
    });

    if (touched) {
        setLabels({ ...labels });
    }
}

// ---------------------------------------------------------------------------
// Legacy NewflowImageArray → NewflowImageBatch migration.
//
// NodeReplace (server-side, registered in __init__.py) can rename the class
// and remap simple inputs, but it can't expand one DOM widget (`containers`)
// into N positional widgets (`garment_0`, `garment_1`, …). We do that here
// so the saved-workflow load path Just Works.
//
// We also rewrite class_type to the new id so the workflow shows up correctly
// in the editor without the user having to queue it first.
// ---------------------------------------------------------------------------

function legacyMigrateContainers(rawContainers) {
    // rawContainers is the JSON string the old `containers` widget held.
    let arr;
    try {
        arr = typeof rawContainers === "string" ? JSON.parse(rawContainers) : rawContainers;
    } catch {
        return { garments: [], labels: {} };
    }
    if (!Array.isArray(arr)) return { garments: [], labels: {} };

    const garments = [];
    const labels = {};
    for (const c of arr) {
        if (!c || typeof c !== "object") continue;
        if (c.included === false) continue;
        const imagesMeta = Array.isArray(c.images) ? c.images : [];
        const idx = typeof c.currentIdx === "number"
            ? Math.max(0, Math.min(c.currentIdx, imagesMeta.length - 1))
            : 0;
        const sel = imagesMeta[idx];
        const filename = sel?.filename || c.filename;
        if (!filename) continue;
        const slotName = `garment_${garments.length}`;
        garments.push(filename);
        if (typeof c.label === "string" && c.label) {
            labels[slotName] = c.label;
        }
    }
    return { garments, labels };
}

function migrateLegacyNodeData(nodeData) {
    if (!nodeData || nodeData.type !== LEGACY_NODE_NAME) return;

    // widgets_values in the saved JSON is positional — for the legacy node
    // the only widget was `containers` (a single JSON string). Pull it out.
    const rawContainers = Array.isArray(nodeData.widgets_values)
        ? nodeData.widgets_values[0]
        : null;
    const { garments, labels } = legacyMigrateContainers(rawContainers);

    // Rewrite to the new node. mode comes first (DynamicCombo widget),
    // followed by each garment_N upload combo, followed by wardrobe_labels.
    nodeData.type = NODE_NAME;
    nodeData.comfyClass = NODE_NAME;
    nodeData.widgets_values = [
        "Wardrobe",
        ...garments,
        JSON.stringify(labels),
    ];
}

app.registerExtension({
    name: "newflow.image_batch",

    async beforeConfigureGraph(graphData) {
        if (!graphData || !Array.isArray(graphData.nodes)) return;
        for (const node of graphData.nodes) {
            migrateLegacyNodeData(node);
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            const node = this;

            // ---- wardrobe_labels DOM widget --------------------------------

            const host = document.createElement("div");
            host.className = "newflow-wardrobe-root";

            let labelState = {};
            let labelWidget = null;

            const getLabels = () => labelState;
            const setLabels = (next) => {
                labelState = next;
                if (labelWidget) labelWidget.value = JSON.stringify(labelState);
                node.setDirtyCanvas?.(true, true);
            };

            const refresh = () => {
                renderLabelsPanel(host, node, getLabels, setLabels);
            };

            labelWidget = node.addDOMWidget(LABELS_WIDGET, "newflow_wardrobe_labels", host, {
                serialize: true,
                getValue: () => JSON.stringify(labelState),
                setValue: (v) => {
                    labelState = parseLabels(v);
                    refresh();
                },
            });

            // ---- mode-aware visibility -------------------------------------

            const isWardrobe = () =>
                (node.widgets?.find((w) => w.name === "mode")?.value || "Slots")
                    === "Wardrobe";

            const applyVisibility = () => {
                host.style.display = isWardrobe() ? "" : "none";
                if (isWardrobe()) refresh();
                node.setDirtyCanvas?.(true, true);
            };

            // The labels host has no intrinsic height in Slots mode; keep it 0
            // so the node doesn't reserve dead vertical space.
            labelWidget.computeSize = (w) => [w, isWardrobe() ? host.offsetHeight || 80 : 0];

            const modeWidget = node.widgets?.find((w) => w.name === "mode");
            if (modeWidget) {
                const origCb = modeWidget.callback;
                modeWidget.callback = function () {
                    const r = origCb?.apply(this, arguments);
                    applyVisibility();
                    return r;
                };
            }

            // Re-render the label panel whenever Autogrow adds/removes slots.
            // Cheap to poll once a second; far simpler than hooking every
            // Autogrow lifecycle event individually.
            const poll = setInterval(() => {
                if (isWardrobe()) refresh();
            }, 1000);
            const origRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(poll);
                origRemoved?.apply(this, arguments);
            };

            applyVisibility();
        };
    },
});
