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
                "Composes USER, SYSTEM, and LLM-OUTPUT strings. In Templated "
                "mode, [[Key]] placeholders substitute from the OPTIONS JSON "
                "input (e.g. from Newflow Dynamic Dropdowns); missing keys "
                "render as [MISSING: Key]. In Plain mode, USER and SYSTEM are "
                "direct multi-line STRING inputs with no substitution. Both "
                "modes share the LLM Output editor (streamed from Ollama), the "
                "image inputs, and the settings dialog. Accepts images via "
                "IMAGES (padded IMAGE batch) or IMAGE_LIST (native-resolution "
                "list from Newflow Image Batch) — vision LLMs see each image "
                "at full quality with no padding."
            ),
            inputs=[
                # Top-level data inputs. They're always visible (in both modes)
                # but only consumed by the matching branch in execute() — same
                # pattern as ImageBatch's IMAGE_N sockets being shared across
                # Slots/Wardrobe modes. We deliberately do NOT nest these
                # inside the DynamicCombo because:
                #  (1) io.DynamicCombo.Input cannot be the *first* schema input
                #      (the frontend addInputs chain crashes), and
                #  (2) nested String inputs don't reliably render an input
                #      socket — wires drawn to a nested OPTIONS land in dead
                #      space and the JS upstream-detection misses them.
                io.Image.Input(
                    "IMAGES",
                    optional=True,
                    tooltip="Optional reference image(s) — standard padded IMAGE batch.",
                ),
                io.Image.Input(
                    "IMAGE_LIST",
                    optional=True,
                    tooltip=(
                        "Optional IMAGE_LIST input — accepts the IMAGE_LIST "
                        "output of Newflow Image Batch. Each image keeps its "
                        "native dimensions (no padding) so vision LLMs see "
                        "them at full quality."
                    ),
                ),
                io.String.Input(
                    "OPTIONS",
                    default="{}",
                    optional=True,
                    tooltip=(
                        "JSON of {label: value} from Newflow Dynamic Dropdowns "
                        "or any STRING source. Drives [[Key]] substitution in "
                        "Templated mode. Ignored in Plain mode. Wire upstream "
                        "or paste JSON directly."
                    ),
                ),
                io.DynamicCombo.Input(
                    "mode",
                    options=[
                        io.DynamicCombo.Option(
                            MODE_TEMPLATED,
                            [
                                # Templated mode needs at least one widget in
                                # its sub-inputs to bypass the frontend's
                                # "all-sockets" crash. display_mode controls
                                # how variable pills render in the rich
                                # editors — promoted here from the old
                                # frontend-only dropdown.
                                io.Combo.Input(
                                    "display_mode",
                                    options=["source", "sourceValue", "valueOnly"],
                                    default="source",
                                    tooltip=(
                                        "Pill rendering in the rich editors. "
                                        "'source' shows just the key, 'sourceValue' "
                                        "shows 'Key: value', 'valueOnly' shows "
                                        "only the value (or '[MISSING]')."
                                    ),
                                ),
                            ],
                        ),
                        io.DynamicCombo.Option(
                            MODE_PLAIN,
                            [
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
                        ),
                    ],
                    tooltip=(
                        "Templated: rich editors with [[Key]] pills, OPTIONS "
                        "JSON drives substitution. Plain: direct USER and "
                        "SYSTEM text fields, no substitution."
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
        # OPTIONS and the DynamicCombo dict both arrive wrapped — unwrap.
        mode = cls._unwrap(mode, default={})
        if not isinstance(mode, dict):
            mode = {}
        options_raw = cls._unwrap(OPTIONS, default="{}")

        selected = mode.get("mode", MODE_TEMPLATED)

        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        llm_text = cls._read_state_text(node_inputs.get(cls.LLM_WIDGET))

        if selected == MODE_PLAIN:
            user_text = cls._unwrap(mode.get("USER"), default="") or ""
            system_text = cls._unwrap(mode.get("SYSTEM"), default="") or ""
            user_out, system_out = user_text, system_text
        else:
            # Templated path — read the rich-editor widget states and
            # substitute [[Key]] placeholders from the OPTIONS JSON (which
            # lives at the top level, not nested in the DynamicCombo).
            vars_dict = cls._parse_vars(options_raw)
            user_state = cls._read_state_text(node_inputs.get(cls.USER_WIDGET))
            system_state = cls._read_state_text(node_inputs.get(cls.SYSTEM_WIDGET))
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
