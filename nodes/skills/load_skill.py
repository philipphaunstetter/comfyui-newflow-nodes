from __future__ import annotations

import os
import zipfile
from pathlib import Path

import folder_paths
from comfy_api.latest import io

# Text reference files worth inlining. Binary assets (images, etc.) are skipped.
_REF_EXTS = (".md", ".json", ".txt", ".yaml", ".yml")


def _skill_options() -> list[str]:
    """One entry per skill, keyed by top folder name (or filename stem for a
    root-level file). Recognizes extracted skills (``*.md`` / ``SKILL.md``) and
    packaged ``*.skill`` zip bundles; everything else is ignored."""
    seen: set[str] = set()
    options: list[str] = []
    for f in folder_paths.get_filename_list("skills"):
        low = f.lower()
        if not (low.endswith(".md") or low.endswith(".skill")):
            continue
        p = Path(f)
        key = p.parts[0] if len(p.parts) > 1 else p.stem
        if key not in seen:
            seen.add(key)
            options.append(key)
    return options or ["(no skills found)"]


def _strip_frontmatter(text: str, default_name: str) -> tuple[str, str]:
    """Drop a leading ``---`` YAML block and pull ``name:`` out of it."""
    name = default_name
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
    return body, name


def _read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


def _read_folder_references(ref_dir: str) -> list[tuple[str, str]]:
    """Read every text file under an extracted ``reference/`` directory."""
    refs: list[tuple[str, str]] = []
    if not os.path.isdir(ref_dir):
        return refs
    for root, _dirs, files in os.walk(ref_dir):
        for fname in sorted(files):
            if not fname.lower().endswith(_REF_EXTS):
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, ref_dir).replace(os.sep, "/")
            try:
                refs.append((rel, _read_text(full)))
            except OSError:
                pass
    return refs


def _read_skill_zip(zip_path: str) -> tuple[str, list[tuple[str, str]]]:
    """Pull SKILL.md (and any ``reference/`` text files) out of a ``.skill`` zip.

    A ``.skill`` is a zip whose entries live under a single top folder, e.g.
    ``model-set-card-refiner/SKILL.md`` and
    ``model-set-card-refiner/reference/texture_vocabulary.md``.
    """
    body = ""
    refs: list[tuple[str, str]] = []
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = [n for n in zf.namelist() if not n.endswith("/")]
            skill_entry = next(
                (n for n in names if n.lower().endswith("skill.md")), None
            )
            if skill_entry:
                body = zf.read(skill_entry).decode("utf-8", errors="replace")
            for n in names:
                low = n.lower()
                if "reference/" not in low or not low.endswith(_REF_EXTS):
                    continue
                rel = n.split("reference/", 1)[1]
                if not rel:
                    continue
                try:
                    refs.append((rel, zf.read(n).decode("utf-8", errors="replace")))
                except (KeyError, OSError):
                    pass
    except (zipfile.BadZipFile, OSError):
        pass
    return body, refs


def _read_skill(skill_name: str) -> tuple[str, str, list[tuple[str, str]]] | None:
    """Resolve a selected skill to ``(raw_body, name, references)``.

    Priority: extracted ``SKILL.md`` (with sibling ``reference/``) → a
    ``*.skill`` zip in the folder → first ``*.md`` in the folder (legacy) →
    root-level ``<name>.skill`` → root-level ``<name>.md`` (legacy).
    """
    base = os.path.join(folder_paths.base_path, "skills")
    folder = os.path.join(base, skill_name)

    if os.path.isdir(folder):
        skill_md = os.path.join(folder, "SKILL.md")
        if os.path.isfile(skill_md):
            refs = _read_folder_references(os.path.join(folder, "reference"))
            return _read_text(skill_md), skill_name, refs

        zips = sorted(n for n in os.listdir(folder) if n.lower().endswith(".skill"))
        if zips:
            body, refs = _read_skill_zip(os.path.join(folder, zips[0]))
            if body:
                return body, skill_name, refs

        for fname in sorted(os.listdir(folder)):
            if fname.lower().endswith(".md"):
                return _read_text(os.path.join(folder, fname)), skill_name, []

    root_zip = os.path.join(base, skill_name + ".skill")
    if os.path.isfile(root_zip):
        body, refs = _read_skill_zip(root_zip)
        if body:
            return body, skill_name, refs

    root_md = os.path.join(base, skill_name + ".md")
    if os.path.isfile(root_md):
        return _read_text(root_md), skill_name, []

    return None


def _format_references(refs: list[tuple[str, str]]) -> str:
    """Render reference files as a clearly-labeled appendix to the skill body.

    Inlined because the downstream Skill Prompt sends one flat, non-interactive
    message to the LLM — the model can't open files, so SKILL.md's
    "see reference/…" pointers only work if the content is physically present.
    """
    if not refs:
        return ""
    out = [
        "\n\n---\n\n# Skill reference material",
        "The skill above refers to these files. Use them as needed.",
    ]
    for rel, text in refs:
        body = text.strip()
        if rel.lower().endswith(".json"):
            out.append(f"\n## reference/{rel}\n\n```json\n{body}\n```")
        else:
            out.append(f"\n## reference/{rel}\n\n{body}")
    return "\n".join(out)


class NewflowLoadSkill(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewflowLoadSkill",
            display_name="Newflow Load Skill",
            category="newflow/skills",
            description=(
                "Load a skill from ComfyUI/skills/. Accepts an extracted folder "
                "(SKILL.md + optional reference/), a packaged .skill zip, or a "
                "plain .md file. Strips YAML frontmatter and outputs the body — "
                "with reference files inlined so a local LLM actually receives "
                "them."
            ),
            inputs=[
                io.Combo.Input(
                    "skill_file",
                    options=_skill_options(),
                    tooltip="Select a skill from ComfyUI/skills/",
                ),
                io.Boolean.Input(
                    "include_references",
                    default=True,
                    optional=True,
                    tooltip=(
                        "Inline reference/ files (vocab, worked examples) into "
                        "the body so a local LLM receives them — SKILL.md's "
                        "'see reference/…' pointers don't work otherwise. Turn "
                        "off to emit only SKILL.md and keep the prompt small."
                    ),
                ),
            ],
            outputs=[
                io.String.Output("BODY"),
                io.String.Output("NAME"),
            ],
        )

    @classmethod
    def execute(cls, skill_file: str, include_references: bool = True):
        result = _read_skill(skill_file)
        if result is None:
            return io.NodeOutput(f"[skill not found: {skill_file}]", skill_file)

        raw_body, name, refs = result
        body, name = _strip_frontmatter(raw_body, name)
        out = body.strip()
        if include_references and refs:
            out += _format_references(refs)
        return io.NodeOutput(out, name)
