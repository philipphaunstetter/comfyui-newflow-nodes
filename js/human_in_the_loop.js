import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NewflowHumanInTheLoop";
const MIN_WIDTH = 320;
const REASON_WIDGET_PREFIX = "rejection_reason_";

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

// Read rejection reason labels from the node's widgets.
// Returns an array of { index, label } for non-empty reasons only.
function getRejectionReasons(node) {
    const reasons = [];
    if (!node.widgets) return reasons;
    for (const w of node.widgets) {
        if (!w.name?.startsWith(REASON_WIDGET_PREFIX)) continue;
        const slotStr = w.name.slice(REASON_WIDGET_PREFIX.length);
        const slot = parseInt(slotStr, 10);
        if (!Number.isFinite(slot)) continue;
        const label = (w.value ?? "").trim();
        if (label) reasons.push({ index: slot - 1, label });
    }
    return reasons;
}

api.addEventListener("newflow.hitl.awaiting", (event) => {
    const detail = event.detail || {};
    const hooks = findHooksByNodeId(detail.node_id);
    if (!hooks) return;
    hooks.showAwaiting(detail.images || [], detail.labels || []);
});

api.addEventListener("newflow.hitl.settled", (event) => {
    const detail = event.detail || {};
    const hooks = findHooksByNodeId(detail.node_id);
    if (!hooks) return;
    hooks.showSettled(detail.outcome || "", detail.reason || "");
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

            const approveBtn = document.createElement("button");
            approveBtn.type = "button";
            approveBtn.className = "newflow-hitl-btn newflow-hitl-approve";
            approveBtn.textContent = "✓ Approve";

            root.append(preview, status, buttons);

            node.addDOMWidget("hitl_ui", "newflow_hitl", root, { serialize: false });

            const setButtonsVisible = (v) => {
                buttons.style.display = v ? "flex" : "none";
            };

            const setStatus = (text, state) => {
                status.textContent = text;
                status.dataset.state = state;
            };

            const setAllDisabled = (disabled) => {
                for (const btn of buttons.querySelectorAll("button")) {
                    btn.disabled = disabled;
                }
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

            const decide = async (approved, reasonIndex, reasonLabel) => {
                setAllDisabled(true);
                const statusText = approved
                    ? "Approved — continuing…"
                    : `Rejected (${reasonLabel}) — routing…`;
                setStatus(statusText, approved ? "approved" : "rejected");
                try {
                    const resp = await fetch("/newflow/hitl/decide", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            node_id: String(node.id),
                            approved,
                            reason_index: reasonIndex,
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
                    setAllDisabled(false);
                }
            };

            // Initial UI state
            setButtonsVisible(false);
            setStatus("idle", "idle");

            const hooks = {
                showAwaiting(images, serverLabels) {
                    renderImages(images);
                    setStatus("Awaiting decision…", "awaiting");

                    // Rebuild rejection buttons from current widget values.
                    // Fall back to server-sent labels if widgets aren't populated yet.
                    buttons.replaceChildren();

                    const reasons = getRejectionReasons(node);
                    if (reasons.length === 0 && serverLabels) {
                        serverLabels.forEach((lbl, i) => {
                            if (lbl.trim()) reasons.push({ index: i, label: lbl.trim() });
                        });
                    }

                    if (reasons.length === 0) {
                        // No reasons configured — single generic reject button.
                        const rejectBtn = document.createElement("button");
                        rejectBtn.type = "button";
                        rejectBtn.className = "newflow-hitl-btn newflow-hitl-reject";
                        rejectBtn.textContent = "✕ Reject";
                        rejectBtn.addEventListener("click", () => decide(false, 0, "Rejected"));
                        buttons.appendChild(rejectBtn);
                    } else {
                        for (const { index, label } of reasons) {
                            const btn = document.createElement("button");
                            btn.type = "button";
                            btn.className = "newflow-hitl-btn newflow-hitl-reject newflow-hitl-reason-btn";
                            btn.textContent = `✕ ${label}`;
                            btn.addEventListener("click", () => decide(false, index, label));
                            buttons.appendChild(btn);
                        }
                    }

                    buttons.appendChild(approveBtn);
                    approveBtn.disabled = false;
                    approveBtn.onclick = () => decide(true, 0, "");

                    setButtonsVisible(true);
                    node.setDirtyCanvas(true, true);
                },
                showSettled(outcome, reason) {
                    setButtonsVisible(false);
                    if (outcome === "approved") {
                        setStatus("Approved", "approved");
                    } else if (outcome === "rejected") {
                        setStatus(reason ? `Rejected — ${reason}` : "Rejected", "rejected");
                    } else if (outcome === "timeout") {
                        setStatus("Timed out", "error");
                    } else {
                        setStatus(outcome || "settled", "idle");
                    }
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
