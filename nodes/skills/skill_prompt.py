from __future__ import annotations

import json
import urllib.error
import urllib.request

from comfy_api.latest import io

NUM_SKILL_SLOTS = 6
DEFAULT_OLLAMA_URL = "http://localhost:11434"
LLM_SETTINGS_WIDGET = "llm_settings_state"


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
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, user_prompt="", **kwargs):
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

        if not model:
            return io.NodeOutput("[error: no model selected — open ⚙ LLM Settings]")

        skills = []
        for i in range(NUM_SKILL_SLOTS):
            s = kwargs.get(f"skill_{i + 1}")
            if s and isinstance(s, str) and s.strip():
                skills.append(s.strip())

        messages = []
        if skills:
            messages.append({"role": "system", "content": "\n\n---\n\n".join(skills)})
        messages.append({"role": "user", "content": user_prompt or ""})

        payload = {"model": model, "messages": messages, "stream": False}

        try:
            req = urllib.request.Request(
                f"{ollama_url}/api/chat",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                result = json.loads(resp.read())
            return io.NodeOutput(result.get("message", {}).get("content", ""))
        except urllib.error.HTTPError as e:
            body = e.read(500).decode("utf-8", errors="replace")
            return io.NodeOutput(f"[HTTP {e.code}: {body}]")
        except urllib.error.URLError as e:
            return io.NodeOutput(f"[Cannot reach Ollama at {ollama_url}: {e.reason}]")
        except Exception as e:
            return io.NodeOutput(f"[Error: {e}]")
