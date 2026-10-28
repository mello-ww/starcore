"""Targeted, comment-preserving edits to a single key in a TOML file.

tomllib (the standard library's TOML reader) is read-only, and a full
dict-to-TOML dump would strip every comment from any file it touched. This
instead locates just the one `key = value` line that changed - inside a
`[section]` block, or at the top level of a flat file that has no sections at
all, as every satellite's own `config.toml` is - and rewrites only that line,
leaving comments, key order and everything else exactly as it was.

Used by both `engine_config.Configuration` (the Core's own `[section]`-based
`config.toml`) and `satellite_config.SatelliteConfig` (a satellite's flat one),
so persistence works identically - and is only implemented once - everywhere
a setting gets saved.
"""

from pathlib import Path
import os
import re

_SECTION_RE = re.compile(r"^\[(?P<name>[^\[\]]+)\]\s*(#.*)?$")


def write_value(path: Path, section, key: str, value) -> None:
    """Writes `key = value`, creating the file or the section if needed.

    `section` is the name of a `[section]` block to write into, or None to
    write a top-level key in a flat file. Only the target line changes -
    everything else in the file is left byte-for-byte as it was, including
    its line-ending convention.
    """
    path = Path(path)
    # read_text() applies universal-newline translation, which would hide a
    # CRLF file's line endings before they could be detected - the raw bytes
    # are checked instead, so the file's existing convention is preserved
    newline = "\r\n" if path.exists() and b"\r\n" in path.read_bytes() else "\n"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    formatted = _format_scalar(value)

    search_start, search_end = _section_bounds(lines, section)

    if search_start is None:
        # only possible for a named section that does not exist yet - a flat,
        # section-less file always has a top-level region to write into
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{section}]")
        lines.append(f"{key} = {formatted}")
    else:
        key_pattern = re.compile(rf"^(?P<indent>\s*){re.escape(key)}(?P<eq>\s*=\s*)(?P<value>[^#]*)(?P<comment>#.*)?$")
        for index in range(search_start, search_end):
            match = key_pattern.match(lines[index])
            if match:
                comment = match.group("comment") or ""
                spacer = " " if comment else ""
                lines[index] = f"{match.group('indent')}{key}{match.group('eq')}{formatted}{spacer}{comment}".rstrip()
                break
        else:
            lines.insert(search_end, f"{key} = {formatted}")

    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    text = newline.join(lines)
    if text:
        text += newline
    partial.write_text(text, encoding="utf-8", newline="")
    os.replace(partial, path)


def _section_bounds(lines: list, section) -> tuple:
    """The line range holding `section`'s keys.

    For a named section, this excludes its own `[section]` header line and
    returns (None, len(lines)) when that section does not exist yet. For
    section=None - a flat file - it's everything before the first `[...]`
    header, or the whole file when there are none, which always exists.
    """
    if section is None:
        for index, line in enumerate(lines):
            if _SECTION_RE.match(line.strip()):
                return 0, index
        return 0, len(lines)

    start = None
    for index, line in enumerate(lines):
        match = _SECTION_RE.match(line.strip())
        if not match:
            continue
        if start is not None:
            return start + 1, index
        if match.group("name").strip() == section:
            start = index

    return (start + 1, len(lines)) if start is not None else (None, len(lines))


def _format_scalar(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        # a TOML inline array - needed the moment any satellite ships a
        # list-typed config default for reconcile() to write out; every
        # element is itself formatted the same way, so a list of inline
        # tables (see the dict case below) works too
        return "[" + ", ".join(_format_scalar(item) for item in value) + "]"
    if isinstance(value, dict):
        # a TOML inline table - {} formats to the empty inline table "{ }"
        # (empty tables aren't otherwise reachable through a scalar default)
        return "{ " + ", ".join(f"{key} = {_format_scalar(inner)}" for key, inner in value.items()) + " }"

    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
