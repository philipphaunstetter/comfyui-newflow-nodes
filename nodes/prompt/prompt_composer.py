import json
import re

from comfy_api.latest import io

from .llm_routes import cache_images, tensor_to_b64_pngs

VAR_RE = re.compile(r"\[\[\s*([^\[\]]+?)\s*\]\]")


class NewflowPromptComposer(io.ComfyNode):
    USER_WIDGET = "user_prompt_state"
    SYSTEM_WIDGET = "system_prompt_state"
    LLM_WIDGET = "llm_output_state"

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowPromptComposer",
            display_name="Newflow Prompt Composer",
            category="newflow/prompt",
            description=(
                "Composes a user prompt, a system prompt, and an LLM output with "
                "variable substitution. Use [[Key]] placeholders that map to keys "
                "from the OPTIONS JSON. Missing keys are emitted as "
                "[MISSING: Key]. The OUTPUT output is the LLM editor's content "
                "(generated via Ollama and optionally hand-edited). Accepts "
                "images via either IMAGES (padded IMAGE batch) or IMAGE_LIST "
                "(from NewflowImageBatch / NewflowImageArray — preserves native "
                "dimensions for vision LLMs). For plain-text user/system inputs "
                "without variable templating, use NewflowPromptComposerSimple."
            ),
            inputs=[
                io.String.Input(
                    "OPTIONS",
                    default="{}",
                    optional=True,
                    force_input=True,
                    tooltip="JSON of {label: value} from NewflowDynamicDropdowns or any STRING source.",
                ),
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
            ],
            outputs=[
                io.String.Output("USER"),
                io.String.Output("SYSTEM"),
                io.String.Output("OUTPUT"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
            is_input_list=True,
        )

    @classmethod
    def execute(cls, OPTIONS="{}", IMAGES=None, IMAGE_LIST=None):
        # With is_input_list=True, every input arrives as a list. Unwrap singletons.
        OPTIONS = cls._unwrap(OPTIONS, default="{}")

        vars_dict = cls._parse_vars(OPTIONS)

        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})

        user_text = cls._read_state_text(node_inputs.get(cls.USER_WIDGET))
        system_text = cls._read_state_text(node_inputs.get(cls.SYSTEM_WIDGET))
        llm_text = cls._read_state_text(node_inputs.get(cls.LLM_WIDGET))

        # Cache images so JS-driven Generate calls include them in /newflow/llm/generate.
        # Combine both inputs: padded IMAGES (single tensor batch) + IMAGE_LIST
        # (native-sized list). tensor_to_b64_pngs handles tensor-or-list transparently.
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

        return io.NodeOutput(
            cls._substitute(user_text, vars_dict),
            cls._substitute(system_text, vars_dict),
            llm_text,
        )

    @staticmethod
    def _unwrap(value, default):
        """is_input_list=True wraps every input in a list; unwrap singleton scalars."""
        if isinstance(value, list):
            value = value[0] if value else None
        if value is None:
            return default
        return value

    @staticmethod
    def _parse_vars(raw):
        if isinstance(raw, dict):
            return raw
        if not isinstance(raw, str) or not raw.strip():
            return {}
        try:
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}

    @staticmethod
    def _read_state_text(raw) -> str:
        if raw is None:
            return ""
        if isinstance(raw, str):
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                return raw
            if isinstance(obj, dict):
                return str(obj.get("text", ""))
            return raw
        if isinstance(raw, dict):
            return str(raw.get("text", ""))
        return ""

    @staticmethod
    def _substitute(text: str, vars_dict: dict) -> str:
        def repl(match: re.Match) -> str:
            key = match.group(1).strip()
            if key in vars_dict:
                return str(vars_dict[key])
            return f"[MISSING: {key}]"

        return VAR_RE.sub(repl, text)
