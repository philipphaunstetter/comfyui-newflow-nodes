from __future__ import annotations

import json
import urllib.error
import urllib.request

from comfy_api.latest import io

NUM_SKILL_SLOTS = 6
DEFAULT_OLLAMA_URL = "http://localhost:11434"


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
                *[
                    io.String.Input(
                        f"skill_{i + 1}",
                        optional=True,
                        force_input=True,
                        tooltip=f"Skill body #{i + 1}",
                    )
                    for i in range(NUM_SKILL_SLOTS)
                ],
                io.String.Input(
                    "user_prompt",
                    multiline=True,
                    optional=True,
                    default="",
                    tooltip="User message sent to the LLM",
                ),
                io.String.Input(
                    "model",
                    optional=False,
                    default="",
                    tooltip="Ollama model name (e.g. llama3.2)",
                ),
                io.String.Input(
                    "ollama_url",
                    optional=True,
                    default="",
                    tooltip=f"Ollama base URL (defaults to {DEFAULT_OLLAMA_URL})",
                ),
            ],
            outputs=[
                io.String.Output("OUTPUT"),
            ],
        )

    @classmethod
    def execute(cls, user_prompt="", model="", ollama_url="", **kwargs):
        skills = []
        for i in range(NUM_SKILL_SLOTS):
            s = kwargs.get(f"skill_{i + 1}")
            if s and isinstance(s, str) and s.strip():
                skills.append(s.strip())

        url = (ollama_url or "").strip().rstrip("/") or DEFAULT_OLLAMA_URL

        if not model or not model.strip():
            return io.NodeOutput("[error: model name is required]")

        messages = []
        if skills:
            messages.append({"role": "system", "content": "\n\n---\n\n".join(skills)})
        messages.append({"role": "user", "content": user_prompt or ""})

        payload = {"model": model.strip(), "messages": messages, "stream": False}

        try:
            req = urllib.request.Request(
                f"{url}/api/chat",
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
            return io.NodeOutput(f"[Cannot reach Ollama at {url}: {e.reason}]")
        except Exception as e:
            return io.NodeOutput(f"[Error: {e}]")
