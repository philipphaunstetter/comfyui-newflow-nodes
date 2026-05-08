from comfy_api.latest import io

from .llm_routes import cache_images, tensor_to_b64_pngs


class NewflowPromptComposerSimple(io.ComfyNode):
    LLM_WIDGET = "llm_output_state"

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowPromptComposerSimple",
            display_name="Newflow Prompt Composer (Simple)",
            category="newflow/prompt",
            description=(
                "Simplified prompt composer with plain-text USER and SYSTEM "
                "fields and a plain-text LLM Output editor. No variable "
                "substitution, no chip strip — just user/system prompts, "
                "optional image inputs, and the same LLM streaming flow "
                "(Generate, Auto, settings, image badge) as the full Composer."
            ),
            inputs=[
                io.Image.Input(
                    "IMAGES",
                    optional=True,
                    tooltip="Optional reference image(s) — standard padded IMAGE batch.",
                ),
                io.Image.Input(
                    "IMAGE_LIST",
                    optional=True,
                    tooltip="Optional IMAGE_LIST input — accepts the IMAGE_LIST output of "
                    "NewflowImageBatch or NewflowImageArray. Each image keeps its native "
                    "dimensions (no padding) so vision LLMs see them at full quality.",
                ),
                io.String.Input(
                    "USER",
                    multiline=True,
                    optional=True,
                    default="",
                    tooltip="User prompt text. Type directly or wire an upstream STRING.",
                ),
                io.String.Input(
                    "SYSTEM",
                    multiline=True,
                    optional=True,
                    default="",
                    tooltip="System prompt text. Type directly or wire an upstream STRING.",
                ),
            ],
            outputs=[
                io.String.Output("USER"),
                io.String.Output("SYSTEM"),
                io.String.Output("OUTPUT"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, IMAGES=None, IMAGE_LIST=None, USER="", SYSTEM=""):
        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})

        raw_llm = node_inputs.get(cls.LLM_WIDGET)
        llm_text = ""
        if isinstance(raw_llm, dict):
            llm_text = str(raw_llm.get("text", ""))
        elif isinstance(raw_llm, str):
            try:
                import json
                obj = json.loads(raw_llm)
                if isinstance(obj, dict):
                    llm_text = str(obj.get("text", ""))
                else:
                    llm_text = raw_llm
            except json.JSONDecodeError:
                llm_text = raw_llm

        combined: list = []
        for src in (IMAGES, IMAGE_LIST):
            if src is None:
                continue
            if isinstance(src, list):
                for item in src:
                    if item is None:
                        continue
                    if isinstance(item, list):
                        combined.extend(t for t in item if t is not None)
                    else:
                        combined.append(item)
            else:
                combined.append(src)

        if combined:
            try:
                cache_images(unique_id, tensor_to_b64_pngs(combined))
            except Exception:
                pass

        return io.NodeOutput(USER or "", SYSTEM or "", llm_text)
