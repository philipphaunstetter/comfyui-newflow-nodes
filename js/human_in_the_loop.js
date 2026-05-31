// Newflow Human in the Loop — v2 frontend.
//
// Renders a per-image card grid for human review with user-managed rejection
// reasons. Each reason corresponds to one REJECTED_N output socket; the JS
// hides/shows those sockets via addOutput/removeOutput and rewrites their
// display names to the user's labels. REJECTION_REASON sits at schema idx 1
// (fixed position) so heterogeneous types never collide with hidden REJECTED
// IMAGE slots. (ComfyUI maps the i-th visible socket to schema idx i; only
// the REJECTED tail is variable.)
//
// State lives in a single `reasons_state` DOM widget (serialize: true) whose
// JSON is read in Python from `cls.hidden.prompt`. Per-image `decisions` are
// runtime-only, never serialized.
//
// Migration (beforeConfigureGraph):
//   - widget shape: v1 saved up to 4 string widgets (rejection_reason_1..4);
//     v2 saves a single JSON string. The shim reshapes widgets_values and
//     synthesizes placeholder reasons for any wired-but-empty v1 slot so
//     existing downstream wires survive.
//   - link slot indices: v1 outputs were [APPROVED, REJECTED_1..4,
//     REJECTION_REASON]; v2 is [APPROVED, REJECTION_REASON, REJECTED_1..16].
//     Every link from a v1-shaped HITL node has its origin_slot remapped
//     (slot 5 → 1; slots 1..4 → 2..5 modulo dropped-empty compaction).

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NewflowHumanInTheLoop";
const REASONS_WIDGET = "reasons_state";
const MAX_REJECTION_SLOTS = 16; // mirrors MAX_REJECTION_SLOTS in human_in_the_loop.py
const FIXED_OUTPUT_OFFSET = 2;  // APPROVED + REJECTION_REASON live before the REJECTED tail
const MIN_WIDTH = 360;
const NARROW_THRESHOLD = 260;
const SEGMENTED_THRESHOLD = 3; // 1-3 reasons render as labeled/segmented; 4+ as split-button popover

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./human_in_the_loop.css", import.meta.url).href;
document.head.appendChild(css);

const uid = () => "r_" + Math.random().toString(36).slice(2, 10);

const viewUrl = (img) => {
    if (!img || !img.filename) return "";
    const params = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || "",
        type: img.type || "temp",
    });
    return `/view?${params.toString()}`;
};

// ----- reasons (de)serialization ------------------------------------------

function normalizeReason(entry) {
    if (!entry || typeof entry !== "object") return null;
    const id = typeof entry.id === "string" && entry.id ? entry.id : null;
    if (!id) return null;
    const label = typeof entry.label === "string" ? entry.label : "";
    return { id, label };
}

function deserializeReasons(v) {
    if (Array.isArray(v)) return v.map(normalizeReason).filter(Boolean).slice(0, MAX_REJECTION_SLOTS);
    if (!v || typeof v !== "string") return [];
    try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) {
            return parsed.map(normalizeReason).filter(Boolean).slice(0, MAX_REJECTION_SLOTS);
        }
    } catch {
        /* fall through */
    }
    return [];
}

const serializeReasons = (reasons) => JSON.stringify(reasons);

// ----- shared lookup keyed by node object ---------------------------------

const NODE_HOOKS = new WeakMap();

const findHooksByNodeId = (rawId) => {
    const id = typeof rawId === "string" ? parseInt(rawId, 10) : Number(rawId);
    if (!Number.isFinite(id)) return null;
    const node = app.graph?.getNodeById?.(id);
    if (!node) return null;
    return NODE_HOOKS.get(node) || null;
};

// ----- capture-phase keyboard shield --------------------------------------
// Prevents ComfyUI canvas shortcuts (R = rotate, etc.) from firing while the
// user is typing in the reasons editor. We only shield typing contexts here
// — card-focused keys (A/R/1-9/Esc/U/Space) have their own per-event
// stopPropagation inside the grid handler, after they're consumed.
const isTypingInsideHitl = (target) =>
    target instanceof Element &&
    target.closest(".newflow-hitl-reason-label-input") != null;

["keydown", "keyup", "keypress", "copy", "cut", "paste"].forEach((evt) => {
    document.addEventListener(
        evt,
        (e) => {
            if (isTypingInsideHitl(e.target)) e.stopPropagation();
        },
        true,
    );
});

// =========================================================================
// Migration shim — runs before ComfyUI builds the graph.
// =========================================================================

const asJsonArray = (s) => {
    if (typeof s !== "string") return null;
    try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

function isV2Shape(widgetsValues) {
    if (!Array.isArray(widgetsValues) || widgetsValues.length !== 1) return false;
    const arr = asJsonArray(widgetsValues[0]);
    if (!arr) return false;
    // v2 entries are {id: string, label: string}. We accept any array with
    // at least one entry shaped that way as already-v2.
    return arr.length === 0 || arr.every((e) => e && typeof e.id === "string");
}

// v1 output layout: 0=APPROVED, 1..4=REJECTED_1..4, 5=REJECTION_REASON.
// v2 output layout: 0=APPROVED, 1=REJECTION_REASON, 2..17=REJECTED_1..16.
// We remap link origin_slot per v1 slot, with compaction: empty-and-unwired
// v1 slots are dropped from the reasons list, which shifts subsequent slots
// down in v2.
function migrateHitlNode(node, links) {
    const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    if (isV2Shape(wv)) return; // idempotent

    const oldLabels = [];
    for (let i = 0; i < 4; i++) {
        oldLabels.push(typeof wv[i] === "string" ? wv[i] : "");
    }

    // Discover which v1 REJECTED slots (1..4) and REJECTION_REASON (5) are
    // wired downstream — we use this to keep wired-but-empty slots in the
    // reasons list as synthesized placeholders.
    const wiredV1Slots = new Set();
    if (Array.isArray(links)) {
        for (const link of links) {
            if (!Array.isArray(link) || link.length < 4) continue;
            const originId = link[1];
            const originSlot = link[2];
            if (originId !== node.id) continue;
            if (typeof originSlot === "number") wiredV1Slots.add(originSlot);
        }
    }

    // Build the v2 reasons array in v1 slot order, dropping empty-and-unwired
    // slots. Track each kept v1 slot's new index so we can remap links.
    const reasons = [];
    const v1SlotToV2Index = new Map(); // v1 slot (1..4) → kept index (0-based)
    for (let i = 0; i < 4; i++) {
        const labelRaw = oldLabels[i] || "";
        const label = labelRaw.trim();
        const wired = wiredV1Slots.has(i + 1);
        if (!label && !wired) continue;
        v1SlotToV2Index.set(i + 1, reasons.length);
        reasons.push({ id: uid(), label: label || `Reason ${i + 1}` });
    }
    if (reasons.length === 0) {
        reasons.push({ id: uid(), label: "Reason 1" });
    }

    node.widgets_values = [serializeReasons(reasons)];

    // Remap link origin_slot values for every link originating from this
    // node. v1 slot N (1..4) → 2 + v1SlotToV2Index.get(N); v1 slot 5 → 1.
    // Untouched: 0 (APPROVED) and any unrecognized slot.
    if (Array.isArray(links)) {
        for (const link of links) {
            if (!Array.isArray(link) || link.length < 4) continue;
            if (link[1] !== node.id) continue;
            const slot = link[2];
            if (slot === 5) {
                link[2] = 1;
            } else if (typeof slot === "number" && v1SlotToV2Index.has(slot)) {
                link[2] = FIXED_OUTPUT_OFFSET + v1SlotToV2Index.get(slot);
            }
        }
    }
}

// =========================================================================
// Output socket sync
// =========================================================================

// Write the user's label to every display field a LiteGraph / ComfyUI
// renderer might read. `name` is the canonical slot name; `localized_name`
// is the i18n override ComfyUI sets from the schema (and which wins over
// `name` at render time, so we MUST overwrite it or schema-declared sockets
// keep showing their original "REJECTED_N" labels); `label` is the newer
// LiteGraph display override.
function setOutputDisplay(out, label) {
    if (!out) return;
    out.name = label;
    out.localized_name = label;
    out.label = label;
}

// Reconcile node.outputs to exactly [APPROVED, REJECTION_REASON, REJECTED_<r0>,
// ..., REJECTED_<rN-1>]. Tail-only mutations (add/remove at end) so existing
// link slot indices don't shift.
function syncRejectedOutputs(node, reasons) {
    const desiredCount = FIXED_OUTPUT_OFFSET + reasons.length;
    const outputs = node.outputs || [];

    // Trim trailing REJECTED slots beyond the desired count.
    while (outputs.length > desiredCount) {
        try {
            node.removeOutput(outputs.length - 1);
        } catch {
            break; // node already torn down
        }
    }

    // Append new REJECTED slots if we're short. The schema declared
    // MAX_REJECTION_SLOTS so addOutput maps positionally to REJECTED_<i+1>.
    while (outputs.length < desiredCount) {
        const reasonIdx = outputs.length - FIXED_OUTPUT_OFFSET;
        const label = reasons[reasonIdx]?.label || `REJECTED_${reasonIdx + 1}`;
        node.addOutput(label, "IMAGE");
        setOutputDisplay(outputs[outputs.length - 1], label);
    }

    // Update display names on the live REJECTED sockets.
    for (let i = 0; i < reasons.length; i++) {
        const label = reasons[i].label || `REJECTED_${i + 1}`;
        setOutputDisplay(outputs[FIXED_OUTPUT_OFFSET + i], label);
    }

    // Slot widths depend on label length — invalidate cached size so the
    // node re-measures and the new labels render at the right width.
    if (typeof node.setSize === "function" && typeof node.computeSize === "function") {
        node.setSize(node.computeSize());
    }
    node.setDirtyCanvas?.(true, true);
}

// Detect downstream wires on a particular REJECTED slot. Used by the remove
// confirm prompt.
function rejectedSlotLinkCount(node, reasonIdx) {
    const out = node.outputs?.[FIXED_OUTPUT_OFFSET + reasonIdx];
    return Array.isArray(out?.links) ? out.links.length : 0;
}

// =========================================================================
// Reasons editor
// =========================================================================

function renderReasonsEditor(root, ctx) {
    root.replaceChildren();
    root.className = "newflow-hitl-reasons";

    const header = document.createElement("div");
    header.className = "newflow-hitl-reasons-header";
    const titleEl = document.createElement("span");
    titleEl.textContent = `Rejection reasons (${ctx.reasons.length}/${MAX_REJECTION_SLOTS})`;
    header.appendChild(titleEl);
    root.appendChild(header);

    const rows = document.createElement("div");
    rows.className = "newflow-hitl-reason-rows";

    ctx.reasons.forEach((reason, idx) => {
        const row = document.createElement("div");
        row.className = "newflow-hitl-reason-row";

        // Label input. Commit on blur or Enter; reorder is intentionally
        // not supported in v2 (would either silently re-route downstream
        // wires or require expensive link bookkeeping; out of scope).
        const handle = document.createElement("span");
        handle.className = "newflow-hitl-reason-handle";
        handle.textContent = "≡";
        handle.title = "Reorder is not supported — delete and re-add reasons in the desired order.";
        row.appendChild(handle);

        const input = document.createElement("input");
        input.type = "text";
        input.className = "newflow-hitl-reason-label-input";
        input.value = reason.label;
        input.placeholder = `Reason ${idx + 1}`;
        input.maxLength = 64;
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                input.blur();
            } else if (e.key === "Escape") {
                e.preventDefault();
                input.value = reason.label;
                input.blur();
            }
        });
        input.addEventListener("change", () => {
            const next = input.value.replace(/[\r\n]/g, " ").trim();
            if (next === reason.label) return;
            reason.label = next;
            ctx.onReasonsChanged();
            ctx.renderAll(); // refresh chip labels + card buttons
        });
        row.appendChild(input);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "newflow-hitl-reason-delete";
        del.textContent = "×";
        del.title = "Remove this reason";
        del.addEventListener("click", () => {
            ctx.removeReasonAt(idx);
        });
        row.appendChild(del);

        rows.appendChild(row);
    });

    root.appendChild(rows);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "newflow-hitl-reason-add";
    addBtn.textContent = "+ Add reason";
    if (ctx.reasons.length >= MAX_REJECTION_SLOTS) {
        addBtn.disabled = true;
        addBtn.title = `Maximum ${MAX_REJECTION_SLOTS} reasons per node — split into multiple HITL nodes for more.`;
    }
    addBtn.addEventListener("click", () => {
        ctx.addReason();
    });
    root.appendChild(addBtn);
}

// =========================================================================
// Reject reason popover (4+ reasons: shown when caret clicked)
// =========================================================================

function dismissActivePopover() {
    for (const el of document.querySelectorAll(".newflow-hitl-popover")) {
        el.remove();
    }
}

function showReasonPopover(anchor, reasons, onPick) {
    dismissActivePopover();
    const pop = document.createElement("div");
    pop.className = "newflow-hitl-popover";
    reasons.forEach((reason, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        const hk = document.createElement("span");
        hk.className = "hotkey";
        hk.textContent = i < 9 ? `${i + 1}.` : "";
        btn.appendChild(hk);
        btn.appendChild(document.createTextNode(` ${reason.label || `Reason ${i + 1}`}`));
        btn.addEventListener("click", () => {
            dismissActivePopover();
            onPick(reason.id);
        });
        pop.appendChild(btn);
    });

    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const desiredLeft = rect.left;
    const popWidth = pop.offsetWidth;
    const left = Math.min(desiredLeft, window.innerWidth - popWidth - 8);
    const top = rect.bottom + 4;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;

    const dismissOnClick = (e) => {
        if (!pop.contains(e.target)) {
            dismissActivePopover();
            window.removeEventListener("mousedown", dismissOnClick, true);
            window.removeEventListener("keydown", dismissOnKey, true);
        }
    };
    const dismissOnKey = (e) => {
        if (e.key === "Escape") {
            dismissActivePopover();
            window.removeEventListener("mousedown", dismissOnClick, true);
            window.removeEventListener("keydown", dismissOnKey, true);
        }
    };
    setTimeout(() => {
        window.addEventListener("mousedown", dismissOnClick, true);
        window.addEventListener("keydown", dismissOnKey, true);
    }, 0);
}

// =========================================================================
// Lightbox
// =========================================================================

function showLightbox(src) {
    const lb = document.createElement("div");
    lb.className = "newflow-hitl-lightbox";
    const img = document.createElement("img");
    img.src = src;
    img.draggable = false;
    lb.appendChild(img);
    const close = () => {
        lb.remove();
        window.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            close();
        }
    };
    lb.addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(lb);
}

// =========================================================================
// Card grid
// =========================================================================

function truncateLabel(text, maxLen) {
    if (!text) return "Rejected";
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + "…";
}

function firstWord(text, maxLen) {
    const word = (text || "").split(/\s+/)[0] || "";
    return truncateLabel(word, maxLen);
}

function renderCardGrid(host, ctx) {
    host.replaceChildren();

    if (!ctx.awaiting) {
        const placeholder = document.createElement("div");
        placeholder.className = "newflow-hitl-placeholder";
        placeholder.textContent = "Run workflow — images will appear here for review.";
        host.appendChild(placeholder);
        return;
    }

    if (!ctx.images.length) {
        const empty = document.createElement("div");
        empty.className = "newflow-hitl-placeholder";
        empty.textContent = "(no preview images)";
        host.appendChild(empty);
        return;
    }

    const grid = document.createElement("div");
    grid.className = "newflow-hitl-grid";

    ctx.images.forEach((img, idx) => {
        grid.appendChild(buildCard(img, idx, ctx));
    });

    host.appendChild(grid);
}

function buildCard(img, idx, ctx) {
    const decision = ctx.decisions.get(idx) || { state: "undecided", reason_id: null };
    const card = document.createElement("div");
    card.className = "newflow-hitl-card";
    card.dataset.state = decision.state;
    if (decision.reason_id) card.dataset.reasonId = decision.reason_id;
    card.tabIndex = 0;
    card.dataset.imageIndex = String(idx);

    // Thumbnail (click → lightbox)
    const thumb = document.createElement("div");
    thumb.className = "newflow-hitl-card-thumb";
    const url = viewUrl(img);
    const imgEl = document.createElement("img");
    imgEl.loading = "lazy";
    imgEl.src = url;
    imgEl.alt = `image ${idx + 1}`;
    imgEl.draggable = false;
    thumb.appendChild(imgEl);
    thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        showLightbox(url);
    });

    // Status chip
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "newflow-hitl-status-chip";
    chip.dataset.state = decision.state;
    chip.title = "Click to clear this card's decision";
    if (decision.state === "undecided") {
        chip.textContent = "○";
    } else if (decision.state === "approved") {
        chip.textContent = "✓";
    } else {
        const label = ctx.findReasonLabel(decision.reason_id);
        chip.textContent = `✕ ${truncateLabel(label, 18)}`;
    }
    chip.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.setDecision(idx, { state: "undecided", reason_id: null });
    });
    thumb.appendChild(chip);
    card.appendChild(thumb);

    // Decision bar
    const bar = document.createElement("div");
    bar.className = "newflow-hitl-card-bar";

    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "newflow-hitl-btn newflow-hitl-approve";
    approveBtn.textContent = "✓ Approve";
    approveBtn.addEventListener("click", () => {
        if (decision.state === "approved") {
            ctx.setDecision(idx, { state: "undecided", reason_id: null });
        } else {
            ctx.setDecision(idx, { state: "approved", reason_id: null });
        }
    });
    bar.appendChild(approveBtn);

    bar.appendChild(buildRejectControl(idx, decision, ctx));
    card.appendChild(bar);

    // Footer (frame index)
    const footer = document.createElement("div");
    footer.className = "newflow-hitl-card-footer";
    footer.textContent = `${idx + 1} / ${ctx.images.length}`;
    card.appendChild(footer);

    return card;
}

function buildRejectControl(idx, decision, ctx) {
    const reasons = ctx.reasons;

    if (reasons.length === 0) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "newflow-hitl-btn newflow-hitl-reject";
        btn.textContent = "✕ Reject";
        btn.addEventListener("click", () => {
            ctx.setDecision(idx, { state: "rejected", reason_id: null });
        });
        return btn;
    }

    if (reasons.length === 1) {
        const r = reasons[0];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "newflow-hitl-btn newflow-hitl-reject";
        btn.textContent = `✕ ${truncateLabel(r.label, 14)}`;
        btn.title = r.label;
        btn.addEventListener("click", () => {
            ctx.setDecision(idx, { state: "rejected", reason_id: r.id });
        });
        return btn;
    }

    if (reasons.length <= SEGMENTED_THRESHOLD) {
        const wrap = document.createElement("div");
        wrap.className = "newflow-hitl-reject-segmented";
        reasons.forEach((r) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "newflow-hitl-btn newflow-hitl-reject";
            btn.textContent = `✕ ${firstWord(r.label, 8)}`;
            btn.title = r.label;
            btn.addEventListener("click", () => {
                ctx.setDecision(idx, { state: "rejected", reason_id: r.id });
            });
            wrap.appendChild(btn);
        });
        return wrap;
    }

    // 4+ reasons: split-button. Main click uses the sticky default; caret
    // opens the popover with numeric hotkeys.
    const wrap = document.createElement("div");
    wrap.className = "newflow-hitl-reject-split";

    const stickyReason =
        reasons.find((r) => r.id === ctx.stickyDefault()) || reasons[0];
    const main = document.createElement("button");
    main.type = "button";
    main.className = "newflow-hitl-reject";
    main.textContent = `✕ ${truncateLabel(stickyReason.label, 14)}`;
    main.title = stickyReason.label;
    main.addEventListener("click", () => {
        if (ctx.stickyDefault()) {
            ctx.setDecision(idx, { state: "rejected", reason_id: stickyReason.id });
        } else {
            showReasonPopover(main, reasons, (rid) => {
                ctx.setDecision(idx, { state: "rejected", reason_id: rid });
            });
        }
    });
    wrap.appendChild(main);

    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "newflow-hitl-reject-caret";
    caret.textContent = "▾";
    caret.title = "Pick a different reason";
    caret.addEventListener("click", (e) => {
        e.stopPropagation();
        showReasonPopover(caret, reasons, (rid) => {
            ctx.setDecision(idx, { state: "rejected", reason_id: rid });
        });
    });
    wrap.appendChild(caret);

    return wrap;
}

// =========================================================================
// Bulk bar + submit
// =========================================================================

function renderBulkBar(bar, ctx) {
    bar.replaceChildren();

    const counts = countDecisions(ctx);

    const approveAll = document.createElement("button");
    approveAll.type = "button";
    approveAll.className = "newflow-hitl-bulk-approve";
    approveAll.textContent = "✓ Approve all undecided";
    approveAll.disabled = counts.undecided === 0;
    if (counts.undecided > 0 && counts.decided > 0 && counts.decided < counts.total) {
        approveAll.classList.add("pulse");
    }
    approveAll.addEventListener("click", () => {
        ctx.bulkApproveUndecided();
    });
    bar.appendChild(approveAll);

    if (ctx.reasons.length > 0) {
        const wrap = document.createElement("div");
        wrap.className = "newflow-hitl-bulk-reject-wrap";

        const stickyReason =
            ctx.reasons.find((r) => r.id === ctx.stickyDefault()) || ctx.reasons[0];

        const main = document.createElement("button");
        main.type = "button";
        main.className = "newflow-hitl-bulk-reject";
        main.textContent = `✕ Reject undecided — ${truncateLabel(stickyReason.label, 14)}`;
        main.disabled = counts.undecided === 0;
        main.title = stickyReason.label;
        main.addEventListener("click", () => {
            ctx.bulkRejectUndecided(stickyReason.id);
        });
        wrap.appendChild(main);

        const caret = document.createElement("button");
        caret.type = "button";
        caret.className = "newflow-hitl-bulk-reject-caret";
        caret.textContent = "▾";
        caret.disabled = counts.undecided === 0;
        caret.addEventListener("click", (e) => {
            e.stopPropagation();
            showReasonPopover(caret, ctx.reasons, (rid) => {
                ctx.bulkRejectUndecided(rid);
            });
        });
        wrap.appendChild(caret);

        bar.appendChild(wrap);
    }

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "newflow-hitl-bulk-reset";
    reset.textContent = "Reset all";
    reset.disabled = counts.decided === 0;
    let armed = false;
    let armTimer = null;
    reset.addEventListener("click", () => {
        if (!armed) {
            armed = true;
            reset.textContent = `Click again to reset ${counts.decided} decision(s)`;
            armTimer = setTimeout(() => {
                armed = false;
                reset.textContent = "Reset all";
            }, 3000);
        } else {
            clearTimeout(armTimer);
            ctx.bulkReset();
        }
    });
    bar.appendChild(reset);

    const counter = document.createElement("div");
    counter.className = "newflow-hitl-bulk-counter";
    const a = document.createElement("span");
    a.className = "count-approved";
    a.textContent = `${counts.approved} approved`;
    const r = document.createElement("span");
    r.className = "count-rejected";
    r.textContent = `${counts.rejected} rejected`;
    const u = document.createElement("span");
    u.className = "count-undecided";
    u.textContent = `${counts.undecided} undecided`;
    counter.append(a, r, u);
    bar.appendChild(counter);
}

function countDecisions(ctx) {
    let approved = 0;
    let rejected = 0;
    for (let i = 0; i < ctx.images.length; i++) {
        const d = ctx.decisions.get(i);
        if (d?.state === "approved") approved++;
        else if (d?.state === "rejected") rejected++;
    }
    const total = ctx.images.length;
    const decided = approved + rejected;
    return { approved, rejected, undecided: total - decided, decided, total };
}

function renderSubmit(bar, ctx) {
    bar.replaceChildren();
    const counts = countDecisions(ctx);
    const allDecided = counts.decided === counts.total && counts.total > 0;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "newflow-hitl-submit";
    btn.textContent =
        ctx.submitState === "submitting"
            ? "Submitting…"
            : `Submit decisions (${counts.decided} / ${counts.total})`;
    btn.disabled = !allDecided || ctx.submitState === "submitting" || !ctx.awaiting;
    btn.addEventListener("click", () => {
        ctx.submit();
    });
    bar.appendChild(btn);

    const helper = document.createElement("div");
    helper.className = "newflow-hitl-submit-helper";
    if (!ctx.awaiting) {
        helper.textContent = "";
    } else if (!allDecided) {
        helper.textContent = `Decide the remaining ${counts.undecided} image(s) to submit`;
    }
    bar.appendChild(helper);
}

// =========================================================================
// Top-level extension registration
// =========================================================================

api.addEventListener("newflow.hitl.awaiting", (event) => {
    const detail = event.detail || {};
    const hooks = findHooksByNodeId(detail.node_id);
    if (!hooks) return;
    hooks.onAwaiting(detail);
});

api.addEventListener("newflow.hitl.settled", (event) => {
    const detail = event.detail || {};
    const hooks = findHooksByNodeId(detail.node_id);
    if (!hooks) return;
    hooks.onSettled(detail);
});

app.registerExtension({
    name: "newflow.human_in_the_loop",

    async beforeConfigureGraph(graphData) {
        if (!graphData || !Array.isArray(graphData.nodes)) return;
        const links = Array.isArray(graphData.links) ? graphData.links : null;
        for (const node of graphData.nodes) {
            if (node?.type !== NODE_NAME) continue;
            migrateHitlNode(node, links);
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (out) {
            const r = origComputeSize?.call(this, out) || [0, 0];
            if (r[0] < MIN_WIDTH) r[0] = MIN_WIDTH;
            return r;
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            installHitlNode(this);
        };
    },
});

// =========================================================================
// installHitlNode — per-node setup
// =========================================================================

function installHitlNode(node) {
    // ----- persistent state ------------------------------------------------
    let reasons = [{ id: uid(), label: "Reason 1" }];

    // ----- ephemeral runtime state ----------------------------------------
    let awaiting = false;
    let images = []; // [{image_id, image_index, filename, ...}]
    let decisions = new Map(); // image_index → {state, reason_id}
    let stickyDefaultId = null;
    let submitState = "idle"; // 'idle' | 'submitting'
    let lastRemovedSnapshot = null; // {reason, decisionsCopy} — 1-step undo for reason removal

    // ----- DOM scaffolding ------------------------------------------------
    const root = document.createElement("div");
    root.className = "newflow-hitl-root";

    const reasonsEditor = document.createElement("div");
    root.appendChild(reasonsEditor);

    const bulkBar = document.createElement("div");
    bulkBar.className = "newflow-hitl-bulk-bar";
    root.appendChild(bulkBar);

    const toastSlot = document.createElement("div");
    root.appendChild(toastSlot);

    const gridHost = document.createElement("div");
    gridHost.className = "newflow-hitl-grid-host";
    root.appendChild(gridHost);

    const status = document.createElement("div");
    status.className = "newflow-hitl-status";
    status.dataset.state = "idle";
    status.textContent = ""; // hidden via :empty until something settles
    root.appendChild(status);

    const submitBar = document.createElement("div");
    submitBar.className = "newflow-hitl-submit-bar";
    root.appendChild(submitBar);

    // ----- helpers --------------------------------------------------------

    const findReasonLabel = (id) => {
        if (!id) return "";
        const r = reasons.find((x) => x.id === id);
        return r ? r.label : "";
    };

    const stickyDefault = () => {
        // Sticky default is per-session: cleared on each new awaiting and
        // initialized lazily to reasons[0]?.id. Updated after each reject.
        if (!stickyDefaultId && reasons.length > 0) {
            stickyDefaultId = reasons[0].id;
        }
        return stickyDefaultId;
    };

    const showToast = (text, undoLabel, onUndo) => {
        toastSlot.replaceChildren();
        const toast = document.createElement("div");
        toast.className = "newflow-hitl-toast";
        toast.appendChild(document.createTextNode(text));
        if (undoLabel && onUndo) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = undoLabel;
            btn.addEventListener("click", () => {
                toast.remove();
                onUndo();
            });
            toast.appendChild(btn);
        }
        toastSlot.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
            // Clear the undo snapshot once the toast is gone.
            lastRemovedSnapshot = null;
        }, 8000);
    };

    const persistReasonsToWidget = () => {
        // The DOM widget value is what ComfyUI ships in the prompt. We
        // assign here so the next queue picks up live edits even before
        // the user clicks anywhere else.
        if (widget) widget.value = serializeReasons(reasons);
    };

    const setDecision = (imageIndex, next) => {
        if (!awaiting) return;
        if (next.state === "rejected" && next.reason_id) {
            stickyDefaultId = next.reason_id;
        }
        decisions.set(imageIndex, next);
        renderAll();
    };

    const findCard = (imageIndex) =>
        gridHost.querySelector(
            `.newflow-hitl-card[data-image-index="${imageIndex}"]`,
        );

    const pulseCard = (imageIndex) => {
        const el = findCard(imageIndex);
        if (!el) return;
        el.classList.add("pulse-amber");
        setTimeout(() => el.classList.remove("pulse-amber"), 1000);
    };

    const bulkApproveUndecided = () => {
        for (let i = 0; i < images.length; i++) {
            const d = decisions.get(i);
            if (!d || d.state === "undecided") {
                decisions.set(i, { state: "approved", reason_id: null });
            }
        }
        renderAll();
    };
    const bulkRejectUndecided = (reasonId) => {
        if (!reasonId) return;
        stickyDefaultId = reasonId;
        for (let i = 0; i < images.length; i++) {
            const d = decisions.get(i);
            if (!d || d.state === "undecided") {
                decisions.set(i, { state: "rejected", reason_id: reasonId });
            }
        }
        renderAll();
    };
    const bulkReset = () => {
        decisions.clear();
        renderAll();
    };

    const addReason = () => {
        if (reasons.length >= MAX_REJECTION_SLOTS) return;
        // Pick a default label that doesn't collide with existing labels.
        const used = new Set(reasons.map((r) => r.label));
        let n = reasons.length + 1;
        let label = `Reason ${n}`;
        while (used.has(label)) {
            n++;
            label = `Reason ${n}`;
        }
        reasons.push({ id: uid(), label });
        onReasonsChanged();
        renderAll();
    };

    const removeReasonAt = (idx) => {
        if (idx < 0 || idx >= reasons.length) return;
        const linkCount = rejectedSlotLinkCount(node, idx);
        if (linkCount > 0) {
            const ok = window.confirm(
                `This output is wired to ${linkCount} downstream node(s). Remove the reason anyway? The wires will be disconnected.`,
            );
            if (!ok) return;
        }

        // Snapshot for one-step undo BEFORE we mutate.
        const removed = reasons[idx];
        const decisionsCopy = new Map();
        for (const [k, v] of decisions.entries()) {
            decisionsCopy.set(k, { ...v });
        }
        lastRemovedSnapshot = {
            reasonsBefore: reasons.map((r) => ({ ...r })),
            decisions: decisionsCopy,
            stickyDefault: stickyDefaultId,
        };

        reasons.splice(idx, 1);
        // Per-card decisions that referenced the removed reason revert to
        // undecided so Submit re-disables (silent re-routing would corrupt
        // downstream data — see plan).
        const affected = [];
        for (let i = 0; i < images.length; i++) {
            const d = decisions.get(i);
            if (d?.state === "rejected" && d.reason_id === removed.id) {
                decisions.set(i, { state: "undecided", reason_id: null });
                affected.push(i);
            }
        }
        if (stickyDefaultId === removed.id) {
            stickyDefaultId = reasons[0]?.id || null;
        }

        onReasonsChanged();
        renderAll();

        for (const i of affected) pulseCard(i);

        if (awaiting && affected.length > 0) {
            showToast(
                `Reason "${removed.label}" was removed — ${affected.length} image(s) returned to undecided.`,
                "Undo",
                () => {
                    if (!lastRemovedSnapshot) return;
                    reasons = lastRemovedSnapshot.reasonsBefore.map((r) => ({ ...r }));
                    decisions = lastRemovedSnapshot.decisions;
                    stickyDefaultId = lastRemovedSnapshot.stickyDefault;
                    lastRemovedSnapshot = null;
                    onReasonsChanged();
                    renderAll();
                },
            );
        }
    };

    const onReasonsChanged = () => {
        // Cap defensively even if the editor logic forgets.
        if (reasons.length > MAX_REJECTION_SLOTS) {
            reasons.splice(MAX_REJECTION_SLOTS);
        }
        persistReasonsToWidget();
        syncRejectedOutputs(node, reasons);
    };

    const submit = async () => {
        if (!awaiting || submitState === "submitting") return;
        const counts = countDecisions(ctx);
        if (counts.decided !== counts.total) return;

        submitState = "submitting";
        renderAll();

        const payload = {
            node_id: String(node.id),
            decisions: Array.from({ length: images.length }, (_, i) => {
                const d = decisions.get(i) || { state: "undecided", reason_id: null };
                if (d.state === "approved") {
                    return { image_index: i, approved: true, reason_id: null };
                }
                return {
                    image_index: i,
                    approved: false,
                    reason_id: d.reason_id,
                };
            }),
        };

        try {
            const resp = await fetch("/newflow/hitl/decide", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) {
                const txt = await resp.text().catch(() => "");
                setStatus(
                    `Decision failed (HTTP ${resp.status})${txt ? ": " + txt : ""}`,
                    "error",
                );
                submitState = "idle";
                renderAll();
            }
        } catch (e) {
            setStatus(`Decision failed: ${e.message || e}`, "error");
            submitState = "idle";
            renderAll();
        }
    };

    const setStatus = (text, state) => {
        status.textContent = text;
        status.dataset.state = state;
    };

    // ----- ctx object passed into renderers -------------------------------
    const ctx = {
        get reasons() { return reasons; },
        get awaiting() { return awaiting; },
        get images() { return images; },
        get decisions() { return decisions; },
        get submitState() { return submitState; },
        stickyDefault,
        setDecision,
        findReasonLabel,
        bulkApproveUndecided,
        bulkRejectUndecided,
        bulkReset,
        submit,
        addReason,
        removeReasonAt,
        onReasonsChanged,
        renderAll: () => renderAll(),
    };

    // ----- single render entry point --------------------------------------
    const renderAll = () => {
        renderReasonsEditor(reasonsEditor, ctx);

        // Bulk bar + submit are only meaningful while awaiting a decision —
        // hide them when idle so the node body stays tidy.
        bulkBar.style.display = awaiting ? "" : "none";
        submitBar.style.display = awaiting ? "" : "none";
        gridHost.style.display = awaiting ? "" : "none";

        if (awaiting) {
            // Narrow node notice (rendered into the grid host).
            if (node.size && node.size[0] < NARROW_THRESHOLD) {
                gridHost.replaceChildren();
                const notice = document.createElement("div");
                notice.className = "newflow-hitl-narrow-notice";
                notice.appendChild(
                    document.createTextNode("Resize the node wider to review images."),
                );
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = "auto-resize";
                btn.addEventListener("click", () => {
                    node.setSize?.([480, node.size[1] || 600]);
                    renderAll();
                });
                notice.appendChild(btn);
                gridHost.appendChild(notice);
            } else {
                renderCardGrid(gridHost, ctx);
            }
            renderBulkBar(bulkBar, ctx);
            renderSubmit(submitBar, ctx);
        }
        node.setDirtyCanvas?.(true, true);
    };

    // ----- DOM widget (serializes reasons_state) --------------------------
    const widget = node.addDOMWidget(REASONS_WIDGET, "newflow_hitl", root, {
        serialize: true,
        getValue: () => serializeReasons(reasons),
        setValue: (v) => {
            reasons = deserializeReasons(v);
            if (reasons.length === 0) {
                reasons = [{ id: uid(), label: "Reason 1" }];
            }
            // Outputs are reconciled on configure (see below).
            renderAll();
        },
    });
    widget.computeSize = (w) => [w, Math.max(root.offsetHeight, 60)];

    // ----- onConfigure / reconcile outputs after load ---------------------
    const origOnConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = origOnConfigure?.apply(this, arguments);
        // widgets_values has already been applied (setValue ran). Now align
        // node.outputs to the active reason count.
        syncRejectedOutputs(node, reasons);
        requestAnimationFrame(() => {
            if (node.graph) {
                try { syncRejectedOutputs(node, reasons); } catch { /* gone */ }
            }
        });
        renderAll();
        return r;
    };

    // ----- onRemoved cleanup ----------------------------------------------
    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
        NODE_HOOKS.delete(node);
        origRemoved?.apply(this, arguments);
    };

    // ----- WS handlers ----------------------------------------------------

    const hooks = {
        onAwaiting(detail) {
            const incoming = Array.isArray(detail.images) ? detail.images : [];
            const incomingReasons = Array.isArray(detail.reasons) ? detail.reasons : null;

            // If the server's reasons list disagrees with ours (rare —
            // typically only when the workflow was queued before the editor
            // sync persisted), trust the server snapshot for this cycle so
            // the buttons match the routing.
            if (incomingReasons && incomingReasons.length > 0) {
                const serverIds = new Set(reasons.map((r) => r.id));
                let differs = incomingReasons.length !== reasons.length;
                if (!differs) {
                    for (const r of incomingReasons) {
                        if (!serverIds.has(r.id)) { differs = true; break; }
                    }
                }
                if (differs) {
                    reasons = incomingReasons.map(normalizeReason).filter(Boolean).slice(0, MAX_REJECTION_SLOTS);
                    onReasonsChanged();
                }
            }

            awaiting = true;
            images = incoming;
            decisions = new Map();
            submitState = "idle";
            stickyDefaultId = null; // per-session reset
            setStatus("Awaiting decisions…", "awaiting");
            renderAll();
        },

        onSettled(detail) {
            awaiting = false;
            submitState = "idle";
            const outcome = detail.outcome || "settled";
            const approved = detail.approved_count || 0;
            const rejectedCounts = detail.rejected_counts || {};
            const total = detail.total || images.length || 0;

            if (outcome === "timeout") {
                setStatus("Timed out", "error");
            } else if (outcome === "cancelled") {
                setStatus("Cancelled", "error");
            } else {
                const rejBits = Object.entries(rejectedCounts)
                    .map(([rid, n]) => `${n} as ${findReasonLabel(rid) || "?"}`)
                    .join(", ");
                const parts = [`${approved}/${total} approved`];
                if (rejBits) parts.push(rejBits);
                setStatus(parts.join(" · "), "settled");
            }
            // Keep the grid visible but locked so the user can review what
            // they sent.
            renderAll();
        },
    };
    NODE_HOOKS.set(node, hooks);

    // ----- keyboard navigation --------------------------------------------
    gridHost.addEventListener("keydown", (e) => {
        if (!awaiting) return;
        const focused = document.activeElement?.closest?.(".newflow-hitl-card");
        const focusedIdx = focused ? parseInt(focused.dataset.imageIndex, 10) : -1;

        if (focusedIdx < 0) {
            if (e.key.toLowerCase() === "a" && e.shiftKey) {
                e.preventDefault();
                bulkApproveUndecided();
            } else if (e.key.toLowerCase() === "r" && e.shiftKey) {
                e.preventDefault();
                if (reasons.length > 0) {
                    bulkRejectUndecided(stickyDefault() || reasons[0].id);
                }
            }
            return;
        }

        const refocus = (idx) =>
            requestAnimationFrame(() => findCard(idx)?.focus());

        if (e.key === "Enter" || e.key.toLowerCase() === "a") {
            e.preventDefault();
            const cur = decisions.get(focusedIdx);
            if (cur?.state === "approved") {
                setDecision(focusedIdx, { state: "undecided", reason_id: null });
                refocus(focusedIdx);
            } else {
                setDecision(focusedIdx, { state: "approved", reason_id: null });
                advanceFocus(focusedIdx);
            }
        } else if (e.key.toLowerCase() === "r") {
            e.preventDefault();
            const sticky = stickyDefault();
            if (sticky) {
                setDecision(focusedIdx, { state: "rejected", reason_id: sticky });
                advanceFocus(focusedIdx);
            } else if (reasons.length > 0) {
                setDecision(focusedIdx, { state: "rejected", reason_id: reasons[0].id });
                advanceFocus(focusedIdx);
            }
        } else if (/^[1-9]$/.test(e.key)) {
            e.preventDefault();
            const slot = parseInt(e.key, 10) - 1;
            if (slot < reasons.length) {
                setDecision(focusedIdx, { state: "rejected", reason_id: reasons[slot].id });
                advanceFocus(focusedIdx);
            }
        } else if (e.key === "Escape" || e.key === "Backspace" || e.key.toLowerCase() === "u") {
            e.preventDefault();
            setDecision(focusedIdx, { state: "undecided", reason_id: null });
            refocus(focusedIdx);
        } else if (e.key === " ") {
            e.preventDefault();
            const img = images[focusedIdx];
            if (img) showLightbox(viewUrl(img));
        }
    });

    const advanceFocus = (currentIdx) => {
        // Find the next undecided card after currentIdx; wrap around once.
        const tryIdx = (i) => {
            const d = decisions.get(i);
            return !d || d.state === "undecided";
        };
        for (let i = currentIdx + 1; i < images.length; i++) {
            if (tryIdx(i)) {
                requestAnimationFrame(() => findCard(i)?.focus());
                return;
            }
        }
        for (let i = 0; i < currentIdx; i++) {
            if (tryIdx(i)) {
                requestAnimationFrame(() => findCard(i)?.focus());
                return;
            }
        }
        // No undecided remaining — leave focus where it is.
    };

    // ----- initial render -------------------------------------------------
    syncRejectedOutputs(node, reasons);
    renderAll();

    // ComfyUI may re-instantiate schema-declared sockets right after
    // onNodeCreated returns; re-sync on the next frame so the trailing
    // REJECTED slots collapse back to the active count. Mirrors the same
    // pattern in js/image_batch.js.
    requestAnimationFrame(() => {
        if (node.graph) {
            try { syncRejectedOutputs(node, reasons); } catch { /* gone */ }
        }
    });
}
