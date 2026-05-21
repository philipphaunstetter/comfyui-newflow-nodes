import { app } from "../../scripts/app.js";
import { installPersistence } from "./_persistence.js";
import {
    DEFAULT_LLM_SETTINGS,
    clearComposerRunning,
    deserializeLlmState,
    hasDownstreamConsumer,
    markComposerRunning,
    openLlmSettings,
    preloadImageCache,
    readUpstreamStringForGenerate,
} from "./prompt_composer.js";

const NODE_NAME = "NewflowPromptComposerSimple";
const LLM_WIDGET = "llm_output_state";
const MIN_WIDTH = 480;
const FIXED_LLM_WIDGET_H = 260;
const NODE_CHROME_H = 200;
const MIN_HEIGHT = FIXED_LLM_WIDGET_H + NODE_CHROME_H;

function makeSimpleOutputBlock(node) {
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

    const editor = document.createElement("textarea");
    editor.className = "newflow-pc-simple-llm-editor";
    editor.spellcheck = false;
    editor.placeholder = "Click Generate to run the LLM, or paste / type manually.";

    block.append(head, editor);

    let state = { text: "", settings: { ...DEFAULT_LLM_SETTINGS } };
    let abortCtrl = null;
    let onChanged = () => {};

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
        onChanged();
    });
    refreshAutoBtn();

    const setStatus = (s) => {
        status.dataset.state = s;
        status.textContent = s;
    };
    const setStreaming = (streaming) => {
        editor.readOnly = streaming;
        editor.classList.toggle("newflow-pc-llm-streaming", streaming);
        generateBtn.textContent = streaming ? "Stop" : "Generate";
        generateBtn.classList.toggle("newflow-pc-stop-btn", streaming);
        settingsBtn.disabled = streaming;
    };

    const wrapErr = (msg, name) => {
        const e = new Error(msg);
        if (name) e.name = name;
        e.nodeTitle = node.title || "Newflow Prompt Composer (Simple)";
        return e;
    };

    // Read USER / SYSTEM. If the input socket is connected, resolve from the
    // upstream node's widget so chained composers see the freshly-generated
    // text from a previous composer (the queue interceptor topo-sorts auto-
    // regen runs so upstream is guaranteed done by the time we read). Falls
    // back to the local standard widget when nothing is wired.
    const readUserText = () => {
        const upstream = readUpstreamStringForGenerate(node, "USER");
        if (upstream != null) return upstream;
        const w = node.widgets?.find((x) => x.name === "USER");
        return typeof w?.value === "string" ? w.value : "";
    };
    const readSystemText = () => {
        const upstream = readUpstreamStringForGenerate(node, "SYSTEM");
        if (upstream != null) return upstream;
        const w = node.widgets?.find((x) => x.name === "SYSTEM");
        return typeof w?.value === "string" ? w.value : "";
    };

    const runGenerate = async ({ silent = false } = {}) => {
        if (abortCtrl) return;
        if (!state.settings.model) {
            throw wrapErr("No model selected — open settings and pick one.");
        }

        // Activate the running UI immediately so the button reads "Stop" and
        // the status badge updates during the preflight phases (healthcheck +
        // image preload), not only once the chat stream starts. abortCtrl is
        // wired up early so Stop is functional from t=0.
        abortCtrl = new AbortController();
        setStreaming(true);
        setStatus("checking ollama");

        try {
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
                if (e.nodeTitle) throw e;
                const msg = `Ollama not reachable: ${e.message || e}`;
                if (!silent) alert(msg);
                throw wrapErr(msg);
            }

            setStatus("loading images");
            try {
                await preloadImageCache(node, { signal: abortCtrl.signal });
                await refreshImageBadge();
            } catch (e) {
                if (e.name === "AbortError") {
                    setStatus("stopped");
                    throw wrapErr("Generation aborted", "AbortError");
                }
                console.warn("Newflow: image preload failed:", e);
            }

            editor.value = "";
            state.text = "";
            onChanged();
            setStatus("streaming");

            try {
                const resp = await fetch("/newflow/llm/generate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: state.settings.model,
                        user: readUserText(),
                        system: readSystemText(),
                        options: {
                            temperature: state.settings.temperature,
                            num_predict: state.settings.max_tokens,
                            top_p: state.settings.top_p,
                            num_ctx: state.settings.num_ctx,
                        },
                        think: state.settings.think !== false,
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
                // Reasoning models (Qwen3, deepseek-r1, etc.) emit chunks with
                // `message.thinking` that may never transition to `message.content`.
                // Accumulate both separately; the canonical output is `content` if
                // the model ever emits any, otherwise the `thinking` text.
                let thinkingText = "";
                let contentText = "";
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
                            const thinking = chunk.message && typeof chunk.message.thinking === "string"
                                ? chunk.message.thinking
                                : "";
                            const content =
                                (chunk.message && typeof chunk.message.content === "string"
                                    ? chunk.message.content
                                    : "") ||
                                (typeof chunk.response === "string" ? chunk.response : "");
                            if (thinking) thinkingText += thinking;
                            if (content) contentText += content;
                            if (thinking || content) {
                                state.text = contentText || thinkingText;
                                editor.value = state.text;
                                editor.scrollTop = editor.scrollHeight;
                            }
                        } catch {
                            // ignore malformed JSON
                        }
                    }
                }
                onChanged();
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

    generateBtn.addEventListener("click", async () => {
        if (abortCtrl) {
            abortInFlight();
            return;
        }
        if (!state.settings.model) {
            const next = await openLlmSettings(state.settings);
            if (!next) return;
            state.settings = { ...DEFAULT_LLM_SETTINGS, ...next };
            refreshAutoBtn();
            onChanged();
            if (!state.settings.model) return;
        }
        let succeeded = false;
        markComposerRunning(node);
        try {
            await runGenerate({ silent: false });
            succeeded = true;
        } catch {
            // alerts already shown
        } finally {
            clearComposerRunning(node);
        }
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

    settingsBtn.addEventListener("click", async () => {
        const next = await openLlmSettings(state.settings);
        if (!next) return;
        state.settings = { ...DEFAULT_LLM_SETTINGS, ...next };
        refreshAutoBtn();
        onChanged();
    });

    editor.addEventListener("input", () => {
        if (abortCtrl) return;
        state.text = editor.value || "";
        onChanged();
    });

    node._newflowIsAutoRegen = () => !!state.settings.auto_regen;
    node._newflowRunGenerate = () => runGenerate({ silent: true });
    node._newflowAbortGenerate = abortInFlight;

    const anyImageInputWired = () => {
        for (const name of ["IMAGES", "IMAGE_LIST"]) {
            const slotIdx = (node.inputs || []).findIndex((i) => i.name === name);
            if (slotIdx < 0) continue;
            if (node.getInputNode?.(slotIdx)) return true;
        }
        return false;
    };

    const refreshImageBadge = async () => {
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
        refreshImageBadge,
        setOnChanged: (fn) => { onChanged = fn || (() => {}); },
        getValue: () =>
            JSON.stringify({
                text: editor.value || "",
                settings: state.settings,
            }),
        setValue: (v) => {
            const parsed = deserializeLlmState(v);
            state = { text: parsed.text, settings: parsed.settings };
            editor.value = state.text;
            refreshAutoBtn();
        },
    };
}

app.registerExtension({
    name: "newflow.prompt_composer_simple",
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

            let persist = null;

            const llmHost = document.createElement("div");
            llmHost.className = "newflow-pc-root";

            const llmBlock = makeSimpleOutputBlock(node);
            llmHost.appendChild(llmBlock.dom);

            const notifyChanged = () => {
                persist?.markDirty();
                node.setDirtyCanvas(true, true);
            };
            llmBlock.setOnChanged(notifyChanged);

            const llmWidget = node.addDOMWidget(LLM_WIDGET, "newflow_llm_state", llmHost, {
                serialize: true,
                getValue: () => llmBlock.getValue(),
            });

            persist = installPersistence(node, {
                nodeClass: NODE_NAME,
                schema: "NewflowPromptComposerSimple.v1",
                widgetNames: [LLM_WIDGET],
                extractFromWidgets: ([llmRaw]) => ({ llm: llmRaw || "{}" }),
                getState: () => ({ llm: llmBlock.getValue() }),
                setState: (s) => {
                    if (s.llm) llmBlock.setValue(s.llm);
                    llmBlock.refreshImageBadge?.();
                },
                defaultState: () => ({ llm: "{}" }),
            });

            llmWidget.computeSize = (w) => [w, FIXED_LLM_WIDGET_H];

            // Refresh badge on connection changes (any input wired/unwired).
            const origConn = node.onConnectionsChange;
            node.onConnectionsChange = function () {
                origConn?.apply(this, arguments);
                llmBlock.refreshImageBadge?.();
            };

            // Apply min size constraints.
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
        };
    },
});
