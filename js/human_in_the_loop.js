import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NewflowHumanInTheLoop";
const MIN_WIDTH = 320;

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./human_in_the_loop.css", import.meta.url).href;
document.head.appendChild(css);

function viewUrl(img) {
    if (!img || !img.filename) return "";
    const params = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || "",
        type: img.type || "temp",
    });
    return `/view?${params.toString()}`;
}

// Per-node hooks keyed by the LiteGraph node OBJECT (not id), because
// node.id can be -1 during onNodeCreated before the node is added to the
// graph. We look up the actual node by id at WS event time.
const NODE_HOOKS = new WeakMap();

function findHooksByNodeId(rawId) {
    const id = typeof rawId === "string" ? parseInt(rawId, 10) : Number(rawId);
    if (!Number.isFinite(id)) return null;
    const node = app.graph?.getNodeById?.(id);
    if (!node) return null;
    return NODE_HOOKS.get(node) || null;
}

// WebSocket events from the server. ComfyUI's `api` exposes addEventListener
// for arbitrary event types fired by PromptServer.send_sync(...).
api.addEventListener("newflow.hitl.awaiting", (event) => {
    const detail = event.detail || {};
    const hooks = findHooksByNodeId(detail.node_id);
    if (!hooks) return;
    hooks.showAwaiting(detail.images || []);
});

api.addEventListener("newflow.hitl.settled", (event) => {
    const detail = event.detail || {};
    const hooks = findHooksByNodeId(detail.node_id);
    if (!hooks) return;
    hooks.showSettled(detail.outcome || "");
});

app.registerExtension({
    name: "newflow.human_in_the_loop",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

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

            const root = document.createElement("div");
            root.className = "newflow-hitl-root";

            const preview = document.createElement("div");
            preview.className = "newflow-hitl-preview";
            const placeholder = document.createElement("div");
            placeholder.className = "newflow-hitl-placeholder";
            placeholder.textContent = "Run workflow — image will appear here for review.";
            preview.appendChild(placeholder);

            const status = document.createElement("div");
            status.className = "newflow-hitl-status";
            status.dataset.state = "idle";
            status.textContent = "idle";

            const buttons = document.createElement("div");
            buttons.className = "newflow-hitl-buttons";

            const rejectBtn = document.createElement("button");
            rejectBtn.type = "button";
            rejectBtn.className = "newflow-hitl-btn newflow-hitl-reject";
            rejectBtn.textContent = "✕ Reject";

            const approveBtn = document.createElement("button");
            approveBtn.type = "button";
            approveBtn.className = "newflow-hitl-btn newflow-hitl-approve";
            approveBtn.textContent = "✓ Approve";

            buttons.append(rejectBtn, approveBtn);

            root.append(preview, status, buttons);

            node.addDOMWidget("hitl_ui", "newflow_hitl", root, { serialize: false });

            const setButtonsVisible = (v) => {
                buttons.style.display = v ? "flex" : "none";
            };

            const setStatus = (text, state) => {
                status.textContent = text;
                status.dataset.state = state;
            };

            const renderImages = (images) => {
                preview.replaceChildren();
                if (!images || images.length === 0) {
                    const empty = document.createElement("div");
                    empty.className = "newflow-hitl-placeholder";
                    empty.textContent = "(no preview images)";
                    preview.appendChild(empty);
                    return;
                }
                for (const img of images) {
                    const el = document.createElement("img");
                    el.src = viewUrl(img);
                    el.alt = "preview";
                    el.draggable = false;
                    preview.appendChild(el);
                }
            };

            const decide = async (approved) => {
                rejectBtn.disabled = true;
                approveBtn.disabled = true;
                setStatus(approved ? "Approved — continuing…" : "Rejected — stopping…",
                          approved ? "approved" : "rejected");
                try {
                    const resp = await fetch("/newflow/hitl/decide", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            node_id: String(node.id),
                            approved,
                        }),
                    });
                    if (!resp.ok) {
                        const txt = await resp.text().catch(() => "");
                        setStatus(`Decision failed (HTTP ${resp.status})${txt ? ": " + txt : ""}`, "error");
                    }
                } catch (e) {
                    setStatus(`Decision failed: ${e.message || e}`, "error");
                } finally {
                    setButtonsVisible(false);
                    rejectBtn.disabled = false;
                    approveBtn.disabled = false;
                }
            };

            rejectBtn.addEventListener("click", () => decide(false));
            approveBtn.addEventListener("click", () => decide(true));

            // Initial UI state
            setButtonsVisible(false);
            setStatus("idle", "idle");

            const hooks = {
                showAwaiting(images) {
                    renderImages(images);
                    setStatus("Awaiting decision…", "awaiting");
                    setButtonsVisible(true);
                    rejectBtn.disabled = false;
                    approveBtn.disabled = false;
                    node.setDirtyCanvas(true, true);
                },
                showSettled(outcome) {
                    setButtonsVisible(false);
                    if (outcome === "approved") setStatus("Approved", "approved");
                    else if (outcome === "rejected") setStatus("Rejected", "rejected");
                    else if (outcome === "timeout") setStatus("Timed out", "error");
                    else setStatus(outcome || "settled", "idle");
                    node.setDirtyCanvas(true, true);
                },
            };
            NODE_HOOKS.set(node, hooks);

            const origRemoved = node.onRemoved;
            node.onRemoved = function () {
                NODE_HOOKS.delete(node);
                origRemoved?.apply(this, arguments);
            };
        };
    },
});
