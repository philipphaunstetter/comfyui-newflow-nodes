import json

from comfy_api.latest import io


class NewflowDynamicDropdowns(io.ComfyNode):
    WIDGET_NAME = "config"

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowDynamicDropdowns",
            display_name="Newflow Dynamic Dropdowns",
            category="newflow/inputs",
            description=(
                "A single node holding any number of user-configured dropdowns. "
                "Outputs a JSON string of {label: selected_value}. "
                "Dropdowns set to (none) are skipped."
            ),
            inputs=[],
            outputs=[io.String.Output("variables")],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls):
        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        raw = node_inputs.get(cls.WIDGET_NAME, "[]")

        try:
            rows = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            rows = []
        if not isinstance(rows, list):
            rows = []

        out: dict[str, str] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            label = (row.get("label") or "").strip()
            value = row.get("selected")
            if not label or value in (None, "", "(none)"):
                continue
            key = label
            i = 2
            while key in out:
                key = f"{label}_{i}"
                i += 1
            out[key] = value

        return io.NodeOutput(json.dumps(out, ensure_ascii=False))
