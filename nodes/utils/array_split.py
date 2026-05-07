from aiohttp import web
from server import PromptServer

from comfy_api.latest import io


# Module-level cache so NewflowArrayPick's frontend can show item previews in
# its dropdown. Populated on each execute(). Bounded to avoid unbounded growth
# across many array nodes / workflows.
ARRAY_CACHE: dict[str, list[str]] = {}
ARRAY_CACHE_LIMIT = 64


def _cache_items(unique_id: str, items: list[str]) -> None:
    if not unique_id:
        return
    ARRAY_CACHE[str(unique_id)] = list(items)
    while len(ARRAY_CACHE) > ARRAY_CACHE_LIMIT:
        ARRAY_CACHE.pop(next(iter(ARRAY_CACHE)))


class NewflowArraySplit(io.ComfyNode):
    """Splits a STRING by a user-configured separator into a list of items.

    Output is a list of strings (declared with is_output_list=True). Pair with
    NewflowArrayPick downstream to select one element by index.

    Side effect: caches the resulting items in ARRAY_CACHE keyed by the node's
    unique_id so the downstream NewflowArrayPick can show a dropdown of previews.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowArraySplit",
            display_name="Newflow Array Split",
            category="newflow/utils",
            description=(
                "Splits the input text by the given separator. Empty/whitespace "
                "items are dropped. Output is a list of strings — connect to a "
                "Newflow Array Pick node to select one by index."
            ),
            inputs=[
                io.String.Input("text", multiline=True, force_input=True),
                io.String.Input("separator", default="*"),
            ],
            outputs=[
                io.String.Output("array", is_output_list=True),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, text, separator):
        if not isinstance(text, str):
            text = "" if text is None else str(text)
        if not isinstance(separator, str) or separator == "":
            separator = "\n"

        raw = text.split(separator)
        items = [s.strip() for s in raw if s and s.strip()]

        if items:
            preview_lines = [
                f"[{i}] {item if len(item) <= 80 else item[:77] + '…'}"
                for i, item in enumerate(items)
            ]
            preview = "\n".join(preview_lines)
        else:
            preview = "(no items)"

        # Stash the items so the downstream Pick node's UI can show previews.
        try:
            unique_id = str(cls.hidden.unique_id)
            _cache_items(unique_id, items)
        except Exception:
            pass

        return io.NodeOutput(items, ui={"text": [preview]})


@PromptServer.instance.routes.get("/newflow/utils/array_items")
async def newflow_array_items(request: web.Request) -> web.Response:
    """Returns the cached items for a NewflowArraySplit node id.
    Used by the NewflowArrayPick frontend to populate its dropdown.
    """
    node_id = request.query.get("node_id", "")
    items = ARRAY_CACHE.get(str(node_id), [])
    return web.json_response({"node_id": str(node_id), "items": items})
