import { app } from "../../scripts/app.js";
import { installPersistence } from "./_persistence.js";

const NODE_NAME = "NewflowArrayPick";
const INDEX_WIDGET = "index";
const POLL_INTERVAL = 1000;
const MAX_PREVIEW_LEN = 60;

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./array_pick.css", import.meta.url).href;
document.head.appendChild(css);

const escHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

const truncate = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

app.registerExtension({
    name: "newflow.array_pick",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            const node = this;

            // Custom DOM widget — a single <select> + status line. The widget's
            // value is the int index, carried via `getValue` so the backend
            // sees it in `cls.hidden.prompt[uid]["inputs"]["index"]`.
            const root = document.createElement("div");
            root.className = "newflow-ap-root";

            const select = document.createElement("select");
            select.className = "newflow-ap-select";

            const status = document.createElement("div");
            status.className = "newflow-ap-status";
            status.textContent = "";

            root.append(select, status);

            let currentIdx = 0;
            let persist = null;

            node.addDOMWidget(INDEX_WIDGET, "newflow_array_pick_ui", root, {
                serialize: true,
                getValue: () => currentIdx,
                // Defensive: if anything assigns widget.value directly (LiteGraph
                // load, sibling code, etc.), capture it. The Vue frontend's
                // setValue dispatch is unreliable, so we also rely on
                // installPersistence's onConfigure → setState path.
                setValue: (v) => {
                    const n = parseInt(v, 10);
                    if (Number.isFinite(n)) currentIdx = n;
                },
            });

            select.addEventListener("change", () => {
                const idx = parseInt(select.value, 10);
                if (Number.isFinite(idx)) {
                    currentIdx = idx;
                    node.setDirtyCanvas(true, true);
                }
            });

            // Track the last-rendered shape so we can short-circuit identical
            // re-renders. Without this, every 1 s poll rewrites select.innerHTML
            // and slams the dropdown shut if the user has it open.
            let lastRender = { kind: null, items: null, idx: null };

            const setOptions = (options, statusText) => {
                select.innerHTML = options
                    .map(
                        (opt) =>
                            `<option value="${escHtml(opt.value)}">${escHtml(opt.label)}</option>`,
                    )
                    .join("");
                status.textContent = statusText || "";
            };

            const itemsEqual = (a, b) => {
                if (a === b) return true;
                if (!Array.isArray(a) || !Array.isArray(b)) return false;
                if (a.length !== b.length) return false;
                for (let i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) return false;
                }
                return true;
            };

            // Sync the visible <select> to the persisted int value, clamping if needed.
            const syncToIndex = (itemCount) => {
                if (itemCount === 0) return;
                const clamped = Math.max(0, Math.min(currentIdx, itemCount - 1));
                if (clamped !== currentIdx) currentIdx = clamped;
                if (select.value !== String(clamped)) {
                    select.value = String(clamped);
                }
            };

            const findUpstream = () => {
                const slotIdx = (node.inputs || []).findIndex((i) => i.name === "array");
                if (slotIdx < 0) return null;
                return node.getInputNode?.(slotIdx) || null;
            };

            const refresh = async () => {
                const upstream = findUpstream();
                if (!upstream) {
                    if (lastRender.kind !== "no-upstream") {
                        setOptions(
                            [{ value: "0", label: "(connect array source)" }],
                            "",
                        );
                        lastRender = { kind: "no-upstream", items: null, idx: null };
                    }
                    return;
                }
                if (upstream.comfyClass !== "NewflowArraySplit") {
                    if (lastRender.kind !== "unknown") {
                        setOptions(
                            [
                                { value: "0", label: "0" },
                                { value: "1", label: "1" },
                                { value: "2", label: "2" },
                                { value: "3", label: "3" },
                                { value: "4", label: "4" },
                            ],
                            "Unknown array source — index only",
                        );
                        lastRender = { kind: "unknown", items: null, idx: null };
                    }
                    return;
                }
                try {
                    const r = await fetch(
                        `/newflow/utils/array_items?node_id=${encodeURIComponent(String(upstream.id))}`,
                    );
                    if (!r.ok) return;
                    const data = await r.json();
                    const items = Array.isArray(data.items) ? data.items : [];
                    if (items.length === 0) {
                        // Empty cache — show stub option carrying the saved index
                        // so the visible "N:" matches currentIdx.
                        if (lastRender.kind !== "empty" || lastRender.idx !== currentIdx) {
                            setOptions(
                                [{
                                    value: String(currentIdx),
                                    label: `${currentIdx}: (run workflow once to load items)`,
                                }],
                                "",
                            );
                            lastRender = { kind: "empty", items: null, idx: currentIdx };
                        }
                        return;
                    }
                    if (lastRender.kind !== "items" || !itemsEqual(items, lastRender.items)) {
                        const options = items.map((item, i) => ({
                            value: String(i),
                            label: `${i}: ${truncate(String(item), MAX_PREVIEW_LEN)}`,
                        }));
                        setOptions(options, `${items.length} item${items.length === 1 ? "" : "s"}`);
                        lastRender = { kind: "items", items: items.slice(), idx: null };
                    }
                    syncToIndex(items.length);
                } catch {
                    // network blip — ignore, next poll will retry
                }
            };

            persist = installPersistence(node, {
                nodeClass: NODE_NAME,
                schema: "NewflowArrayPick.v2",
                widgetNames: [INDEX_WIDGET],
                extractFromWidgets: ([raw]) => {
                    const v = parseInt(raw, 10);
                    return { idx: Number.isFinite(v) ? v : 0 };
                },
                getState: () => ({ idx: currentIdx }),
                setState: ({ idx }) => {
                    currentIdx = Number.isFinite(idx) ? idx : 0;
                    // If options exist and contain currentIdx, just align select.value.
                    // Otherwise force a refresh so the stub/options reflect currentIdx.
                    const hasMatchingOption = !!select.querySelector(
                        `option[value="${currentIdx}"]`,
                    );
                    if (hasMatchingOption) {
                        select.value = String(currentIdx);
                    } else {
                        refresh();
                    }
                },
                defaultState: () => ({ idx: 0 }),
            });

            // Poll on a 1 s timer so the dropdown picks up upstream re-runs.
            const pollTimer = setInterval(refresh, POLL_INTERVAL);
            refresh();

            // Also refresh immediately when the connection changes.
            const origConn = node.onConnectionsChange;
            node.onConnectionsChange = function () {
                origConn?.apply(this, arguments);
                refresh();
            };

            const origRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(pollTimer);
                origRemoved?.apply(this, arguments);
            };
        };
    },
});
