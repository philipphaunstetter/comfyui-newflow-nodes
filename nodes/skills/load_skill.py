from __future__ import annotations

import os
from pathlib import Path

import folder_paths
from comfy_api.latest import io


def _skill_options() -> list[str]:
    """Return one entry per skill: the folder name for subfolder skills,
    or the filename stem for root-level .md files. Skips non-.md files."""
    seen: set[str] = set()
    options: list[str] = []
    for f in folder_paths.get_filename_list("skills"):
        if not f.lower().endswith(".md"):
            continue
        p = Path(f)
        key = p.parts[0] if len(p.parts) > 1 else p.stem
        if key not in seen:
            seen.add(key)
            options.append(key)
    return options or ["(no skills found)"]


def _find_skill_path(skill_name: str) -> str | None:
    """Resolve a skill name to an absolute .md path.

    Checks subfolder first (skills/<name>/<any>.md), then root file
    (skills/<name>.md).
    """
    base = os.path.join(folder_paths.base_path, "skills")
    folder = os.path.join(base, skill_name)
    if os.path.isdir(folder):
        for fname in sorted(os.listdir(folder)):
            if fname.lower().endswith(".md"):
                return os.path.join(folder, fname)
    root_file = os.path.join(base, skill_name + ".md")
    if os.path.isfile(root_file):
        return root_file
    return None


class NewflowLoadSkill(io.ComfyNode):
    @classmethod
    def define_schema(cls):
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
                    options=_skill_options(),
                    tooltip="Select a skill from ComfyUI/skills/",
                ),
            ],
            outputs=[
                io.String.Output("BODY"),
                io.String.Output("NAME"),
            ],
        )

    @classmethod
    def execute(cls, skill_file: str):
        path = _find_skill_path(skill_file)
        if not path:
            return io.NodeOutput(f"[skill not found: {skill_file}]", skill_file)

        text = Path(path).read_text(encoding="utf-8")
        name = skill_file
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
