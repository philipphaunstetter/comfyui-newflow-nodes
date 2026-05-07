from comfy_api.latest import io


class NewflowArrayPick(io.ComfyNode):
    """Picks one element from a STRING array by index.

    Pairs with NewflowArraySplit upstream. Uses schema-level `is_input_list=True`
    so the connected list flows through as a Python list (instead of ComfyUI
    auto-iterating once per item).

    The index is carried by the JS-side dropdown DOM widget (named "index",
    `serialize: true`). It's read from `cls.hidden.prompt` rather than declared
    as a schema INT input — that avoids the Vue frontend rendering a redundant
    visible number field whose empty value blocks type validation.
    """

    INDEX_WIDGET = "index"

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowArrayPick",
            display_name="Newflow Array Pick",
            category="newflow/utils",
            description=(
                "Picks one item from a string array (e.g. the output of "
                "Newflow Array Split) by index. Index is clamped to a valid "
                "range; out-of-bounds clamps to the last item."
            ),
            inputs=[
                io.String.Input("array", force_input=True),
            ],
            outputs=[io.String.Output("item")],
            hidden=[io.Hidden.prompt, io.Hidden.unique_id],
            is_input_list=True,
        )

    @classmethod
    def execute(cls, array):
        prompt = cls.hidden.prompt or {}
        unique_id = str(cls.hidden.unique_id)
        node_inputs = prompt.get(unique_id, {}).get("inputs", {})
        raw_index = node_inputs.get(cls.INDEX_WIDGET, 0)
        if isinstance(raw_index, list):
            raw_index = raw_index[0] if raw_index else 0
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            index = 0

        # Coerce array to a flat list of strings, dropping None.
        if array is None:
            array = []
        elif not isinstance(array, list):
            array = [array]
        items: list[str] = []
        for v in array:
            if v is None:
                continue
            if isinstance(v, list):
                # Defensive: in case of nested wrapping.
                for inner in v:
                    if inner is None:
                        continue
                    items.append(str(inner))
            else:
                items.append(str(v))

        if not items:
            return io.NodeOutput("", ui={"text": ["(empty array)"]})

        idx = max(0, min(index, len(items) - 1))
        picked = items[idx]
        preview = f"[{idx}] {picked}"
        return io.NodeOutput(picked, ui={"text": [preview]})
