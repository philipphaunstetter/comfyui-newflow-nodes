import { app } from "../../scripts/app.js";
import { installPersistence } from "./_persistence.js";

const NODE_NAME = "NewflowPromptComposer";
const USER_WIDGET = "user_prompt_state";
const SYSTEM_WIDGET = "system_prompt_state";
const LLM_WIDGET = "llm_output_state";
const TOKEN_RE = /\[\[\s*([^\[\]]+?)\s*\]\]/g;
const MIN_WIDTH = 640;

// Fixed widget heights drive the minimum node height.
const FIXED_USER_WIDGET_H = 220;
const FIXED_SYSTEM_WIDGET_H = 200;
const FIXED_LLM_WIDGET_H = 250;
const NODE_CHROME_H = 120; // title bar + ports + badge + paddings (approx)
const MIN_HEIGHT =
    FIXED_USER_WIDGET_H + FIXED_SYSTEM_WIDGET_H + FIXED_LLM_WIDGET_H + NODE_CHROME_H;

export const DEFAULT_LLM_SETTINGS = {
    ollama_url: "http://localhost:11434",
    model: "",
    temperature: 0.7,
    max_tokens: 4096,
    top_p: 0.9,
    num_ctx: 8192,
    auto_regen: false,
    auto_run_after_gen: true,
};

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./prompt_composer.css", import.meta.url).href;
document.head.appendChild(css);

// Install a single document-level capture-phase shield so ComfyUI's global
// shortcuts (which also listen with capture=true) don't fire when the user is
// typing inside one of our editors. Capture phase is the only level that beats
// other capture-phase listeners that were registered later.
const isInNewflowEditor = (target) =>
    target instanceof Element && target.closest(".newflow-pc-editor") != null;

["keydown", "keyup", "keypress", "copy", "cut", "paste"].forEach((evt) => {
    document.addEventListener(
        evt,
        (e) => {
            if (isInNewflowEditor(e.target)) e.stopPropagation();
        },
        true,
    );
});

// ---------------------------------------------------------------------------
// queuePrompt interceptor — pre-runs auto-regen composers before queueing the
// workflow. If any composer's generation fails, the run is cancelled.
// ---------------------------------------------------------------------------
{
    const origQueue = app.queuePrompt?.bind(app);
    if (typeof origQueue === "function") {
        app.queuePrompt = async function (number, batchCount) {
            // mode === 2 (NEVER / mute) and mode === 4 (BYPASS) skip execution;
            // honor that here so bypassed/muted Composers don't auto-regen.
            const composers = (app.graph?._nodes || []).filter(
                (n) =>
                    (n.comfyClass === "NewflowPromptComposer"
                        || n.comfyClass === "NewflowPromptComposerSimple")
                    && n._newflowIsAutoRegen?.()
                    && n.mode !== 2
                    && n.mode !== 4
            );
            if (composers.length === 0) {
                return origQueue(number, batchCount);
            }

            // Topological sort: a composer that consumes another auto-regen
            // composer's output must run AFTER its upstream finishes — otherwise
            // the downstream LLM call sees stale (or empty) input. Independent
            // composers still run in dependency-respecting order; only chained
            // ones are forced to be sequential.
            const composerSet = new Set(composers);
            const depsOf = new Map();
            for (const c of composers) {
                const deps = new Set();
                const inputs = c.inputs || [];
                for (let i = 0; i < inputs.length; i++) {
                    const upstream = c.getInputNode?.(i);
                    if (upstream && composerSet.has(upstream) && upstream !== c) {
                        deps.add(upstream);
                    }
                }
                depsOf.set(c, deps);
            }
            const sorted = [];
            const remaining = new Set(composers);
            while (remaining.size > 0) {
                let progressed = false;
                for (const c of remaining) {
                    const unmet = [...depsOf.get(c)].some((d) => remaining.has(d));
                    if (!unmet) {
                        sorted.push(c);
                        remaining.delete(c);
                        progressed = true;
                    }
                }
                if (!progressed) {
                    // Cycle detected — fall back to original order so we don't deadlock.
                    sorted.push(...remaining);
                    remaining.clear();
                }
            }

            try {
                for (const n of sorted) {
                    markComposerRunning(n);
                    try {
                        await n._newflowRunGenerate?.();
                    } finally {
                        clearComposerRunning(n);
                    }
                }
            } catch (err) {
                // Abort any in-flight generations from sibling composers.
                composers.forEach((n) => {
                    try { n._newflowAbortGenerate?.(); } catch {}
                });
                const title = err?.nodeTitle || "Newflow Prompt Composer";
                const detail = err?.message || "unknown error";
                if (app.extensionManager?.toast?.add) {
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Workflow cancelled",
                        detail: `Generation failed for "${title}" — ${detail}.`,
                        life: 6000,
                    });
                } else {
                    alert(`Workflow cancelled\nGeneration failed for "${title}" — ${detail}.`);
                }
                return; // do NOT call origQueue
            }
            return origQueue(number, batchCount);
        };
    }
}

const DISPLAY_MODES = [
    { value: "source",      label: "Source" },
    { value: "sourceValue", label: "Source + Value" },
    { value: "valueOnly",   label: "Value only" },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const escHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

// ---------------------------------------------------------------------------
// JIT image cache populator — walks upstream IMAGE sources and collects
// filenames so the Composer's Generate flow can populate IMAGE_CACHE BEFORE
// calling Ollama. This way the user doesn't have to run the workflow first.
// Supports LoadImage, NewflowImageArray, and NewflowImageBatch as sources. For
// other node types we can't introspect, so we just skip them and the user
// falls back to "run the workflow once".
// ---------------------------------------------------------------------------

const COMPOSER_IMAGE_SLOTS = ["IMAGES", "IMAGE_LIST"];

function _collectFromNode(node, refs, seen) {
    if (!node || seen.has(node)) return;
    seen.add(node);

    const klass = node.comfyClass;

    if (klass === "LoadImage") {
        const w = node.widgets?.find((w) => w.name === "image");
        if (w?.value) {
            refs.push({ filename: String(w.value), subfolder: "", type: "input" });
        }
        return;
    }

    if (klass === "NewflowImageArray") {
        const w = node.widgets?.find((w) => w.name === "containers");
        if (!w?.value) return;
        let containers;
        try { containers = JSON.parse(w.value); } catch { return; }
        if (!Array.isArray(containers)) return;

        // Mirror the Python execute order: each connected IMAGE_N slot in
        // order, then each included container's currently-selected image.
        for (const slotName of ["IMAGE_1", "IMAGE_2", "IMAGE_3", "IMAGE_4"]) {
            const slotIdx = (node.inputs || []).findIndex((i) => i.name === slotName);
            if (slotIdx < 0) continue;
            const upstream = node.getInputNode?.(slotIdx);
            if (upstream) _collectFromNode(upstream, refs, seen);
        }

        for (const c of containers) {
            if (!c || c.included === false) continue;
            const images = Array.isArray(c.images) ? c.images : [];
            if (images.length === 0) continue;
            const idx = typeof c.currentIdx === "number" ? c.currentIdx : 0;
            const safe = Math.max(0, Math.min(idx, images.length - 1));
            const img = images[safe];
            if (img?.filename) {
                refs.push({
                    filename: String(img.filename),
                    subfolder: img.subfolder || "",
                    type: img.type || "input",
                });
            }
        }
        return;
    }

    if (klass === "NewflowImageBatch") {
        // Recurse into every connected image_N slot, in order.
        const inputs = node.inputs || [];
        for (let i = 0; i < inputs.length; i++) {
            if (!inputs[i] || !inputs[i].name?.startsWith("image_")) continue;
            const upstream = node.getInputNode?.(i);
            if (upstream) _collectFromNode(upstream, refs, seen);
        }
        return;
    }

    // Other node types — can't introspect from JS without running them.
    // Caller will see fewer images cached than expected and the workflow
    // will need to run to fill in the rest.
}

function collectImageFileRefs(composerNode) {
    const refs = [];
    const seen = new Set();
    for (const slotName of COMPOSER_IMAGE_SLOTS) {
        const slotIdx = (composerNode.inputs || []).findIndex((i) => i.name === slotName);
        if (slotIdx < 0) continue;
        const upstream = composerNode.getInputNode?.(slotIdx);
        if (upstream) _collectFromNode(upstream, refs, seen);
    }
    return refs;
}

export async function preloadImageCache(composerNode, { signal } = {}) {
    const refs = collectImageFileRefs(composerNode);
    if (refs.length === 0) return { cached: 0, skipped: [] };
    const resp = await fetch("/newflow/llm/cache_files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            node_id: String(composerNode.id),
            files: refs,
        }),
        signal,
    });
    if (!resp.ok) {
        throw new Error(`Image preload failed (HTTP ${resp.status})`);
    }
    return await resp.json();
}

// Resolve a STRING input's upstream value at JS Generate time. The auto-regen
// queue interceptor topo-sorts composers so by the time we read here, an
// upstream composer's LLM widget already holds its freshly generated text. We
// recognize Newflow Composer outputs explicitly and fall back to a generic
// string-widget lookup for arbitrary upstream nodes. Returns null if nothing
// resolvable is connected.
export function readUpstreamStringForGenerate(node, inputName) {
    const slotIdx = (node.inputs || []).findIndex((i) => i.name === inputName);
    if (slotIdx < 0) return null;
    const inp = node.inputs[slotIdx];
    if (!inp || inp.link == null) return null;
    const link = node.graph?.links?.[inp.link];
    if (!link) return null;
    const src = node.graph.getNodeById(link.origin_id);
    if (!src) return null;
    const outName = src.outputs?.[link.origin_slot]?.name;

    const readDomState = (widgetName) => {
        const w = src.widgets?.find((x) => x.name === widgetName);
        if (!w || typeof w.value !== "string") return null;
        try {
            const parsed = JSON.parse(w.value);
            if (parsed && typeof parsed === "object") return String(parsed.text ?? "");
        } catch { /* not JSON state */ }
        return w.value;
    };

    if (src.comfyClass === "NewflowPromptComposer" && outName) {
        const map = { USER: "user_prompt_state", SYSTEM: "system_prompt_state", OUTPUT: "llm_output_state" };
        const widgetName = map[outName];
        if (widgetName) {
            const v = readDomState(widgetName);
            if (v != null) return v;
        }
    }

    if (src.comfyClass === "NewflowPromptComposerSimple" && outName) {
        if (outName === "OUTPUT") {
            const v = readDomState("llm_output_state");
            if (v != null) return v;
        }
        if (outName === "USER" || outName === "SYSTEM") {
            const w = src.widgets?.find((x) => x.name === outName);
            if (typeof w?.value === "string") return w.value;
        }
    }

    if (outName) {
        const w = src.widgets?.find((x) => x.name === outName);
        if (w && typeof w.value === "string") return w.value;
    }
    return null;
}

// Visual "this composer is currently generating" indicator. The auto-regen
// runs in JS before the workflow queue starts, so ComfyUI's built-in running-
// node halo never fires for these phases. The native indicator (`app.running
// NodeId`) is a read-only getter in modern ComfyUI Desktop, so we approximate
// the effect by tinting the node ourselves and forcing a canvas redraw.
const RUNNING_BGCOLOR = "#1e3a8a";  // deep blue body
const RUNNING_COLOR = "#3b82f6";    // brighter blue title bar

export function markComposerRunning(node) {
    if (!node || node._newflowRunningSnap) return;
    node._newflowRunningSnap = { bgcolor: node.bgcolor, color: node.color };
    node.bgcolor = RUNNING_BGCOLOR;
    node.color = RUNNING_COLOR;
    node.setDirtyCanvas?.(true, true);
}

export function clearComposerRunning(node) {
    if (!node || !node._newflowRunningSnap) return;
    node.bgcolor = node._newflowRunningSnap.bgcolor;
    node.color = node._newflowRunningSnap.color;
    delete node._newflowRunningSnap;
    node.setDirtyCanvas?.(true, true);
}

export function hasDownstreamConsumer(node) {
    for (const out of node.outputs || []) {
        if (out.links && out.links.length > 0) return true;
    }
    return false;
}

// Mirrors Python `_substitute` so the LLM sees the same text the workflow run will.
function resolveTextForLlm(text, valuesMap) {
    return String(text || "").replace(TOKEN_RE, (_, key) => {
        const k = key.trim();
        return Object.prototype.hasOwnProperty.call(valuesMap || {}, k)
            ? String(valuesMap[k])
            : `[MISSING: ${k}]`;
    });
}

export function deserializeLlmState(v) {
    let parsed;
    if (v && typeof v === "object" && !Array.isArray(v)) parsed = v;
    else if (!v) parsed = {};
    else {
        try { parsed = JSON.parse(v); } catch { parsed = { text: String(v) }; }
    }
    if (!parsed || typeof parsed !== "object") parsed = {};
    return {
        text: typeof parsed.text === "string" ? parsed.text : "",
        settings: {
            ...DEFAULT_LLM_SETTINGS,
            ...(parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {}),
        },
    };
}

const serializeState = (state) => JSON.stringify(state);
const deserializeState = (v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) return { text: "", displayMode: "source", ...v };
    if (!v) return { text: "", displayMode: "source" };
    if (typeof v === "string") {
        try {
            const parsed = JSON.parse(v);
            if (parsed && typeof parsed === "object") return { text: "", displayMode: "source", ...parsed };
            return { text: String(v), displayMode: "source" };
        } catch {
            return { text: String(v), displayMode: "source" };
        }
    }
    return { text: "", displayMode: "source" };
};

function tokenize(text) {
    const out = [];
    let last = 0;
    text.replace(TOKEN_RE, (m, key, idx) => {
        if (idx > last) out.push({ type: "text", value: text.slice(last, idx) });
        out.push({ type: "pill", key: key.trim() });
        last = idx + m.length;
        return m;
    });
    if (last < text.length) out.push({ type: "text", value: text.slice(last) });
    return out;
}

function makePill(key, knownKeys, displayMode, valuesMap) {
    const pill = document.createElement("span");
    pill.className = "newflow-pc-pill";
    pill.contentEditable = "false";
    pill.dataset.key = key;

    const upstreamKnown = Array.isArray(knownKeys);
    const isMissing = upstreamKnown && !knownKeys.includes(key);
    if (isMissing) pill.classList.add("newflow-pc-pill-missing");

    const val = valuesMap?.[key];
    let label;
    if (isMissing) {
        if (displayMode === "valueOnly") label = "[MISSING]";
        else label = `${key} (missing)`;
        pill.title = `Not present in upstream variables — output will be [MISSING: ${key}]`;
    } else {
        if (displayMode === "valueOnly") label = val != null && val !== "" ? String(val) : key;
        else if (displayMode === "sourceValue") label = val != null && val !== "" ? `${key}: ${val}` : key;
        else label = key;
        pill.title = val != null && val !== "" ? `${key} = ${val}` : key;
    }
    pill.textContent = label;
    return pill;
}

function renderEditorFromText(editor, text, knownKeys, displayMode, valuesMap) {
    editor.replaceChildren();
    for (const tok of tokenize(text)) {
        if (tok.type === "text") {
            // Preserve newlines as <br>; preserve runs of text.
            const parts = tok.value.split("\n");
            parts.forEach((part, i) => {
                if (part) editor.appendChild(document.createTextNode(part));
                if (i < parts.length - 1) editor.appendChild(document.createElement("br"));
            });
        } else {
            editor.appendChild(makePill(tok.key, knownKeys, displayMode, valuesMap));
        }
    }
}

function serializeEditorToText(editor) {
    let out = "";
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                out += child.textContent;
            } else if (child.nodeName === "BR") {
                out += "\n";
            } else if (child.classList?.contains("newflow-pc-pill")) {
                out += `[[${child.dataset.key}]]`;
            } else {
                walk(child);
            }
        }
    };
    walk(editor);
    return out;
}

// Re-render existing pills' label/missing-state without rebuilding the DOM
// (preserves cursor + selection). Use this on lazy upstream refresh.
function refreshPillsInPlace(editor, knownKeys, displayMode, valuesMap) {
    const pills = editor.querySelectorAll(".newflow-pc-pill");
    const upstreamKnown = Array.isArray(knownKeys);
    pills.forEach((pill) => {
        const key = pill.dataset.key;
        const isMissing = upstreamKnown && !knownKeys.includes(key);
        pill.classList.toggle("newflow-pc-pill-missing", isMissing);
        const val = valuesMap?.[key];
        let label;
        if (isMissing) {
            label = displayMode === "valueOnly" ? "[MISSING]" : `${key} (missing)`;
            pill.title = `Not present in upstream variables — output will be [MISSING: ${key}]`;
        } else {
            if (displayMode === "valueOnly") label = val != null && val !== "" ? String(val) : key;
            else if (displayMode === "sourceValue") label = val != null && val !== "" ? `${key}: ${val}` : key;
            else label = key;
            pill.title = val != null && val !== "" ? `${key} = ${val}` : key;
        }
        pill.textContent = label;
    });
}

// Convert any literal [[Key]] in text nodes to pills (called on blur).
function scanAndConvert(editor, knownKeys, displayMode, valuesMap) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
        if (TOKEN_RE.test(walker.currentNode.textContent)) {
            TOKEN_RE.lastIndex = 0;
            targets.push(walker.currentNode);
        }
    }
    if (!targets.length) return false;

    for (const tn of targets) {
        const text = tn.textContent;
        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        TOKEN_RE.lastIndex = 0;
        while ((m = TOKEN_RE.exec(text)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            frag.appendChild(makePill(m[1].trim(), knownKeys, displayMode, valuesMap));
            last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
    }
    return true;
}

// ---------------------------------------------------------------------------
// upstream key discovery
// ---------------------------------------------------------------------------

function findVariablesSlot(node) {
    return node.inputs?.findIndex((i) => i.name === "OPTIONS") ?? -1;
}

function readUpstreamRows(node) {
    const slot = findVariablesSlot(node);
    if (slot < 0) return null;
    const upstream = node.getInputNode?.(slot);
    if (!upstream) return null;
    if (upstream.comfyClass !== "NewflowDynamicDropdowns") return null;
    const w = upstream.widgets?.find((w) => w.name === "config");
    if (!w) return null;
    let rows;
    try {
        rows = typeof w.value === "string" ? JSON.parse(w.value) : w.value;
    } catch {
        return null;
    }
    return Array.isArray(rows) ? rows : null;
}

function getAvailableKeys(node) {
    const rows = readUpstreamRows(node);
    if (!rows) {
        const slot = findVariablesSlot(node);
        const hasUpstream = slot >= 0 && node.getInputNode?.(slot);
        return hasUpstream ? null : null; // null = "unknown / type manually"
    }
    const keys = [];
    for (const r of rows) {
        if (r && typeof r.label === "string" && r.label.trim()) keys.push(r.label.trim());
    }
    return keys;
}

function getCurrentValues(node) {
    const rows = readUpstreamRows(node);
    if (!rows) return {};
    const out = {};
    for (const r of rows) {
        if (!r || typeof r.label !== "string") continue;
        const label = r.label.trim();
        if (!label) continue;
        const val = r.selected;
        if (val == null || val === "" || val === "(none)") continue;
        if (!(label in out)) out[label] = String(val);
    }
    return out;
}

// ---------------------------------------------------------------------------
// chip strip
// ---------------------------------------------------------------------------

const NEWFLOW_DRAG_MIME = "application/x-newflow-pc-key";

function renderChips(host, keys, valuesMap, onChipClick) {
    host.replaceChildren();
    if (keys === null) {
        const msg = document.createElement("div");
        msg.className = "newflow-pc-chips-empty";
        msg.textContent = "(no variables wired)";
        host.appendChild(msg);
        return;
    }
    if (keys.length === 0) {
        const msg = document.createElement("div");
        msg.className = "newflow-pc-chips-empty";
        msg.textContent = "(upstream has no variables)";
        host.appendChild(msg);
        return;
    }
    keys.forEach((key) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "newflow-pc-chip";
        chip.textContent = key;
        chip.draggable = true;
        const val = valuesMap?.[key];
        chip.title = val != null && val !== ""
            ? `${key} = ${val}\nDrag to drop, or click to insert at cursor.`
            : `${key} (no value selected)\nDrag to drop, or click to insert at cursor.`;
        if (val == null || val === "") chip.classList.add("newflow-pc-chip-empty");

        let dragInitiated = false;

        chip.addEventListener("dragstart", (e) => {
            dragInitiated = true;
            e.dataTransfer.setData(NEWFLOW_DRAG_MIME, key);
            e.dataTransfer.setData("text/plain", `[[${key}]]`);
            e.dataTransfer.effectAllowed = "copy";
            chip.classList.add("newflow-pc-chip-dragging");
        });
        chip.addEventListener("dragend", () => {
            chip.classList.remove("newflow-pc-chip-dragging");
            // Reset on next tick so the upcoming click (if any) sees the flag
            setTimeout(() => { dragInitiated = false; }, 0);
        });

        chip.addEventListener("click", () => {
            if (dragInitiated) return;
            onChipClick(key);
        });
        host.appendChild(chip);
    });
}

function caretRangeAtPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (!pos) return null;
        const r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
        return r;
    }
    return null;
}

// ---------------------------------------------------------------------------
// slash menu
// ---------------------------------------------------------------------------

function attachSlashMenu(editor, getKeys, getValues, blockApi) {
    let menu = null;
    let items = [];
    let activeIdx = 0;
    let filterText = "";

    const close = () => {
        if (menu) {
            menu.remove();
            menu = null;
        }
        items = [];
        activeIdx = 0;
        filterText = "";
    };

    const positionMenu = () => {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0).cloneRange();
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            // happens when selection is collapsed at start of empty text node
            const editorRect = editor.getBoundingClientRect();
            menu.style.left = `${editorRect.left}px`;
            menu.style.top = `${editorRect.bottom + 4}px`;
        } else {
            menu.style.left = `${rect.left}px`;
            menu.style.top = `${rect.bottom + 4}px`;
        }
    };

    const update = () => {
        if (!menu) return;
        const keys = getKeys();
        const allKeys = keys || [];
        items = allKeys.filter((k) => k.toLowerCase().includes(filterText.toLowerCase()));
        if (activeIdx >= items.length) activeIdx = Math.max(0, items.length - 1);

        if (keys === null) {
            menu.innerHTML = `<div class="newflow-pc-slash-empty">Type variables manually as [[Key]]</div>`;
            return;
        }
        if (allKeys.length === 0) {
            menu.innerHTML = `<div class="newflow-pc-slash-empty">(no variables wired)</div>`;
            return;
        }
        if (items.length === 0) {
            menu.innerHTML = `<div class="newflow-pc-slash-empty">(no matches)</div>`;
            return;
        }

        const values = getValues();
        menu.innerHTML = items
            .map(
                (k, i) => `
                <div class="newflow-pc-slash-item ${i === activeIdx ? "is-active" : ""}" data-idx="${i}">
                    <span class="newflow-pc-slash-key">${escHtml(k)}</span>
                    <span class="newflow-pc-slash-val">${values[k] != null ? escHtml(values[k]) : ""}</span>
                </div>`
            )
            .join("");
        menu.querySelectorAll(".newflow-pc-slash-item").forEach((el) => {
            el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                activeIdx = parseInt(el.dataset.idx, 10);
                confirm();
            });
        });
        positionMenu();
    };

    const open = () => {
        if (menu) return;
        menu = document.createElement("div");
        menu.className = "newflow-pc-slash";
        document.body.appendChild(menu);
        filterText = "";
        activeIdx = 0;
        update();
    };

    const confirm = () => {
        if (!items.length) {
            close();
            return;
        }
        const key = items[activeIdx];
        // Remove the typed "/" + filter text from the editor
        const sel = window.getSelection();
        if (sel.rangeCount) {
            const range = sel.getRangeAt(0);
            const node = range.startContainer;
            const offset = range.startOffset;
            if (node.nodeType === Node.TEXT_NODE) {
                const before = node.textContent.slice(0, offset);
                const slashIdx = before.lastIndexOf("/");
                if (slashIdx >= 0) {
                    node.textContent =
                        before.slice(0, slashIdx) + node.textContent.slice(offset);
                    const r = document.createRange();
                    r.setStart(node, slashIdx);
                    r.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(r);
                }
            }
        }
        blockApi.insertPill(key);
        close();
    };

    editor.addEventListener("keydown", (e) => {
        if (menu) {
            if (e.key === "Escape") {
                e.preventDefault();
                close();
                return;
            }
            if (e.key === "ArrowDown") {
                e.preventDefault();
                if (items.length) {
                    activeIdx = (activeIdx + 1) % items.length;
                    update();
                }
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                if (items.length) {
                    activeIdx = (activeIdx - 1 + items.length) % items.length;
                    update();
                }
                return;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                confirm();
                return;
            }
        } else if (e.key === "/") {
            // Open after the "/" character has been inserted
            queueMicrotask(open);
        }
    });

    editor.addEventListener("input", () => {
        if (!menu) return;
        const sel = window.getSelection();
        if (!sel.rangeCount) {
            close();
            return;
        }
        const node = sel.anchorNode;
        const off = sel.anchorOffset;
        if (node?.nodeType !== Node.TEXT_NODE) {
            close();
            return;
        }
        const before = node.textContent.slice(0, off);
        const slashIdx = before.lastIndexOf("/");
        if (slashIdx < 0) {
            close();
            return;
        }
        const after = before.slice(slashIdx + 1);
        if (/[\s\[\]]/.test(after)) {
            close();
            return;
        }
        filterText = after;
        update();
    });

    editor.addEventListener("blur", () => {
        // Slight delay so a click on a menu item fires first
        setTimeout(close, 120);
    });

    return { close };
}

// ---------------------------------------------------------------------------
// editor block (one per prompt)
// ---------------------------------------------------------------------------

function makeEditorBlock(node, title, ctx) {
    const block = document.createElement("div");
    block.className = "newflow-pc-block";

    const head = document.createElement("div");
    head.className = "newflow-pc-head";
    const titleEl = document.createElement("div");
    titleEl.className = "newflow-pc-title";
    titleEl.textContent = title;
    head.append(titleEl);

    const editor = document.createElement("div");
    editor.className = "newflow-pc-editor";
    editor.contentEditable = "true";
    editor.spellcheck = false;
    editor.dataset.placeholder = "Type your prompt. Use / to insert a variable.";

    block.append(head, editor);

    let state = { text: "" };

    const api = {
        dom: block,
        editor,
        getValue: () => {
            state.text = serializeEditorToText(editor);
            return serializeState(state);
        },
        setValue: (v) => {
            const parsed = deserializeState(v);
            state = { text: parsed.text || "" };
            renderEditorFromText(editor, state.text, ctx.keys, ctx.displayMode, ctx.values);
        },
        refresh: (keys, values, displayMode) => {
            ctx.keys = keys;
            ctx.values = values;
            ctx.displayMode = displayMode;
            refreshPillsInPlace(editor, keys, displayMode, values);
        },
        insertPill: (key) => {
            const pill = makePill(key, ctx.keys, ctx.displayMode, ctx.values);
            const sel = window.getSelection();
            const range = sel.rangeCount ? sel.getRangeAt(0) : null;
            if (range && editor.contains(range.startContainer)) {
                range.insertNode(pill);
                const space = document.createTextNode(" ");
                pill.after(space);
                const after = document.createRange();
                after.setStart(space, 1);
                after.collapse(true);
                sel.removeAllRanges();
                sel.addRange(after);
            } else {
                editor.appendChild(pill);
                editor.appendChild(document.createTextNode(" "));
            }
            state.text = serializeEditorToText(editor);
            ctx.notifyChanged?.();
            node.setDirtyCanvas(true, true);
        },
    };

    editor.addEventListener("blur", () => {
        scanAndConvert(editor, ctx.keys, ctx.displayMode, ctx.values);
        state.text = serializeEditorToText(editor);
        ctx.notifyChanged?.();
    });

    // Prevent ComfyUI's canvas-level shortcuts (Ctrl/Cmd+C/V/X/A/Z/Y, Backspace,
    // Delete, etc.) from firing when typing inside this editor.
    const swallow = (e) => e.stopPropagation();
    editor.addEventListener("keydown", swallow);
    editor.addEventListener("keyup", swallow);
    editor.addEventListener("copy", swallow);
    editor.addEventListener("cut", swallow);

    editor.addEventListener("paste", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        document.execCommand("insertText", false, text);
    });

    editor.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types?.includes(NEWFLOW_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        editor.classList.add("newflow-pc-editor-dropping");
    });
    editor.addEventListener("dragleave", () => {
        editor.classList.remove("newflow-pc-editor-dropping");
    });
    editor.addEventListener("drop", (e) => {
        editor.classList.remove("newflow-pc-editor-dropping");
        const key = e.dataTransfer?.getData(NEWFLOW_DRAG_MIME);
        if (!key) return;
        e.preventDefault();
        e.stopPropagation();
        editor.focus();
        const range = caretRangeAtPoint(e.clientX, e.clientY);
        const sel = window.getSelection();
        sel.removeAllRanges();
        if (range && editor.contains(range.startContainer)) {
            sel.addRange(range);
        } else {
            const fallback = document.createRange();
            fallback.selectNodeContents(editor);
            fallback.collapse(false);
            sel.addRange(fallback);
        }
        api.insertPill(key);
    });

    attachSlashMenu(editor, () => ctx.keys, () => ctx.values, api);

    return api;
}

// ---------------------------------------------------------------------------
// LLM settings dialog (URL drives the model dropdown)
// ---------------------------------------------------------------------------

export function openLlmSettings(currentSettings) {
    return new Promise((resolve) => {
        const dlg = document.createElement("dialog");
        dlg.className = "newflow-dd-dialog newflow-pc-settings-dialog";
        dlg.innerHTML = `
            <form method="dialog" class="newflow-dd-form">
                <h3>LLM settings</h3>
                <label>Ollama URL <span class="newflow-pc-url-status" data-state="checking">…</span>
                    <input type="text" name="url" required spellcheck="false" />
                    <div class="newflow-pc-url-msg"></div>
                </label>
                <label>Model
                    <select name="model" disabled>
                        <option value="">(loading…)</option>
                    </select>
                </label>
                <label>Temperature: <span class="newflow-pc-temp-val"></span>
                    <input type="range" name="temperature" min="0" max="2" step="0.1" />
                </label>
                <label>Max tokens (use -1 for unlimited)
                    <input type="number" name="max_tokens" min="-1" max="32768" step="1" />
                </label>
                <label>Top P: <span class="newflow-pc-top-p-val"></span>
                    <input type="range" name="top_p" min="0" max="1" step="0.05" />
                </label>
                <label>Context size (num_ctx)
                    <input type="number" name="num_ctx" min="512" max="131072" step="512" />
                </label>
                <label class="newflow-pc-checkbox-row">
                    <input type="checkbox" name="auto_regen" />
                    <span>Auto-generate on workflow run</span>
                </label>
                <label class="newflow-pc-checkbox-row">
                    <input type="checkbox" name="auto_run_after_gen" />
                    <span>Run workflow after Generate (cascades downstream)</span>
                </label>
                <div class="newflow-dd-dialog-actions">
                    <button type="button" data-action="test">Test connection</button>
                    <span style="flex:1"></span>
                    <button type="button" data-action="cancel">Cancel</button>
                    <button type="submit" data-action="save" class="newflow-dd-primary" disabled>Save</button>
                </div>
            </form>
        `;
        document.body.appendChild(dlg);

        const $ = (sel) => dlg.querySelector(sel);
        const urlInput = $('[name="url"]');
        const modelSel = $('[name="model"]');
        const tempInput = $('[name="temperature"]');
        const tempVal = $(".newflow-pc-temp-val");
        const maxInput = $('[name="max_tokens"]');
        const topPInput = $('[name="top_p"]');
        const topPVal = $(".newflow-pc-top-p-val");
        const ctxInput = $('[name="num_ctx"]');
        const autoRegenInput = $('[name="auto_regen"]');
        const autoRunAfterGenInput = $('[name="auto_run_after_gen"]');
        const urlStatus = $(".newflow-pc-url-status");
        const urlMsg = $(".newflow-pc-url-msg");
        const saveBtn = $('[data-action="save"]');
        const testBtn = $('[data-action="test"]');
        const cancelBtn = $('[data-action="cancel"]');

        const merged = { ...DEFAULT_LLM_SETTINGS, ...(currentSettings || {}) };
        urlInput.value = merged.ollama_url;
        tempInput.value = merged.temperature;
        tempVal.textContent = String(merged.temperature);
        maxInput.value = merged.max_tokens;
        topPInput.value = merged.top_p;
        topPVal.textContent = String(merged.top_p);
        ctxInput.value = merged.num_ctx;
        autoRegenInput.checked = !!merged.auto_regen;
        autoRunAfterGenInput.checked = merged.auto_run_after_gen !== false;

        const setUrlStatus = (state, msg) => {
            urlStatus.dataset.state = state;
            urlStatus.textContent = state === "ok" ? "●" : state === "error" ? "●" : "…";
            urlMsg.textContent = msg || "";
        };

        let lastFetchToken = 0;
        const refreshModels = async () => {
            const myToken = ++lastFetchToken;
            const url = urlInput.value.trim();
            if (!url) {
                setUrlStatus("error", "(enter a URL)");
                modelSel.disabled = true;
                modelSel.innerHTML = `<option>(enter a URL)</option>`;
                saveBtn.disabled = true;
                return;
            }
            setUrlStatus("checking", "Checking connection…");
            try {
                const r = await fetch(`/newflow/llm/models?url=${encodeURIComponent(url)}`);
                if (myToken !== lastFetchToken) return; // stale, a newer request superseded
                const data = await r.json().catch(() => ({}));
                if (!r.ok) {
                    setUrlStatus("error", data.error || `HTTP ${r.status}`);
                    modelSel.disabled = true;
                    modelSel.innerHTML = `<option>(URL unreachable)</option>`;
                    saveBtn.disabled = true;
                    return;
                }
                const models = Array.isArray(data.models) ? data.models : [];
                if (models.length === 0) {
                    setUrlStatus("error", "Connected — no models. Run `ollama pull <name>` on the host.");
                    modelSel.disabled = true;
                    modelSel.innerHTML = `<option>(no models)</option>`;
                    saveBtn.disabled = true;
                    return;
                }
                setUrlStatus("ok", `Connected — ${models.length} model${models.length === 1 ? "" : "s"} available`);
                modelSel.innerHTML = models
                    .map((m) => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`)
                    .join("");
                if (merged.model && models.some((m) => m.name === merged.model)) {
                    modelSel.value = merged.model;
                }
                modelSel.disabled = false;
                saveBtn.disabled = false;
            } catch (e) {
                if (myToken !== lastFetchToken) return;
                setUrlStatus("error", String(e.message || e));
                modelSel.disabled = true;
                modelSel.innerHTML = `<option>(error)</option>`;
                saveBtn.disabled = true;
            }
        };

        let urlTimer = null;
        urlInput.addEventListener("input", () => {
            clearTimeout(urlTimer);
            urlTimer = setTimeout(refreshModels, 400);
        });
        tempInput.addEventListener("input", () => (tempVal.textContent = tempInput.value));
        topPInput.addEventListener("input", () => (topPVal.textContent = topPInput.value));
        testBtn.addEventListener("click", refreshModels);

        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            try { dlg.close(); } catch {}
            try { dlg.remove(); } catch {}
            resolve(result);
        };

        cancelBtn.addEventListener("click", () => finish(null));
        dlg.addEventListener("close", () => finish(null));
        dlg.querySelector("form").addEventListener("submit", (e) => {
            e.preventDefault();
            finish({
                ollama_url: urlInput.value.trim(),
                model: modelSel.value,
                temperature: parseFloat(tempInput.value),
                max_tokens: Number.isFinite(parseInt(maxInput.value, 10)) ? parseInt(maxInput.value, 10) : DEFAULT_LLM_SETTINGS.max_tokens,
                top_p: parseFloat(topPInput.value),
                num_ctx: parseInt(ctxInput.value, 10) || DEFAULT_LLM_SETTINGS.num_ctx,
                auto_regen: !!autoRegenInput.checked,
                auto_run_after_gen: !!autoRunAfterGenInput.checked,
            });
        });

        dlg.showModal();
        refreshModels();
    });
}

// ---------------------------------------------------------------------------
// LLM output block (factory)
// ---------------------------------------------------------------------------

function makeOutputBlock(node, ctx) {
    const block = document.createElement("div");
    block.className = "newflow-pc-block newflow-pc-llm-block";

    const head = document.createElement("div");
    head.className = "newflow-pc-head newflow-pc-llm-head";

    const titleEl = document.createElement("div");
    titleEl.className = "newflow-pc-title";
    titleEl.textContent = "LLM Output";

    const status = document.createElement("span");
    status.className = "newflow-pc-status";
    status.dataset.state = "idle";
    status.textContent = "idle";

    const imagesBadge = document.createElement("span");
    imagesBadge.className = "newflow-pc-images-badge";
    imagesBadge.textContent = "🖼 0";
    imagesBadge.title = "Images cached for vision LLM (run workflow to refresh)";

    const autoBtn = document.createElement("button");
    autoBtn.type = "button";
    autoBtn.className = "newflow-pc-auto-btn";
    autoBtn.textContent = "⚡ Auto";

    const generateBtn = document.createElement("button");
    generateBtn.type = "button";
    generateBtn.className = "newflow-pc-generate-btn";
    generateBtn.textContent = "Generate";

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "newflow-pc-settings-btn";
    settingsBtn.textContent = "⚙";
    settingsBtn.title = "LLM settings";

    head.append(titleEl, status, imagesBadge, autoBtn, generateBtn, settingsBtn);

    const editor = document.createElement("div");
    editor.className = "newflow-pc-editor newflow-pc-llm-editor";
    editor.contentEditable = "true";
    editor.spellcheck = false;
    editor.dataset.placeholder = "Click Generate to run the LLM, or paste / type manually.";

    block.append(head, editor);

    let state = { text: "", settings: { ...DEFAULT_LLM_SETTINGS } };
    let abortCtrl = null;

    const refreshAutoBtn = () => {
        const on = !!state.settings.auto_regen;
        autoBtn.classList.toggle("newflow-pc-auto-on", on);
        autoBtn.title = on
            ? "Auto-generate on workflow Run is ON. Click to disable."
            : "Auto-generate on workflow Run is OFF. Click to enable.";
    };
    autoBtn.addEventListener("click", () => {
        state.settings.auto_regen = !state.settings.auto_regen;
        refreshAutoBtn();
        ctx.notifyChanged?.();
    });
    refreshAutoBtn();

    const setStatus = (s) => {
        status.dataset.state = s;
        status.textContent = s;
    };
    const setStreaming = (streaming) => {
        editor.contentEditable = streaming ? "false" : "true";
        editor.classList.toggle("newflow-pc-llm-streaming", streaming);
        generateBtn.textContent = streaming ? "Stop" : "Generate";
        generateBtn.classList.toggle("newflow-pc-stop-btn", streaming);
        settingsBtn.disabled = streaming;
    };

    // Wraps a thrown error with the node title so the queue interceptor can
    // surface it cleanly in a toast.
    const wrapErr = (msg, name) => {
        const e = new Error(msg);
        if (name) e.name = name;
        e.nodeTitle = node.title || "Newflow Prompt Composer";
        return e;
    };

    // Core generation logic. Returns a Promise that resolves on completion
    // or rejects on any failure (Ollama unreachable, model error, abort).
    // `silent: true` suppresses interactive alerts (used by the queue interceptor).
    const runGenerate = async ({ silent = false } = {}) => {
        if (abortCtrl) {
            // Already running; do nothing (caller should not reach here).
            return;
        }
        if (!state.settings.model) {
            throw wrapErr("No model selected — open settings and pick one.");
        }

        const userText = resolveTextForLlm(ctx.getUserText?.() || "", ctx.values || {});
        const systemText = resolveTextForLlm(ctx.getSystemText?.() || "", ctx.values || {});

        // Activate the running UI immediately so the button reads "Stop" and
        // the status badge updates during the preflight phases (healthcheck +
        // image preload), not only once the chat stream starts. abortCtrl is
        // wired up early so Stop is functional from t=0.
        abortCtrl = new AbortController();
        setStreaming(true);
        setStatus("checking ollama");

        try {
            // Pre-flight healthcheck so we fail fast with a clear error.
            try {
                const h = await fetch(
                    `/newflow/llm/healthz?url=${encodeURIComponent(state.settings.ollama_url)}`,
                    { signal: abortCtrl.signal },
                );
                if (!h.ok) {
                    const err = await h.json().catch(() => ({}));
                    const msg = `Ollama not reachable at ${state.settings.ollama_url}: ${err.error || `HTTP ${h.status}`}`;
                    if (!silent) alert(msg);
                    throw wrapErr(msg);
                }
            } catch (e) {
                if (e.name === "AbortError") {
                    setStatus("stopped");
                    throw wrapErr("Generation aborted", "AbortError");
                }
                if (e.nodeTitle) throw e; // already wrapped
                const msg = `Ollama not reachable: ${e.message || e}`;
                if (!silent) alert(msg);
                throw wrapErr(msg);
            }

            // JIT image cache populator — walk upstream image sources and load
            // their files into IMAGE_CACHE so we don't need a workflow run first.
            setStatus("loading images");
            try {
                await preloadImageCache(node, { signal: abortCtrl.signal });
                // Refresh the badge immediately so the UI reflects the new cache.
                ctx.refreshImageBadgeNow?.();
            } catch (e) {
                if (e.name === "AbortError") {
                    setStatus("stopped");
                    throw wrapErr("Generation aborted", "AbortError");
                }
                // Non-fatal: log the failure and proceed; the LLM may just get
                // fewer images than expected.
                console.warn("Newflow: image preload failed:", e);
            }

            editor.textContent = "";
            state.text = "";
            ctx.notifyChanged?.();
            setStatus("streaming");

            try {
                const resp = await fetch("/newflow/llm/generate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: state.settings.model,
                        user: userText,
                        system: systemText,
                        options: {
                            temperature: state.settings.temperature,
                            num_predict: state.settings.max_tokens,
                            top_p: state.settings.top_p,
                            num_ctx: state.settings.num_ctx,
                        },
                        ollama_url: state.settings.ollama_url,
                        node_id: String(node.id ?? ""),
                    }),
                    signal: abortCtrl.signal,
                });
                if (!resp.ok || !resp.body) {
                    const txt = await resp.text().catch(() => "");
                    throw new Error(`HTTP ${resp.status}${txt ? ": " + txt : ""}`);
                }
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buf = "";
                let lastError = null;
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    let nl;
                    while ((nl = buf.indexOf("\n")) >= 0) {
                        const line = buf.slice(0, nl).trim();
                        buf = buf.slice(nl + 1);
                        if (!line) continue;
                        try {
                            const chunk = JSON.parse(line);
                            if (chunk.error) {
                                lastError = chunk.error + (chunk.detail ? ": " + chunk.detail : "");
                                continue;
                            }
                            if (typeof chunk.newflow_status === "string") {
                                setStatus(chunk.newflow_status);
                                continue;
                            }
                            const piece =
                                (chunk.message && typeof chunk.message.content === "string"
                                    ? chunk.message.content
                                    : null) ??
                                (typeof chunk.response === "string" ? chunk.response : null);
                            if (piece) {
                                state.text += piece;
                                editor.textContent = state.text;
                                editor.scrollTop = editor.scrollHeight;
                            }
                        } catch {
                            // ignore malformed JSON lines
                        }
                    }
                }
                ctx.notifyChanged?.();
                if (lastError) {
                    setStatus("error");
                    if (!silent) alert(`Generation failed: ${lastError}`);
                    throw wrapErr(lastError);
                }
                setStatus("done");
            } catch (e) {
                if (e.name === "AbortError") {
                    setStatus("stopped");
                    throw wrapErr("Generation aborted", "AbortError");
                }
                if (!e.nodeTitle) {
                    setStatus("error");
                    if (!silent) alert(`Generation failed: ${e.message || e}`);
                    throw wrapErr(e.message || String(e));
                }
                throw e;
            }
        } finally {
            abortCtrl = null;
            setStreaming(false);
        }
    };

    const abortInFlight = () => {
        if (abortCtrl) abortCtrl.abort();
    };

    // Manual click handler — preserves existing UX (open settings if no model,
    // alert on error, toggle stop while streaming).
    generateBtn.addEventListener("click", async () => {
        if (abortCtrl) {
            abortInFlight();
            return;
        }
        if (!state.settings.model) {
            const newSettings = await openLlmSettings(state.settings);
            if (!newSettings) return;
            state.settings = { ...DEFAULT_LLM_SETTINGS, ...newSettings };
            refreshAutoBtn();
            ctx.notifyChanged?.();
            if (!state.settings.model) return;
        }
        let succeeded = false;
        markComposerRunning(node);
        try {
            await runGenerate({ silent: false });
            succeeded = true;
        } catch {
            // alerts already shown by runGenerate when silent=false
        } finally {
            clearComposerRunning(node);
        }
        // After a successful manual Generate, auto-queue the workflow so
        // downstream nodes (Array Split / Pick / etc.) pick up the new
        // `prompt` output. Skip if auto_regen is on (the workflow run would
        // re-generate, creating an infinite loop) or if the user disabled it.
        if (
            succeeded
            && state.settings.auto_run_after_gen !== false
            && !state.settings.auto_regen
            && hasDownstreamConsumer(node)
        ) {
            try {
                await app.queuePrompt(0, 1);
            } catch (e) {
                console.warn("Newflow: auto-run after Generate failed:", e);
            }
        }
    });

    // Hooks the queue interceptor calls.
    node._newflowIsAutoRegen = () => !!state.settings.auto_regen;
    node._newflowRunGenerate = () => runGenerate({ silent: true });
    node._newflowAbortGenerate = abortInFlight;
    settingsBtn.addEventListener("click", async () => {
        const next = await openLlmSettings(state.settings);
        if (!next) return;
        state.settings = { ...DEFAULT_LLM_SETTINGS, ...next };
        refreshAutoBtn();
        ctx.notifyChanged?.();
    });

    editor.addEventListener("input", () => {
        if (abortCtrl) return;
        state.text = editor.textContent || "";
        ctx.notifyChanged?.();
    });

    editor.addEventListener("paste", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        document.execCommand("insertText", false, text);
    });

    // Helper: are any of the Composer's IMAGE inputs wired upstream?
    const anyImageInputWired = () => {
        for (const name of ["IMAGES", "IMAGE_LIST"]) {
            const slotIdx = (node.inputs || []).findIndex((i) => i.name === name);
            if (slotIdx < 0) continue;
            if (node.getInputNode?.(slotIdx)) return true;
        }
        return false;
    };

    const refreshImageBadge = async () => {
        // Always render the badge so the user can verify cache state at a glance.
        imagesBadge.hidden = false;
        const setBadge = (text, title, warning = false) => {
            imagesBadge.textContent = text;
            imagesBadge.title = title;
            imagesBadge.classList.toggle("newflow-pc-images-badge-warning", warning);
        };

        if (!node.id) {
            setBadge("🖼 0", "No images cached yet");
            return;
        }
        try {
            const r = await fetch(`/newflow/llm/images_count?node_id=${encodeURIComponent(String(node.id))}`);
            if (!r.ok) {
                setBadge("🖼 ?", `Couldn't read cache (HTTP ${r.status})`, true);
                return;
            }
            const data = await r.json();
            const count = data?.count || 0;
            if (count > 0) {
                setBadge(
                    `🖼 ${count}`,
                    `${count} image${count === 1 ? "" : "s"} cached for vision LLM (run workflow to refresh)`,
                );
            } else if (anyImageInputWired()) {
                // Inputs are wired but the cache is empty — workflow hasn't run yet.
                // The LLM call will not actually receive these images until the
                // workflow has executed at least once (or auto-regen is enabled).
                setBadge(
                    "🖼 0 ⚠",
                    "Image inputs are wired but the cache is empty. Click Run on the workflow once to load them, " +
                    "or enable \"Auto-generate on workflow run\" in ⚙ settings so Run does it automatically.",
                    true,
                );
            } else {
                setBadge("🖼 0", "No images wired. Connect an IMAGE source and run the workflow.");
            }
        } catch (e) {
            setBadge("🖼 ?", `Image cache lookup failed: ${e?.message || e}`, true);
        }
    };

    return {
        dom: block,
        editor,
        head,
        refreshImageBadge,
        getValue: () =>
            JSON.stringify({
                text: editor.textContent || "",
                settings: state.settings,
            }),
        setValue: (v) => {
            const parsed = deserializeLlmState(v);
            state = { text: parsed.text, settings: parsed.settings };
            editor.textContent = state.text;
            refreshAutoBtn();
        },
    };
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "newflow.prompt_composer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // Force MIN_WIDTH at the prototype level so LiteGraph's first layout pass
        // sees it. We deliberately do NOT clamp height here — that creates a
        // feedback loop with widget.computeSize overrides where the node grows
        // by a few pixels every frame.
        const origProtoCompute = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (out) {
            const r = origProtoCompute?.call(this, out) || [0, 0];
            if (r[0] < MIN_WIDTH) r[0] = MIN_WIDTH;
            return r;
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            const node = this;

            let persist = null;

            // Shared context for editor blocks + LLM block (incl. shared displayMode)
            const ctx = {
                keys: null,
                values: {},
                displayMode: "source",
                notifyChanged: () => {
                    persist?.markDirty();
                    node.setDirtyCanvas(true, true);
                },
            };

            // Widget 1 host: chip strip + user editor block
            const userHost = document.createElement("div");
            userHost.className = "newflow-pc-root";

            const chipStrip = document.createElement("div");
            chipStrip.className = "newflow-pc-chips";

            const userBlock = makeEditorBlock(node, "User prompt", ctx);
            userHost.append(chipStrip, userBlock.dom);

            // Widget 2 host: system editor block (alone)
            const systemHost = document.createElement("div");
            systemHost.className = "newflow-pc-root";
            const systemBlock = makeEditorBlock(node, "System prompt", ctx);
            systemHost.appendChild(systemBlock.dom);

            // Widget 3 host: LLM output block + bottom display toggle
            const llmHost = document.createElement("div");
            llmHost.className = "newflow-pc-root";

            // The LLM block needs read-access to substituted user/system text.
            ctx.getUserText = () => serializeEditorToText(userBlock.editor);
            ctx.getSystemText = () => serializeEditorToText(systemBlock.editor);

            const llmBlock = makeOutputBlock(node, ctx);

            const displaySel = document.createElement("select");
            displaySel.className = "newflow-pc-display";
            displaySel.title = "How variables render inside both editors";
            DISPLAY_MODES.forEach((m) => {
                const o = document.createElement("option");
                o.value = m.value;
                o.textContent = m.label;
                displaySel.appendChild(o);
            });

            const bottomRow = document.createElement("div");
            bottomRow.className = "newflow-pc-bottomrow";
            bottomRow.appendChild(displaySel);

            llmHost.append(llmBlock.dom, bottomRow);

            const refreshAll = () => {
                ctx.keys = getAvailableKeys(node);
                ctx.values = getCurrentValues(node);
                renderChips(chipStrip, ctx.keys, ctx.values, (key) => {
                    const focused = document.activeElement;
                    if (focused === userBlock.editor) userBlock.insertPill(key);
                    else if (focused === systemBlock.editor) systemBlock.insertPill(key);
                    else userBlock.insertPill(key);
                });
                userBlock.refresh(ctx.keys, ctx.values, ctx.displayMode);
                systemBlock.refresh(ctx.keys, ctx.values, ctx.displayMode);
                llmBlock.refreshImageBadge?.();
            };

            // Allow inner blocks to trigger an immediate badge refresh
            // (used after JIT image-preload so the count ticks up instantly).
            ctx.refreshImageBadgeNow = () => llmBlock.refreshImageBadge?.();

            displaySel.addEventListener("change", () => {
                ctx.displayMode = displaySel.value;
                userBlock.refresh(ctx.keys, ctx.values, ctx.displayMode);
                systemBlock.refresh(ctx.keys, ctx.values, ctx.displayMode);
                ctx.notifyChanged?.();
            });

            // Always-on poll so chip strip + pill labels reflect upstream
            // changes (dropdown selection edits) even when our editors don't
            // have focus. 1 s is cheap and avoids visible staleness.
            const pollTimer = setInterval(refreshAll, 1000);

            // Hook connection changes so chips/pills react instantly on (dis)connect
            const origConn = node.onConnectionsChange;
            node.onConnectionsChange = function () {
                origConn?.apply(this, arguments);
                refreshAll();
            };

            const userWidget = node.addDOMWidget(USER_WIDGET, "newflow_prompt_state", userHost, {
                serialize: true,
                getValue: () => {
                    const inner = JSON.parse(userBlock.getValue() || "{}");
                    return JSON.stringify({ ...inner, displayMode: ctx.displayMode });
                },
            });

            const systemWidget = node.addDOMWidget(SYSTEM_WIDGET, "newflow_prompt_state", systemHost, {
                serialize: true,
                getValue: () => systemBlock.getValue(),
            });

            const llmWidget = node.addDOMWidget(LLM_WIDGET, "newflow_llm_state", llmHost, {
                serialize: true,
                getValue: () => llmBlock.getValue(),
            });


            persist = installPersistence(node, {
                nodeClass: NODE_NAME,
                schema: "NewflowPromptComposer.v2",
                widgetNames: [USER_WIDGET, SYSTEM_WIDGET, LLM_WIDGET],
                extractFromWidgets: ([userRaw, systemRaw, llmRaw]) => {
                    const userParsed = deserializeState(userRaw || "{}");
                    return {
                        user: userRaw || "{}",
                        system: systemRaw || "{}",
                        llm: llmRaw || "{}",
                        displayMode:
                            userParsed.displayMode
                            && DISPLAY_MODES.some(
                                (m) => m.value === userParsed.displayMode,
                            )
                                ? userParsed.displayMode
                                : "source",
                    };
                },
                getState: () => ({
                    user: userBlock.getValue(),
                    system: systemBlock.getValue(),
                    llm: llmBlock.getValue(),
                    displayMode: ctx.displayMode,
                }),
                setState: (s) => {
                    if (
                        s.displayMode
                        && DISPLAY_MODES.some((m) => m.value === s.displayMode)
                    ) {
                        ctx.displayMode = s.displayMode;
                        displaySel.value = ctx.displayMode;
                    }
                    if (s.user) userBlock.setValue(s.user);
                    if (s.system) systemBlock.setValue(s.system);
                    if (s.llm) llmBlock.setValue(s.llm);
                    refreshAll();
                },
                defaultState: () => ({
                    user: "{}",
                    system: "{}",
                    llm: "{}",
                    displayMode: "source",
                }),
            });

            // Each widget gets a fixed height. Fully independent of node.size
            // to avoid feedback loops. Editors can be resized via their corner
            // handles (CSS `resize: vertical`).
            userWidget.computeSize = (w) => [w, FIXED_USER_WIDGET_H];
            systemWidget.computeSize = (w) => [w, FIXED_SYSTEM_WIDGET_H];
            llmWidget.computeSize = (w) => [w, FIXED_LLM_WIDGET_H];

            // Initial render — happens before setValue is called for fresh nodes
            refreshAll();

            // Enforce a comfortable minimum size at every layer:
            //   1. node.size — direct property
            //   2. node.computeSize — what LiteGraph asks for sizing
            //   3. node.onResize — clamp on user drag
            const applyMinSize = () => {
                if (!Array.isArray(node.size)) return;
                if (node.size[0] < MIN_WIDTH) node.size[0] = MIN_WIDTH;
                if (node.size[1] < MIN_HEIGHT) node.size[1] = MIN_HEIGHT;
                node.setSize?.(node.size);
                node.setDirtyCanvas?.(true, true);
            };

            const origComputeSize = node.computeSize;
            node.computeSize = function (out) {
                const r = origComputeSize?.call(this, out) || [MIN_WIDTH, MIN_HEIGHT];
                if (r[0] < MIN_WIDTH) r[0] = MIN_WIDTH;
                if (r[1] < MIN_HEIGHT) r[1] = MIN_HEIGHT;
                return r;
            };

            applyMinSize();
            const origOnResize = node.onResize;
            node.onResize = function (size) {
                if (Array.isArray(size)) {
                    if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                    if (size[1] < MIN_HEIGHT) size[1] = MIN_HEIGHT;
                }
                origOnResize?.apply(this, arguments);
            };

            const origRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(pollTimer);
                origRemoved?.apply(this, arguments);
            };
        };
    },
});
