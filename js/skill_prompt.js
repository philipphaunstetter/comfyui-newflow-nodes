import { app } from "../../scripts/app.js";
import { installPersistence } from "./_persistence.js";
import { DEFAULT_LLM_SETTINGS, openLlmSettings } from "./prompt_composer.js";

const NODE_NAME = "NewflowSkillPrompt";
const LLM_SETTINGS_WIDGET = "llm_settings_state";

app.registerExtension({
    name: "newflow.skill_prompt",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            const node = this;

            let settings = { ...DEFAULT_LLM_SETTINGS };

            const host = document.createElement("div");
            host.style.cssText =
                "display:flex;align-items:center;gap:6px;padding:4px 8px;box-sizing:border-box;width:100%;";

            const settingsBtn = document.createElement("button");
            settingsBtn.type = "button";
            settingsBtn.className = "newflow-pc-settings-btn";
            settingsBtn.textContent = "⚙ LLM Settings";

            const modelLabel = document.createElement("span");
            modelLabel.style.cssText =
                "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.6;font-size:0.85em;";

            const refreshLabel = () => {
                modelLabel.textContent = settings.model || "(no model selected)";
            };
            refreshLabel();

            host.append(settingsBtn, modelLabel);

            const settingsWidget = node.addDOMWidget(
                LLM_SETTINGS_WIDGET,
                "newflow_llm_state",
                host,
                {
                    serialize: true,
                    getValue: () => JSON.stringify(settings),
                },
            );
            settingsWidget.computeSize = (w) => [w, 34];

            settingsBtn.addEventListener("click", async () => {
                const next = await openLlmSettings(settings);
                if (!next) return;
                settings = { ...DEFAULT_LLM_SETTINGS, ...next };
                refreshLabel();
                node.setDirtyCanvas(true, true);
            });

            installPersistence(node, {
                nodeClass: NODE_NAME,
                schema: "NewflowSkillPrompt.v1",
                widgetNames: [LLM_SETTINGS_WIDGET],
                extractFromWidgets: ([v]) => {
                    try {
                        return typeof v === "string" ? JSON.parse(v) : (v || {});
                    } catch {
                        return {};
                    }
                },
                getState: () => JSON.stringify(settings),
                setState: (s) => {
                    try {
                        const parsed =
                            typeof s === "string" ? JSON.parse(s) : s || {};
                        settings = { ...DEFAULT_LLM_SETTINGS, ...parsed };
                    } catch {
                        settings = { ...DEFAULT_LLM_SETTINGS };
                    }
                    refreshLabel();
                },
                defaultState: () => ({}),
            });
        };
    },
});
