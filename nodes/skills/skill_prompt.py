from __future__ import annotations

import json
import urllib.error
import urllib.request

from comfy_api.latest import io

NUM_SKILL_SLOTS = 6
DEFAULT_OLLAMA_URL = "http://localhost:11434"
LLM_SETTINGS_WIDGET = "llm_settings_state"

# Prepended to the assembled skill bodies so the model executes them as
# strict instructions rather than conversational suggestions.
SKILL_PREAMBLE = """\
YOU ARE IN TASK-EXECUTION MODE. Rules:
1. The section below is your TASK DEFINITION — not a guide, not context, not a lesson. Execute it.
2. Output ONLY the exact format the task specifies. If it specifies JSON, output raw JSON only.
3. Do NOT add preamble, explanation, alternatives, tips, or closing remarks of any kind.
4. Do NOT say "I cannot" or "as an AI". You are an executor. Execute the task now.
5. The output format defined in the task is mandatory and non-negotiable.

TASK DEFINITION:
"""


class NewflowSkillPrompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowSkillPrompt",
            display_name="Newflow Skill Prompt",
            category="newflow/skills",
            description=(
                "Combines connected skill bodies as a system prompt and sends a "
                "user message to Ollama. Skills are joined with \\n\\n---\\n\\n."
            ),
            inputs=[
                io.Autogrow.Input(
                    "skills",
                    template=io.Autogrow.TemplateNames(
                        input=io.String.Input("skill", optional=True),
                        names=[f"skill_{i + 1}" for i in range(NUM_SKILL_SLOTS)],
                        min=1,
                    ),
                ),
                io.String.Input(
                    "user_prompt",
                    multiline=True,
                    optional=True,
                    default="",
                    tooltip="User message sent to the LLM",
                ),
            ],
            outputs=[
                io.String.Output("OUTPUT"),
                io.String.Output("SYSTEM"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, user_prompt="", **kwargs):
        _kwargs_debug = {k: (repr(v)[:80] if v is not None else "None") for k, v in kwargs.items()}

        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})

        raw = node_inputs.get(LLM_SETTINGS_WIDGET) or {}
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                raw = {}
        if not isinstance(raw, dict):
            raw = {}

        model = (raw.get("model") or "").strip()
        ollama_url = (raw.get("ollama_url") or "").strip().rstrip("/") or DEFAULT_OLLAMA_URL

        options: dict = {}
        if raw.get("num_ctx"):
            options["num_ctx"] = int(raw["num_ctx"])
        if raw.get("temperature") is not None:
            options["temperature"] = float(raw["temperature"])
        if raw.get("max_tokens") and int(raw["max_tokens"]) > 0:
            options["num_predict"] = int(raw["max_tokens"])
        if raw.get("top_p") is not None:
            options["top_p"] = float(raw["top_p"])

        if not model:
            return io.NodeOutput("[error: no model selected — open ⚙ LLM Settings]")

        skills = []
        for i in range(NUM_SKILL_SLOTS):
            s = kwargs.get(f"skill_{i + 1}")
            if s and isinstance(s, str) and s.strip():
                skills.append(s.strip())

        messages = []
        if skills:
            system_content = SKILL_PREAMBLE + "\n\n---\n\n".join(skills)
            messages.append({"role": "system", "content": system_content})

        user_content = user_prompt or ""
        if skills and user_content:
            user_content = (
                f"Execute the skill for this input. "
                f"Output ONLY the format the skill specifies, nothing else:\n\n{user_content}"
            )
        messages.append({"role": "user", "content": user_content})

        payload: dict = {"model": model, "messages": messages, "stream": False, "options": options}
        if skills:
            # format="json" makes Ollama enforce valid JSON at the engine level —
            # far more reliable than prompt instructions alone.
            payload["format"] = "json"
            # Disable thinking mode (Qwen3, deepseek-r1, etc.): thinking
            # produces a conversational `content` even when the system prompt
            # demands raw JSON.
            payload["think"] = False

        system_debug = next(
            (m["content"] for m in messages if m["role"] == "system"),
            f"[no system prompt built — kwargs keys: {list(_kwargs_debug.keys())}]\n\nkwargs values:\n"
            + "\n".join(f"  {k}: {v}" for k, v in _kwargs_debug.items()),
        )

        try:
            req = urllib.request.Request(
                f"{ollama_url}/api/chat",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                result = json.loads(resp.read())
            return io.NodeOutput(result.get("message", {}).get("content", ""), system_debug)
        except urllib.error.HTTPError as e:
            body = e.read(500).decode("utf-8", errors="replace")
            return io.NodeOutput(f"[HTTP {e.code}: {body}]", system_debug)
        except urllib.error.URLError as e:
            return io.NodeOutput(f"[Cannot reach Ollama at {ollama_url}: {e.reason}]", system_debug)
        except Exception as e:
            return io.NodeOutput(f"[Error: {e}]", system_debug)
