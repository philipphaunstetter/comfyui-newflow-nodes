import { app } from "../../scripts/app.js";
import { installPersistence } from "./_persistence.js";

const NODE_NAME = "NewflowImageArray";
const WIDGET_NAME = "containers";
const DRAG_MIME = "application/x-newflow-image-array-idx";
const MIN_WIDTH = 380;

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./image_array.css", import.meta.url).href;
document.head.appendChild(css);

const isInNewflowImageArray = (target) =>
    target instanceof Element && target.closest(".newflow-ia-label-input") != null;
["keydown", "keyup", "keypress", "copy", "cut", "paste"].forEach((evt) => {
    document.addEventListener(
        evt,
        (e) => {
            if (isInNewflowImageArray(e.target)) e.stopPropagation();
        },
        true,
    );
});

const DEFAULT_LABELS = ["Top", "Trousers", "Shoes"];

const uid = () => "c_" + Math.random().toString(36).slice(2, 9);

function nextLabel(containers) {
    const used = new Set(containers.map((c) => c.label));
    for (const l of DEFAULT_LABELS) {
        if (!used.has(l)) return l;
    }
    let n = 1;
    while (used.has(`Accessory #${n}`)) n++;
    return `Accessory #${n}`;
}

const serialize = (containers) => JSON.stringify(containers);
const deserialize = (v) => {
    if (Array.isArray(v)) return v.map(normalizeContainer).filter(Boolean);
    if (!v) return [];
    try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed.map(normalizeContainer).filter(Boolean) : [];
    } catch {
        return [];
    }
};

function normalizeImage(img) {
    if (!img || typeof img !== "object") return null;
    const filename = typeof img.filename === "string" ? img.filename : "";
    if (!filename) return null;
    return {
        filename,
        subfolder: typeof img.subfolder === "string" ? img.subfolder : "",
        type: typeof img.type === "string" ? img.type : "input",
    };
}

function normalizeContainer(c) {
    if (!c || typeof c !== "object") return null;

    let images = [];
    if (Array.isArray(c.images)) {
        images = c.images.map(normalizeImage).filter(Boolean);
    } else if (typeof c.filename === "string" && c.filename) {
        const single = normalizeImage({
            filename: c.filename,
            subfolder: c.subfolder,
            type: c.type,
        });
        if (single) images = [single];
    }

    let currentIdx = 0;
    if (typeof c.currentIdx === "number" && Number.isFinite(c.currentIdx)) {
        currentIdx = Math.max(0, Math.min(c.currentIdx, Math.max(0, images.length - 1)));
    }

    return {
        id: typeof c.id === "string" && c.id ? c.id : uid(),
        label: typeof c.label === "string" ? c.label : "",
        included: c.included !== false,
        images,
        currentIdx,
    };
}

function viewUrl(img) {
    if (!img || !img.filename) return "";
    const params = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || "",
        type: img.type || "input",
    });
    return `/view?${params.toString()}`;
}

async function uploadImage(file) {
    const fd = new FormData();
    fd.append("image", file, file.name);
    fd.append("type", "input");
    fd.append("subfolder", "");
    fd.append("overwrite", "false");
    const resp = await fetch("/upload/image", { method: "POST", body: fd });
    if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Upload failed (HTTP ${resp.status})${txt ? ": " + txt : ""}`);
    }
    const data = await resp.json();
    return {
        filename: data.name || data.filename,
        subfolder: data.subfolder || "",
        type: data.type || "input",
    };
}

function renderContainers(host, containers, onChange) {
    host.replaceChildren();

    containers.forEach((row, idx) => {
        const card = document.createElement("div");
        card.className = "newflow-ia-card";
        if (!row.included) card.classList.add("newflow-ia-card-excluded");
        card.dataset.idx = String(idx);

        const head = document.createElement("div");
        head.className = "newflow-ia-card-head";

        const handle = document.createElement("span");
        handle.className = "newflow-ia-handle";
        handle.title = "Drag to reorder";
        handle.textContent = "≡";

        const includeWrap = document.createElement("label");
        includeWrap.className = "newflow-ia-include";
        includeWrap.title = "Include this container in the IMAGE / IMAGE_LIST output";
        const includeCheck = document.createElement("input");
        includeCheck.type = "checkbox";
        includeCheck.checked = !!row.included;
        includeWrap.appendChild(includeCheck);

        const labelInput = document.createElement("input");
        labelInput.type = "text";
        labelInput.className = "newflow-ia-label-input";
        labelInput.value = row.label;
        labelInput.placeholder = "Label";
        labelInput.maxLength = 64;

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "newflow-ia-remove";
        removeBtn.title = "Remove container";
        removeBtn.textContent = "×";

        head.append(handle, includeWrap, labelInput, removeBtn);

        const body = document.createElement("div");
        body.className = "newflow-ia-card-body";

        const thumbWrap = document.createElement("div");
        thumbWrap.className = "newflow-ia-thumb";
        const currentImg = row.images[row.currentIdx] || null;
        if (currentImg) {
            const img = document.createElement("img");
            img.src = viewUrl(currentImg);
            img.alt = row.label || "preview";
            img.draggable = false;
            img.onerror = () => { thumbWrap.classList.add("newflow-ia-thumb-broken"); };
            thumbWrap.appendChild(img);

            const imgRemove = document.createElement("button");
            imgRemove.type = "button";
            imgRemove.className = "newflow-ia-img-remove";
            imgRemove.title = "Remove this image";
            imgRemove.textContent = "×";
            imgRemove.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.images.splice(row.currentIdx, 1);
                if (row.currentIdx >= row.images.length) {
                    row.currentIdx = Math.max(0, row.images.length - 1);
                }
                onChange();
            });
            thumbWrap.appendChild(imgRemove);
        } else {
            thumbWrap.classList.add("newflow-ia-thumb-empty");
            const empty = document.createElement("span");
            empty.textContent = "no images — click + to upload";
            thumbWrap.appendChild(empty);
        }

        const controls = document.createElement("div");
        controls.className = "newflow-ia-controls";

        const prevBtn = document.createElement("button");
        prevBtn.type = "button";
        prevBtn.className = "newflow-ia-arrow";
        prevBtn.textContent = "‹";
        prevBtn.title = "Previous image";
        prevBtn.disabled = row.currentIdx <= 0;
        prevBtn.addEventListener("click", (e) => {
            e.preventDefault();
            row.currentIdx = Math.max(0, row.currentIdx - 1);
            onChange();
        });

        const counter = document.createElement("span");
        counter.className = "newflow-ia-counter";
        counter.textContent = row.images.length > 0
            ? `${row.currentIdx + 1} / ${row.images.length}`
            : "0 / 0";

        const nextBtn = document.createElement("button");
        nextBtn.type = "button";
        nextBtn.className = "newflow-ia-arrow";
        nextBtn.textContent = "›";
        nextBtn.title = "Next image";
        nextBtn.disabled = row.currentIdx >= row.images.length - 1;
        nextBtn.addEventListener("click", (e) => {
            e.preventDefault();
            row.currentIdx = Math.min(row.images.length - 1, row.currentIdx + 1);
            onChange();
        });

        const spacer = document.createElement("span");
        spacer.style.flex = "1";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "newflow-ia-add-img-btn";
        addBtn.title = "Add image(s)";
        addBtn.textContent = "+ Add";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        fileInput.hidden = true;
        addBtn.appendChild(fileInput);

        controls.append(prevBtn, counter, nextBtn, spacer, addBtn);

        body.append(thumbWrap, controls);
        card.append(head, body);
        host.appendChild(card);

        includeCheck.addEventListener("change", () => {
            row.included = includeCheck.checked;
            onChange();
        });

        labelInput.addEventListener("input", () => {
            row.label = labelInput.value;
            onChange({ persistOnly: true });
        });

        removeBtn.addEventListener("click", (e) => {
            e.preventDefault();
            containers.splice(idx, 1);
            onChange();
        });

        const doUploadFiles = async (files) => {
            if (!files || !files.length) return;
            addBtn.classList.add("newflow-ia-uploading");
            addBtn.disabled = true;
            const prevText = addBtn.firstChild.textContent;
            addBtn.firstChild.textContent = "Uploading…";
            try {
                for (const file of files) {
                    try {
                        const meta = await uploadImage(file);
                        row.images.push(meta);
                    } catch (err) {
                        alert(err.message || String(err));
                        break;
                    }
                }
                if (row.images.length > 0) {
                    row.currentIdx = row.images.length - 1;
                }
                onChange();
            } finally {
                addBtn.classList.remove("newflow-ia-uploading");
                addBtn.disabled = false;
                addBtn.firstChild.textContent = prevText;
            }
        };

        addBtn.addEventListener("click", (e) => {
            if (e.target === fileInput) return;
            e.preventDefault();
            fileInput.click();
        });
        fileInput.addEventListener("change", () => {
            doUploadFiles(Array.from(fileInput.files || []));
            fileInput.value = "";
        });

        ["dragenter", "dragover"].forEach((evt) => {
            thumbWrap.addEventListener(evt, (e) => {
                if (!e.dataTransfer?.types?.includes("Files")) return;
                e.preventDefault();
                e.stopPropagation();
                thumbWrap.classList.add("newflow-ia-thumb-drop-hover");
            });
        });
        ["dragleave", "dragend"].forEach((evt) => {
            thumbWrap.addEventListener(evt, () => thumbWrap.classList.remove("newflow-ia-thumb-drop-hover"));
        });
        thumbWrap.addEventListener("drop", (e) => {
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            e.stopPropagation();
            thumbWrap.classList.remove("newflow-ia-thumb-drop-hover");
            doUploadFiles(Array.from(e.dataTransfer.files));
        });

        // Drag-reorder: only the handle is draggable so child buttons receive
        // their clicks normally.
        handle.draggable = true;
        handle.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData(DRAG_MIME, String(idx));
            e.dataTransfer.effectAllowed = "move";
            card.classList.add("newflow-ia-card-dragging");
        });
        handle.addEventListener("dragend", () => {
            card.classList.remove("newflow-ia-card-dragging");
            host.querySelectorAll(".newflow-ia-card-drop-target").forEach((el) =>
                el.classList.remove("newflow-ia-card-drop-target", "newflow-ia-drop-above", "newflow-ia-drop-below")
            );
        });
        card.addEventListener("dragover", (e) => {
            if (!e.dataTransfer?.types?.includes(DRAG_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = card.getBoundingClientRect();
            const above = (e.clientY - rect.top) < rect.height / 2;
            host.querySelectorAll(".newflow-ia-card-drop-target").forEach((el) =>
                el.classList.remove("newflow-ia-card-drop-target", "newflow-ia-drop-above", "newflow-ia-drop-below")
            );
            card.classList.add("newflow-ia-card-drop-target", above ? "newflow-ia-drop-above" : "newflow-ia-drop-below");
        });
        card.addEventListener("dragleave", () => {
            card.classList.remove("newflow-ia-card-drop-target", "newflow-ia-drop-above", "newflow-ia-drop-below");
        });
        card.addEventListener("drop", (e) => {
            const raw = e.dataTransfer?.getData(DRAG_MIME);
            if (raw === "" || raw == null) return;
            e.preventDefault();
            e.stopPropagation();
            const fromIdx = parseInt(raw, 10);
            const rect = card.getBoundingClientRect();
            const above = (e.clientY - rect.top) < rect.height / 2;
            let toIdx = idx + (above ? 0 : 1);
            if (fromIdx === toIdx || (fromIdx === toIdx - 1 && !above)) {
                onChange({ persistOnly: true });
                return;
            }
            const [moved] = containers.splice(fromIdx, 1);
            if (toIdx > fromIdx) toIdx -= 1;
            containers.splice(toIdx, 0, moved);
            onChange();
        });
    });

    const addContainerBtn = document.createElement("button");
    addContainerBtn.type = "button";
    addContainerBtn.className = "newflow-ia-add-btn";
    addContainerBtn.textContent = "+ Add container";
    addContainerBtn.addEventListener("click", () => {
        containers.push(normalizeContainer({
            id: uid(),
            label: nextLabel(containers),
            included: true,
            images: [],
        }));
        onChange();
    });
    host.appendChild(addContainerBtn);
}

app.registerExtension({
    name: "newflow.image_array",
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
            root.className = "newflow-ia-root";

            let containers = [];
            let persist = null;

            const updateTitle = () => {
                node.title = `Newflow Image Array (${containers.length})`;
            };

            const onChange = ({ persistOnly = false } = {}) => {
                persist?.markDirty();
                if (!persistOnly) {
                    renderContainers(root, containers, onChange);
                    updateTitle();
                    node.setDirtyCanvas(true, true);
                }
            };

            node.addDOMWidget(WIDGET_NAME, "newflow_image_array", root, {
                serialize: true,
                getValue: () => serialize(containers),
            });

            persist = installPersistence(node, {
                nodeClass: NODE_NAME,
                schema: "NewflowImageArray.v1",
                widgetNames: [WIDGET_NAME],
                extractFromWidgets: ([raw]) => ({ containers: deserialize(raw) }),
                getState: () => ({ containers }),
                setState: ({ containers: c }) => {
                    containers = Array.isArray(c) ? c : [];
                    renderContainers(root, containers, onChange);
                    updateTitle();
                    node.setDirtyCanvas(true, true);
                },
                defaultState: () => ({ containers: [] }),
            });

            renderContainers(root, containers, onChange);
            updateTitle();

            const origOnResize = node.onResize;
            node.onResize = function (size) {
                if (Array.isArray(size) && size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                origOnResize?.apply(this, arguments);
            };
        };
    },
});
