from __future__ import annotations

import os
from pathlib import Path

import folder_paths
from comfy_api.latest import io


class NewflowLoadSkill(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        skill_files = folder_paths.get_filename_list("skills")
        return io.Schema(
            node_id="NewflowLoadSkill",
            display_name="Newflow Load Skill",
            category="newflow/skills",
            description=(
                "Load a skill .md file from ComfyUI/skills/. "
                "Strips YAML frontmatter and outputs the body text."
            ),
            inputs=[
                io.Combo.Input(
                    "skill_file",
                    options=skill_files,
                    tooltip="Select a .md skill file",
                ),
            ],
            outputs=[
                io.String.Output("BODY"),
                io.String.Output("NAME"),
            ],
        )

    @classmethod
    def execute(cls, skill_file: str):
        path = folder_paths.get_full_path("skills", skill_file)
        if not path or not os.path.isfile(path):
            stem = Path(skill_file).stem
            return io.NodeOutput(f"[skill not found: {skill_file}]", stem)

        text = Path(path).read_text(encoding="utf-8")
        name = Path(skill_file).stem
        body = text

        if text.startswith("---\n"):
            end = text.find("\n---\n", 4)
            if end != -1:
                frontmatter = text[4:end]
                body = text[end + 5:]
                for line in frontmatter.splitlines():
                    if line.startswith("name:"):
                        name = line[5:].strip().strip('"').strip("'")
                        break

        return io.NodeOutput(body.strip(), name)
