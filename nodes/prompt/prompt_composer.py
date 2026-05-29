import json
import re

from comfy_api.latest import io

from .llm_routes import combine_and_cache_images

VAR_RE = re.compile(r"\[\[\s*([^\[\]]+?)\s*\]\]")

MODE_TEMPLATED = "Templated"
MODE_PLAIN = "Plain"


class NewflowPromptComposer(io.ComfyNode):
    """Single Composer node with two modes selected via the top combo:

    - ``Templated`` (default): rich editor with ``[[Key]]`` variable
      substitution. OPTIONS is a STRING (JSON dict of ``{Key: value}``) wired
      from upstream (typically Newflow Dynamic Dropdowns).
    - ``Plain``: plain-text USER and SYSTEM fields — no variables, no pills.

    Both modes share the LLM Output editor, image inputs, settings dialog,
    Generate/Auto controls, and status badge. The merged node replaces the
    former ``NewflowPromptComposer`` + ``NewflowPromptComposerSimple`` pair;
    old ``NewflowPromptComposerSimple`` workflows auto-migrate to ``Plain``
    mode via NodeReplace registered in the extension's ``on_load``.
    """

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
                "Composes USER, SYSTEM, and LLM-OUTPUT strings from the same "
                "rich editors in both modes. In Templated mode, [[Key]] "
                "placeholders substitute from the OPTIONS JSON input (e.g. from "
                "Newflow Dynamic Dropdowns); missing keys render as "
                "[MISSING: Key]. In Plain mode, the prompts are emitted "
                "verbatim and the OPTIONS socket is hidden. Both modes share "
                "the LLM Output editor (streamed from Ollama), the image "
                "inputs, and the settings dialog. Accepts images via IMAGES "
                "(padded IMAGE batch) or IMAGE_LIST (native-resolution list "
                "from Newflow Image Batch) — vision LLMs see each image at "
                "full quality with no padding."
            ),
            inputs=[
                # Flat schema — every input lives at the top level so each
                # gets a proper, predictable socket. The `mode` Combo at the
                # bottom is just a plain widget; the JS uses its value to
                # show/hide the rich editor block vs the plain widgets, but
                # the schema does not gate inputs on mode. This intentionally
                # mirrors the union of the old Composer + Composer Simple
                # schemas plus a mode switcher.
                io.Image.Input(
                    "IMAGES",
                    optional=True,
                    tooltip="Optional reference image(s) — standard padded IMAGE batch.",
                ),
                io.Image.Input(
                    "IMAGE_LIST",
                    optional=True,
                    tooltip=(
                        "Optional IMAGE_LIST input — native-resolution list "
                        "from Newflow Image Batch. Each image keeps its "
                        "native dimensions for vision LLMs."
                    ),
                ),
                io.String.Input(
                    "OPTIONS",
                    default="{}",
                    optional=True,
                    force_input=True,
                    tooltip=(
                        "JSON of {label: value} from Newflow Dynamic Dropdowns. "
                        "Drives [[Key]] substitution in Templated mode. "
                        "Hidden in Plain mode (the frontend removes the socket)."
                    ),
                ),
                io.Combo.Input(
                    "mode",
                    options=[MODE_TEMPLATED, MODE_PLAIN],
                    default=MODE_TEMPLATED,
                    tooltip=(
                        "Templated: rich [[Key]] editors with slash-menu and "
                        "chip strip; OPTIONS drives substitution. Plain: the "
                        "USER and SYSTEM multiline inputs are used directly."
                    ),
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
    def execute(cls, mode, IMAGES=None, IMAGE_LIST=None, OPTIONS="{}"):
        # With is_input_list=True, every input arrives as a (length-1) list.
        selected = cls._unwrap(mode, default=MODE_TEMPLATED) or MODE_TEMPLATED
        options_raw = cls._unwrap(OPTIONS, default="{}")

        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        llm_text = cls._read_state_text(node_inputs.get(cls.LLM_WIDGET))

        # USER/SYSTEM come from the same rich-editor widget states
        # (user_prompt_state, system_prompt_state) in BOTH modes — the editors
        # are identical regardless of mode. Mode only decides whether [[Key]]
        # placeholders are substituted from the OPTIONS JSON.
        user_state = cls._read_state_text(node_inputs.get(cls.USER_WIDGET))
        system_state = cls._read_state_text(node_inputs.get(cls.SYSTEM_WIDGET))

        if selected == MODE_PLAIN:
            user_out = user_state
            system_out = system_state
        else:
            vars_dict = cls._parse_vars(options_raw)
            user_out = cls._substitute(user_state, vars_dict)
            system_out = cls._substitute(system_state, vars_dict)

        # Cache images so JS-driven Generate calls include them in
        # /newflow/llm/generate. Shared across both modes.
        combine_and_cache_images(unique_id, IMAGES, IMAGE_LIST)

        return io.NodeOutput(user_out, system_out, llm_text)

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
