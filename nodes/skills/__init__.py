import os

import folder_paths

# Register ComfyUI/skills/ as the "skills" folder_paths directory,
# parallel to ComfyUI/models/.
_skills_dir = os.path.join(folder_paths.base_path, "skills")
os.makedirs(_skills_dir, exist_ok=True)
folder_paths.add_model_folder_path("skills", _skills_dir)

from .load_skill import NewflowLoadSkill
from .skill_prompt import NewflowSkillPrompt

__all__ = ["NewflowLoadSkill", "NewflowSkillPrompt", "NODES"]

NODES = [NewflowLoadSkill, NewflowSkillPrompt]
