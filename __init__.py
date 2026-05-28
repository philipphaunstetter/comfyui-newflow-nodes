from typing_extensions import override
from comfy_api.latest import ComfyAPI, ComfyExtension, io

from .nodes import ALL_NODES

WEB_DIRECTORY = "./js"


class NewflowExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return ALL_NODES

    @override
    async def on_load(self) -> None:
        # Auto-migrate the two retired node ids into the merged nodes.
        # Old saved workflows that reference NewflowPromptComposerSimple or
        # NewflowImageArray load transparently with the new node, with mode
        # pre-set to the matching branch.
        api = ComfyAPI()

        # Prompt Composer (Simple) → Prompt Composer (Plain mode).
        # Old node had USER, SYSTEM as multiline string widgets and
        # llm_output_state as a DOM widget. The wired image sockets keep
        # the same ids (IMAGES, IMAGE_LIST) and reconnect automatically.
        await api.node_replacement.register(io.NodeReplace(
            new_node_id="NewflowPromptComposer",
            old_node_id="NewflowPromptComposerSimple",
            old_widget_ids=["USER", "SYSTEM", "llm_output_state"],
            input_mapping=[
                {"new_id": "mode", "set_value": "Plain"},
                {"new_id": "mode.USER", "old_id": "USER"},
                {"new_id": "mode.SYSTEM", "old_id": "SYSTEM"},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},  # USER
                {"new_idx": 1, "old_idx": 1},  # SYSTEM
                {"new_idx": 2, "old_idx": 2},  # OUTPUT
            ],
        ))

        # Image Array (Clothing) → Image Batch (Wardrobe mode).
        # Old node had a single `containers` DOM widget holding the wardrobe
        # JSON. NodeReplace can't expand it into N positional garment_N
        # widgets on its own — js/image_batch.js does that in
        # beforeConfigureGraph BEFORE NodeReplace runs. Here we only declare
        # the simple input mappings (mode and the 4 external IMAGE sockets).
        await api.node_replacement.register(io.NodeReplace(
            new_node_id="NewflowImageBatch",
            old_node_id="NewflowImageArray",
            old_widget_ids=["containers"],
            input_mapping=[
                {"new_id": "mode", "set_value": "Wardrobe"},
                {"new_id": "mode.IMAGE_1", "old_id": "IMAGE_1"},
                {"new_id": "mode.IMAGE_2", "old_id": "IMAGE_2"},
                {"new_id": "mode.IMAGE_3", "old_id": "IMAGE_3"},
                {"new_id": "mode.IMAGE_4", "old_id": "IMAGE_4"},
            ],
            output_mapping=[
                {"new_idx": 0, "old_idx": 0},  # IMAGE
                {"new_idx": 1, "old_idx": 1},  # IMAGE_LIST
            ],
        ))


async def comfy_entrypoint() -> NewflowExtension:
    return NewflowExtension()
