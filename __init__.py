from typing_extensions import override
from comfy_api.latest import ComfyExtension, io

from .nodes import ALL_NODES

WEB_DIRECTORY = "./js"


class NewflowExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return ALL_NODES


async def comfy_entrypoint() -> NewflowExtension:
    return NewflowExtension()
