from .prompt_composer import NewflowPromptComposer
from .prompt_composer_simple import NewflowPromptComposerSimple
from . import llm_routes  # registers /newflow/llm/* HTTP routes at import time

__all__ = ["NewflowPromptComposer", "NewflowPromptComposerSimple", "NODES", "llm_routes"]

NODES = [NewflowPromptComposer, NewflowPromptComposerSimple]
