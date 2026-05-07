import { app } from "../../scripts/app.js";

const NODE_NAME = "NewflowArraySplit";
const POLL_INTERVAL = 1000;

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./array_split.css", import.meta.url).href;
document.head.appendChild(css);

app.registerExtension({
    name: "newflow.array_split",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            const node = this;

            const root = document.createElement("div");
            root.className = "newflow-as-root";

            const header = document.createElement("div");
            header.className = "newflow-as-header";

            const label = document.createElement("span");
            label.className = "newflow-as-label";
            label.textContent = "Array";

            const count = document.createElement("span");
            count.className = "newflow-as-count";
            count.textContent = "0 items";

            header.append(label, count);

            const list = document.createElement("div");
            list.className = "newflow-as-list";

            root.append(header, list);

            const widget = node.addDOMWidget("array_view", "newflow_array_split_ui", root, {
                serialize: false,
            });

            let lastItems = [];

            const itemsEqual = (a, b) => {
                if (a.length !== b.length) return false;
                for (let i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) return false;
                }
                return true;
            };

            const renderItems = (items) => {
                if (itemsEqual(items, lastItems)) return;
                lastItems = items.slice();

                count.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
                list.replaceChildren();

                if (items.length === 0) {
                    const empty = document.createElement("div");
                    empty.className = "newflow-as-empty";
                    empty.textContent = "(no items — run the workflow)";
                    list.appendChild(empty);
                    node.setDirtyCanvas(true, true);
                    return;
                }

                items.forEach((item) => {
                    const inp = document.createElement("input");
                    inp.type = "text";
                    inp.readOnly = true;
                    inp.className = "newflow-as-item";
                    inp.value = String(item);
                    inp.title = String(item);
                    list.appendChild(inp);
                });
                node.setDirtyCanvas(true, true);
            };

            const refresh = async () => {
                if (!node.id || node.id < 0) return;
                try {
                    const r = await fetch(
                        `/newflow/utils/array_items?node_id=${encodeURIComponent(String(node.id))}`,
                    );
                    if (!r.ok) return;
                    const data = await r.json();
                    const items = Array.isArray(data.items) ? data.items : [];
                    renderItems(items);
                } catch {
                    // network blip — next poll will retry
                }
            };

            // Width-respecting size: ~28px header + 24px per item + padding,
            // capped so the node stays manageable. The list itself scrolls if
            // content exceeds the visible window.
            widget.computeSize = (w) => {
                const headerH = 28;
                const padH = 12;
                const perItemH = 26;
                const visibleItems = Math.max(1, Math.min(lastItems.length || 1, 8));
                return [w, headerH + visibleItems * perItemH + padH];
            };

            const pollTimer = setInterval(refresh, POLL_INTERVAL);
            refresh();

            const origRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(pollTimer);
                origRemoved?.apply(this, arguments);
            };
        };
    },
});
