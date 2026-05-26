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
SYSTEM RULES — obey without exception:
1. Execute the skill instructions below. Produce ONLY the output format they specify.
2. Never add preamble, explanation, tips, commentary, closing remarks, or follow-up questions.
3. Never say you cannot do something. Never offer alternatives. Just execute.
4. If the skill output format is JSON, your ENTIRE response must be raw valid JSON — nothing before or after it, no markdown code fences.

SKILL INSTRUCTIONS:
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
            system_content = SKILL_PREAMBLE + "\n\n---\n\n".join(skills)
            messages.append({"role": "system", "content": system_content})

        # Frame the user turn as an explicit execution command so the model
        # doesn't default to a conversational response.
        user_content = user_prompt or ""
        if skills and user_content:
            user_content = (
                f"Execute the skill for this input. "
                f"Output ONLY the format the skill specifies, nothing else:\n\n{user_content}"
            )
        messages.append({"role": "user", "content": user_content})

        # Assistant prefill: seed the reply with the first character of the
        # expected output so the model must continue it rather than opening
        # with conversational text. Only applied when skills are active.
        prefill = ""
        if skills:
            prefill = "{"
            messages.append({"role": "assistant", "content": prefill})

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
            content = result.get("message", {}).get("content", "")
            # Re-attach the prefill character the model continued from.
            if prefill:
                content = prefill + content
            return io.NodeOutput(content)
        except urllib.error.HTTPError as e:
            body = e.read(500).decode("utf-8", errors="replace")
            return io.NodeOutput(f"[HTTP {e.code}: {body}]")
        except urllib.error.URLError as e:
            return io.NodeOutput(f"[Cannot reach Ollama at {ollama_url}: {e.reason}]")
        except Exception as e:
            return io.NodeOutput(f"[Error: {e}]")
