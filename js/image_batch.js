// Frontend for the merged NewflowImageBatch node.
//
// Slots mode needs no custom JS — eight fixed image_N sockets render with
// ComfyUI's default chrome. Wardrobe mode has eight fixed garment_N Combo
// inputs with `upload=image` (drag-drop + file picker, the LoadImage
// pattern). We add a small "wardrobe_labels" sidecar so users can name
// each slot ("Top", "Trousers", …).
//
// Also handles the legacy migration: old NewflowImageArray nodes in saved
// workflows are rewritten in `beforeConfigureGraph` so they load as the new
// NewflowImageBatch with mode=Wardrobe, with each container's currently-
// selected image landing in garment_N and its label landing in
// wardrobe_labels.

import { app } from "../../scripts/app.js";

const NODE_NAME = "NewflowImageBatch";
const LEGACY_NODE_NAME = "NewflowImageArray";
const LABELS_WIDGET = "wardrobe_labels";
const NUM_GARMENT_SLOTS = 8;            // must match NUM_WARDROBE_SLOTS in Python
const DEFAULT_LABELS = ["Top", "Trousers", "Shoes"];

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./image_array.css", import.meta.url).href;
document.head.appendChild(css);

// Capture-phase shield so typing in label inputs doesn't trigger ComfyUI's
// global shortcuts.
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

function pickDefaultLabel(index, used) {
    if (index < DEFAULT_LABELS.length && !used.has(DEFAULT_LABELS[index])) {
        return DEFAULT_LABELS[index];
    }
    let n = 1;
    while (used.has(`Accessory #${n}`)) n++;
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

function renderLabelsPanel(host, node, getLabels, setLabels) {
    host.replaceChildren();
    const labels = getLabels();
    const used = new Set(Object.values(labels).filter((v) => typeof v === "string" && v));
    let touched = false;

    for (let i = 0; i < NUM_GARMENT_SLOTS; i++) {
        const slotName = `garment_${i + 1}`;
        if (!labels[slotName]) {
            const next = pickDefaultLabel(i, used);
            labels[slotName] = next;
            used.add(next);
            touched = true;
        }

        const row = document.createElement("div");
        row.className = "newflow-wardrobe-row";

        const tag = document.createElement("span");
        tag.className = "newflow-wardrobe-slot";
        tag.textContent = slotName;
        tag.title = "Slot id (used by Python; matches the upload widget below)";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "newflow-wardrobe-label-input";
        input.value = labels[slotName] || "";
        input.placeholder = "Label";
        input.maxLength = 64;
        input.addEventListener("input", () => {
            setLabels({ ...getLabels(), [slotName]: input.value });
        });

        row.append(tag, input);
        host.appendChild(row);
    }

    if (touched) setLabels({ ...labels });
}

// ---------------------------------------------------------------------------
// Legacy NewflowImageArray → NewflowImageBatch migration.
//
// NodeReplace (server-side, registered in __init__.py) renames the class and
// remaps the IMAGE_N sockets, but it can't expand the old `containers` JSON
// widget into N positional garment_N widgets. We do that here, before
// ComfyUI builds the node from the saved JSON.
// ---------------------------------------------------------------------------

function legacyMigrateContainers(rawContainers) {
    let arr;
    try {
        arr = typeof rawContainers === "string" ? JSON.parse(rawContainers) : rawContainers;
    } catch {
        return { garments: [], labels: {} };
    }
    if (!Array.isArray(arr)) return { garments: [], labels: {} };

    const garments = []; // filename per slot, up to NUM_GARMENT_SLOTS
    const labels = {};
    for (const c of arr) {
        if (!c || typeof c !== "object") continue;
        if (c.included === false) continue;
        if (garments.length >= NUM_GARMENT_SLOTS) break;
        const imagesMeta = Array.isArray(c.images) ? c.images : [];
        const idx = typeof c.currentIdx === "number"
            ? Math.max(0, Math.min(c.currentIdx, imagesMeta.length - 1))
            : 0;
        const sel = imagesMeta[idx];
        const filename = sel?.filename || c.filename || "";
        const slotName = `garment_${garments.length + 1}`;
        garments.push(filename);
        if (typeof c.label === "string" && c.label) {
            labels[slotName] = c.label;
        }
    }
    return { garments, labels };
}

function migrateLegacyNodeData(nodeData) {
    if (!nodeData || nodeData.type !== LEGACY_NODE_NAME) return;

    // widgets_values in the saved JSON is positional. For the legacy node the
    // only widget was `containers` (a single JSON string).
    const rawContainers = Array.isArray(nodeData.widgets_values)
        ? nodeData.widgets_values[0]
        : null;
    const { garments, labels } = legacyMigrateContainers(rawContainers);

    // Pad to exactly NUM_GARMENT_SLOTS so the positional widgets_values lines
    // up with the new schema's widget order: [mode, garment_1..N, labels].
    while (garments.length < NUM_GARMENT_SLOTS) garments.push("");

    // New widget order (positional, as serialized in workflow JSON):
    //   garment_1 .. garment_8   (8 Combo upload widgets)
    //   flatten_batches          (Boolean, default true)
    //   mode                     (Combo)
    //   wardrobe_labels          (DOM widget, added by JS — last)
    nodeData.type = NODE_NAME;
    nodeData.comfyClass = NODE_NAME;
    nodeData.widgets_values = [
        ...garments,
        true,
        "Wardrobe",
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
            // The schema is flat: image_N / IMAGE_N / garment_N / flatten_batches
            // all coexist always. The JS hides the irrelevant widgets per mode
            // (and the IMAGE_N / image_N input sockets too) so users only see
            // the controls that matter for the selected mode.

            const isWardrobe = () =>
                (node.widgets?.find((w) => w.name === "mode")?.value || "Slots")
                    === "Wardrobe";

            // Schema widgets to gate by mode. Image inputs aren't real
            // widgets (they're sockets) — we can't hide their sockets, but
            // we can hide their entry in the node's widget list when present.
            const garmentWidgets = (node.widgets || []).filter(
                (w) => /^garment_\d+$/.test(w?.name || ""),
            );
            const flattenWidget = node.widgets?.find((w) => w.name === "flatten_batches");

            const stash = (w) => {
                if (!w || w._newflowOrigComputeSize) return;
                w._newflowOrigComputeSize = w.computeSize;
                w._newflowOrigType = w.type;
            };
            const hide = (w) => {
                if (!w) return;
                w.computeSize = () => [0, -4];
                w.type = "hidden";
            };
            const show = (w) => {
                if (!w) return;
                w.computeSize = w._newflowOrigComputeSize;
                w.type = w._newflowOrigType;
            };
            garmentWidgets.forEach(stash);
            stash(flattenWidget);

            const applyVisibility = () => {
                const wardrobe = isWardrobe();
                // wardrobe_labels panel: only visible in Wardrobe.
                host.style.display = wardrobe ? "" : "none";
                if (wardrobe) refresh();
                // garment_N upload widgets: only visible in Wardrobe.
                garmentWidgets.forEach((w) => (wardrobe ? show(w) : hide(w)));
                // flatten_batches: only meaningful in Slots.
                if (wardrobe) hide(flattenWidget);
                else show(flattenWidget);
                if (Array.isArray(node.size)) {
                    node.setSize?.(node.computeSize?.() || node.size);
                }
                node.setDirtyCanvas?.(true, true);
            };

            // 0 height when Slots is selected so we don't reserve dead space.
            labelWidget.computeSize = (w) =>
                [w, isWardrobe() ? Math.max(host.offsetHeight, 24 * NUM_GARMENT_SLOTS + 16) : 0];

            const modeWidget = node.widgets?.find((w) => w.name === "mode");
            if (modeWidget) {
                const origCb = modeWidget.callback;
                modeWidget.callback = function () {
                    const r = origCb?.apply(this, arguments);
                    applyVisibility();
                    return r;
                };
            }

            applyVisibility();
        };
    },
});
