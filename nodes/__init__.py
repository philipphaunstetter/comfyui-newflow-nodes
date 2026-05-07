from comfy_api.latest import io

from .image import NODES as IMAGE_NODES
from .inputs import NODES as INPUT_NODES
from .prompt import NODES as PROMPT_NODES
from .utils import NODES as UTIL_NODES

ALL_NODES: list[type[io.ComfyNode]] = [
    *INPUT_NODES,
    *PROMPT_NODES,
    *IMAGE_NODES,
    *UTIL_NODES,
]
