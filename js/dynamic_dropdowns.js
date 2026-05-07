import { app } from "../../scripts/app.js";
import { applyIcon } from "./icons.js";
import { installPersistence } from "./_persistence.js";

const NODE_NAME = "NewflowDynamicDropdowns";
const WIDGET_NAME = "config";
const NONE = "(none)";

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./dynamic_dropdowns.css", import.meta.url).href;
document.head.appendChild(css);

const uid = () => "r" + Math.random().toString(36).slice(2, 9);

const serialize = (rows) => JSON.stringify(rows);
const deserialize = (v) => {
    if (Array.isArray(v)) return v;
    if (!v) return [];
    try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const parseOptionsString = (s) =>
    (s || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

const GROUP_COLORS = [
    { name: "None",   value: null },
    { name: "Red",    value: "#ef4444" },
    { name: "Orange", value: "#f97316" },
    { name: "Yellow", value: "#eab308" },
    { name: "Green",  value: "#22c55e" },
    { name: "Teal",   value: "#14b8a6" },
    { name: "Blue",   value: "#3b82f6" },
    { name: "Purple", value: "#a855f7" },
    { name: "Pink",   value: "#ec4899" },
];

const COLOR_ORDER = new Map(GROUP_COLORS.map((c, i) => [c.value, i]));

const EXPORT_VERSION = 1;

const EXAMPLE_PAYLOAD = {
    version: EXPORT_VERSION,
    rows: [
        { id: "ex1", label: "Hair Length",  options: ["Short", "Shoulder length", "Long"],            selected: "Shoulder length", locked: false, color: "#3b82f6" },
        { id: "ex2", label: "Hair Color",   options: ["Black", "Blonde", "Strawberry Blond", "Red"],  selected: "Strawberry Blond", locked: false, color: "#3b82f6" },
        { id: "ex3", label: "Eye Color",    options: ["Brown", "Blue", "Green", "Light Blue"],        selected: "Light Blue",       locked: true,  color: "#22c55e" },
        { id: "ex4", label: "Skin Tone",    options: ["Fair", "Medium", "Olive", "Dark"],             selected: "Fair",             locked: false, color: "#22c55e" },
        { id: "ex5", label: "Body Shape",   options: ["Slim", "Athletic Build", "Curvy"],             selected: "Athletic Build",   locked: false, color: "#a855f7" },
        { id: "ex6", label: "Mood",         options: ["Happy", "Serious", "Pensive"],                 selected: "(none)",           locked: false, color: null },
    ],
};

function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function normalizeImportedRows(data) {
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data?.rows)) arr = data.rows;
    if (!arr) throw new Error("Expected an array of rows or an object like { rows: [...] }.");

    return arr
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
            id: typeof r.id === "string" && r.id ? r.id : uid(),
            label: typeof r.label === "string" ? r.label : "",
            options: Array.isArray(r.options)
                ? r.options.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim())
                : [],
            selected: typeof r.selected === "string" ? r.selected : NONE,
            locked: !!r.locked,
            color: typeof r.color === "string" && r.color.startsWith("#") ? r.color : null,
        }));
}

function confirmModal({ title, message, confirmText = "Confirm", danger = false }) {
    return new Promise((resolve) => {
        const dlg = document.createElement("dialog");
        dlg.className = "newflow-dd-dialog";
        dlg.innerHTML = `
            <form method="dialog" class="newflow-dd-form">
                <h3></h3>
                <p class="newflow-dd-confirm-msg"></p>
                <div class="newflow-dd-dialog-actions">
                    <span style="flex:1"></span>
                    <button type="button" data-action="cancel">Cancel</button>
                    <button type="submit" data-action="confirm" class="${danger ? "newflow-dd-danger-btn" : "newflow-dd-primary"}"></button>
                </div>
            </form>
        `;
        dlg.querySelector("h3").textContent = title;
        dlg.querySelector(".newflow-dd-confirm-msg").textContent = message;
        dlg.querySelector('[data-action="confirm"]').textContent = confirmText;

        let result = false;
        dlg.querySelector('[data-action="cancel"]').addEventListener("click", () => dlg.close());
        dlg.querySelector("form").addEventListener("submit", (e) => {
            e.preventDefault();
            result = true;
            dlg.close();
        });
        dlg.addEventListener("close", () => {
            dlg.remove();
            resolve(result);
        });

        document.body.appendChild(dlg);
        dlg.showModal();
    });
}

function pickJsonFile() {
    return new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    resolve(JSON.parse(String(reader.result)));
                } catch (e) {
                    reject(new Error("Invalid JSON: " + e.message));
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
        input.click();
    });
}

function sortRowsByColor(rows) {
    const indexed = rows.map((r, i) => [r, i]);
    indexed.sort(([a, ai], [b, bi]) => {
        const ac = COLOR_ORDER.has(a.color) ? COLOR_ORDER.get(a.color) : Number.MAX_SAFE_INTEGER;
        const bc = COLOR_ORDER.has(b.color) ? COLOR_ORDER.get(b.color) : Number.MAX_SAFE_INTEGER;
        // Treat null (None) as the LAST bucket, not the first.
        const norm = (v) => (v === 0 ? Number.MAX_SAFE_INTEGER : v);
        const an = norm(ac);
        const bn = norm(bc);
        if (an !== bn) return an - bn;
        return ai - bi; // stable within same color
    });
    return indexed.map(([r]) => r);
}

function openRowDialog(row, onSave, onDelete) {
    const dlg = document.createElement("dialog");
    dlg.className = "newflow-dd-dialog";

    const swatches = GROUP_COLORS.map(
        (c) =>
            `<button type="button" class="newflow-dd-swatch${c.value === null ? " newflow-dd-swatch-none" : ""}"
                data-color="${c.value ?? ""}"
                title="${c.name}"
                style="${c.value ? `background:${c.value};` : ""}"></button>`
    ).join("");

    dlg.innerHTML = `
        <form method="dialog" class="newflow-dd-form">
            <h3>Configure dropdown</h3>
            <label>Label
                <input type="text" name="label" required maxlength="64" />
            </label>
            <label>Options (comma-separated)
                <textarea name="options" rows="6" placeholder="red, green, blue"></textarea>
            </label>
            <label>Group color
                <div class="newflow-dd-swatches">${swatches}</div>
            </label>
            <div class="newflow-dd-dialog-actions">
                <button type="button" data-action="delete" class="newflow-dd-danger">Delete</button>
                <span style="flex:1"></span>
                <button type="button" data-action="cancel">Cancel</button>
                <button type="submit" data-action="save" class="newflow-dd-primary">Save</button>
            </div>
        </form>
    `;

    dlg.querySelector('[name="label"]').value = row.label || "";
    dlg.querySelector('[name="options"]').value = (row.options || []).join(", ");

    let pickedColor = row.color ?? null;
    const updateSwatchSelection = () => {
        dlg.querySelectorAll(".newflow-dd-swatch").forEach((el) => {
            const v = el.dataset.color || null;
            el.classList.toggle("newflow-dd-swatch-selected", v === pickedColor);
        });
    };
    dlg.querySelectorAll(".newflow-dd-swatch").forEach((el) => {
        el.addEventListener("click", () => {
            pickedColor = el.dataset.color || null;
            updateSwatchSelection();
        });
    });
    updateSwatchSelection();

    dlg.querySelector('[data-action="cancel"]').addEventListener("click", () => dlg.close());
    dlg.querySelector('[data-action="delete"]').addEventListener("click", () => {
        dlg.close();
        onDelete();
    });
    dlg.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const label = dlg.querySelector('[name="label"]').value.trim();
        const options = parseOptionsString(dlg.querySelector('[name="options"]').value);
        if (!label) return;
        dlg.close();
        onSave({ label, options, color: pickedColor });
    });

    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
}

function renderRows(container, rows, onChange) {
    container.replaceChildren();

    rows.forEach((row, idx) => {
        const card = document.createElement("div");
        card.className = "newflow-dd-row";
        if (row.color) card.style.setProperty("--newflow-dd-accent", row.color);
        card.classList.toggle("newflow-dd-row-colored", !!row.color);

        const head = document.createElement("div");
        head.className = "newflow-dd-row-head";

        const label = document.createElement("div");
        label.className = "newflow-dd-row-label";
        const isConfigured = row.options && row.options.length > 0 && row.label;
        label.textContent = isConfigured ? row.label : "(configure via …)";
        if (!isConfigured) label.classList.add("newflow-dd-placeholder");

        const menu = document.createElement("button");
        menu.type = "button";
        menu.className = "newflow-dd-menu-btn";
        menu.title = "Configure";
        menu.textContent = "…";
        menu.addEventListener("click", (e) => {
            e.stopPropagation();
            openRowDialog(
                row,
                ({ label, options, color }) => {
                    rows[idx] = {
                        ...row,
                        label,
                        options,
                        color: color ?? null,
                        selected:
                            row.selected && options.includes(row.selected)
                                ? row.selected
                                : NONE,
                    };
                    onChange();
                },
                () => {
                    rows.splice(idx, 1);
                    onChange();
                }
            );
        });

        const lock = document.createElement("button");
        lock.type = "button";
        lock.className = "newflow-dd-lock-btn";
        lock.title = row.locked ? "Unlock value" : "Lock current value";
        applyIcon(lock, row.locked ? "lock-closed" : "lock-open");
        lock.classList.toggle("newflow-dd-lock-active", !!row.locked);
        lock.disabled = !isConfigured;
        lock.addEventListener("click", (e) => {
            e.stopPropagation();
            rows[idx].locked = !rows[idx].locked;
            onChange();
        });

        head.append(label, lock, menu);

        const select = document.createElement("select");
        select.className = "newflow-dd-select";
        select.disabled = !isConfigured || !!row.locked;

        const noneOpt = document.createElement("option");
        noneOpt.value = NONE;
        noneOpt.textContent = NONE;
        select.appendChild(noneOpt);

        (row.options || []).forEach((opt) => {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            select.appendChild(o);
        });

        select.value = row.selected || NONE;
        select.addEventListener("change", (e) => {
            rows[idx].selected = e.target.value;
            onChange();
        });

        card.append(head, select);
        container.appendChild(card);
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "newflow-dd-add-btn";
    addBtn.textContent = "+ Add dropdown";
    addBtn.addEventListener("click", () => {
        rows.push({ id: uid(), label: "", options: [], selected: NONE, locked: false, color: null });
        onChange();
    });
    container.appendChild(addBtn);
}

app.registerExtension({
    name: "newflow.dynamic_dropdowns",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);

            const node = this;
            const root = document.createElement("div");
            root.className = "newflow-dd-root";

            const toolbar = document.createElement("div");
            toolbar.className = "newflow-dd-toolbar";
            toolbar.innerHTML = `
                <button type="button" data-action="import" title="Import configuration from JSON">Import</button>
                <button type="button" data-action="export" title="Export current configuration">Export</button>
                <button type="button" data-action="example" title="Download an example JSON">Example</button>
            `;

            const grid = document.createElement("div");
            grid.className = "newflow-dd-container";

            root.append(toolbar, grid);

            let rows = [];
            let persist = null;

            const onChange = () => {
                persist?.markDirty();
                renderRows(grid, rows, onChange);
                node.title = `Newflow Dynamic Dropdowns (${rows.length})`;
                node.setDirtyCanvas(true, true);
            };

            node.addDOMWidget(WIDGET_NAME, "newflow_dropdowns", root, {
                serialize: true,
                getValue: () => serialize(rows),
            });

            persist = installPersistence(node, {
                nodeClass: NODE_NAME,
                schema: "NewflowDynamicDropdowns.v2",
                widgetNames: [WIDGET_NAME],
                extractFromWidgets: ([raw]) => ({ rows: deserialize(raw) }),
                getState: () => ({ rows }),
                setState: ({ rows: r }) => {
                    rows = Array.isArray(r) ? r : [];
                    renderRows(grid, rows, onChange);
                    node.title = `Newflow Dynamic Dropdowns (${rows.length})`;
                    node.setDirtyCanvas(true, true);
                },
                defaultState: () => ({ rows: [] }),
            });

            node._newflowSortByColor = () => {
                rows = sortRowsByColor(rows);
                onChange();
            };

            toolbar.querySelector('[data-action="export"]').addEventListener("click", () => {
                downloadJson({ version: EXPORT_VERSION, rows }, "newflow-dropdowns.json");
            });

            toolbar.querySelector('[data-action="example"]').addEventListener("click", () => {
                downloadJson(EXAMPLE_PAYLOAD, "newflow-dropdowns-example.json");
            });

            toolbar.querySelector('[data-action="import"]').addEventListener("click", async () => {
                if (rows.length > 0) {
                    const ok = await confirmModal({
                        title: "Replace existing dropdowns?",
                        message: `This will replace ${rows.length} existing dropdown${rows.length === 1 ? "" : "s"} with the imported configuration. This cannot be undone.`,
                        confirmText: "Replace",
                        danger: true,
                    });
                    if (!ok) return;
                }
                try {
                    const data = await pickJsonFile();
                    if (data == null) return;
                    rows = normalizeImportedRows(data);
                    onChange();
                } catch (e) {
                    alert("Import failed: " + e.message);
                }
            });

            node._newflowResetAll = async () => {
                if (rows.length === 0) return;
                const ok = await confirmModal({
                    title: "Reset all dropdowns?",
                    message: `This will delete all ${rows.length} dropdown${rows.length === 1 ? "" : "s"} from this node, including their labels, options, and selections. This cannot be undone.`,
                    confirmText: "Delete all",
                    danger: true,
                });
                if (!ok) return;
                rows = [];
                onChange();
            };

            renderRows(grid, rows, onChange);
            node.title = `Newflow Dynamic Dropdowns (${rows.length})`;
        };

        const origMenu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            origMenu?.apply(this, arguments);
            const node = this;
            options.unshift(
                {
                    content: "Sort rows by color",
                    callback: () => node._newflowSortByColor?.(),
                },
                {
                    content: "Reset all rows…",
                    callback: () => node._newflowResetAll?.(),
                },
                null, // separator
            );
        };
    },
});
