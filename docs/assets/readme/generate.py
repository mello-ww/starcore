"""Generates the README's SVG assets from StarCore's own branding.

Colours come from mission_control/tokens.css, the mark from Mission Control's
sidebar, and the Satellite icons from each Satellite's mission_control/icon.svg,
so the GitHub page can't drift from the real interface. Standard library only.

    python docs/assets/readme/generate.py

Writes header.svg, architecture.svg and satellite-<name>.svg next to itself.
"""

from pathlib import Path
import math
import re

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

# only the first :root block - the ones after it are the accent presets
_ROOT = re.search(r":root\s*\{(.*?)\n\}", (REPO / "mission_control/tokens.css").read_text("utf-8"), re.S).group(1)
TOKENS = dict(re.findall(r"--sc-([\w-]+):\s*(#[0-9a-fA-F]{6})", _ROOT))
BG, CARD, CONTROL, STRONG, LINE = (TOKENS[k] for k in ("bg", "card", "control", "control-strong", "line"))
TEXT, ICON, TEXT2, TEXT3, ACCENT = (TOKENS[k] for k in ("text", "text-icon", "text-2", "text-3", "accent"))

# what an <img> can use on GitHub: no web fonts, so the tokens' stacks minus the
# ones nobody has installed, ending in faces every platform ships
DISPLAY = "'Space Grotesk', Manrope, Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
SANS = "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace"

SATELLITES = [
    # (file name, label, icon source)
    ("status", "Status", "satellites/native/status"),
    ("photo", "Photo", "satellites/native/photo"),
    ("locked-folder", "Locked Folder", "satellites/native/locked_folder"),
    ("music", "Music", "satellites/native/music"),
    ("file-explorer", "File Explorer", "satellites/native/file_explorer"),
    ("docker", "Docker", "satellites/link/docker"),
]


def icon_body(folder: str) -> str:
    """The drawing inside a Satellite's icon.svg (its <svg> wrapper dropped)."""
    text = (REPO / folder / "mission_control/icon.svg").read_text("utf-8")
    return re.search(r"<svg[^>]*>(.*)</svg>", text, re.S).group(1).strip()


def icon(folder: str, x: float, y: float, size: float, color: str = ICON) -> str:
    scale = size / 24
    return (f'<g transform="translate({x:.1f} {y:.1f}) scale({scale:.4f})" fill="none" stroke="{color}" '
            f'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{icon_body(folder)}</g>')


def dots(x: float, y: float, w: float, h: float, step: int = 18) -> str:
    """The faint dot matrix Mission Control's cards use (--sc-dots)."""
    return (f'<pattern id="dots" width="{step}" height="{step}" patternUnits="userSpaceOnUse">'
            f'<circle cx="{step / 2}" cy="{step / 2}" r="1" fill="#ffffff" fill-opacity="0.09"/></pattern>'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="url(#dots)"/>')


def eyebrow(x: float, y: float, text: str, anchor: str = "start") -> str:
    return (f'<text x="{x}" y="{y}" fill="{TEXT3}" font-family="{SANS}" font-size="13" font-weight="600" '
            f'letter-spacing="3" text-anchor="{anchor}">{text.upper()}</text>')


def orbit_point(cx, cy, rx, ry, angle_deg, tilt_deg):
    t, tilt = math.radians(angle_deg), math.radians(tilt_deg)
    px, py = rx * math.cos(t), ry * math.sin(t)
    return (cx + px * math.cos(tilt) - py * math.sin(tilt),
            cy + px * math.sin(tilt) + py * math.cos(tilt))


def svg(width: int, height: int, title: str, body: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="t">\n'
            f'<title id="t">{title}</title>\n{body}\n</svg>\n')


def header() -> str:
    w, h = 1200, 300
    cx, cy, tilt = 930, 150, -22
    parts = [
        f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="16" fill="{BG}" stroke="{LINE}"/>',
        f'<defs><clipPath id="card"><rect x="1" y="1" width="{w - 2}" height="{h - 2}" rx="16"/></clipPath></defs>',
        f'<g clip-path="url(#card)">{dots(660, 0, 540, h)}</g>',
        # the sidebar's mark (circle, tilted orbit, a moon), drawn large
        f'<g transform="translate(72 70) scale(3.2)" fill="none" stroke="{TEXT}" stroke-width="1.1">'
        '<circle cx="11" cy="12" r="5"/>'
        '<ellipse cx="11" cy="12" rx="9.3" ry="3.3" transform="rotate(-22 11 12)" opacity="0.7"/>'
        f'<circle cx="19" cy="3" r="0.9" fill="{TEXT}" stroke="none"/></g>',
        eyebrow(76, 186, "Self-hosted platform"),
        f'<text x="72" y="244" fill="{TEXT}" font-family="{DISPLAY}" font-size="68" font-weight="700" '
        'letter-spacing="-1.5">StarCore</text>',
        # the ecosystem: one Engine, Satellites on two orbits, one of them in the accent
        f'<circle cx="{cx}" cy="{cy}" r="30" fill="{BG}" stroke="{TEXT}" stroke-width="1.5"/>',
        f'<circle cx="{cx}" cy="{cy}" r="4" fill="{TEXT}"/>',
        f'<ellipse cx="{cx}" cy="{cy}" rx="150" ry="50" transform="rotate({tilt} {cx} {cy})" fill="none" '
        f'stroke="{TEXT}" stroke-opacity="0.35"/>',
        f'<ellipse cx="{cx}" cy="{cy}" rx="225" ry="78" transform="rotate({tilt} {cx} {cy})" fill="none" '
        f'stroke="{TEXT}" stroke-opacity="0.16" stroke-dasharray="2 6"/>',
    ]
    for angle, (rx, ry), r, color in [
        (200, (150, 50), 5, ACCENT), (20, (150, 50), 4, ICON), (115, (150, 50), 3, TEXT3),
        (300, (225, 78), 4, ICON), (60, (225, 78), 3, TEXT3), (160, (225, 78), 3, TEXT3),
    ]:
        x, y = orbit_point(cx, cy, rx, ry, angle, tilt)
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r + 3}" fill="{BG}"/>'
                     f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{color}"/>')
    return svg(w, h, "StarCore", "\n".join(parts))


def tile(x, y, w, h, title, caption=None, folder=None, muted=False) -> str:
    parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{CARD}" stroke="{LINE}"/>']
    tx = x + 18
    if folder:
        parts.append(f'<rect x="{x + 14}" y="{y + (h - 36) / 2}" width="36" height="36" rx="9" fill="{CONTROL}"/>')
        parts.append(icon(folder, x + 22, y + (h - 36) / 2 + 8, 20, TEXT3 if muted else ICON))
        tx = x + 62
    if caption:
        parts.append(f'<text x="{tx}" y="{y + h / 2 - 3}" fill="{TEXT3 if muted else TEXT}" font-family="{DISPLAY}" '
                     f'font-size="16" font-weight="700">{title}</text>')
        parts.append(f'<text x="{tx}" y="{y + h / 2 + 17}" fill="{TEXT3}" font-family="{SANS}" font-size="13">{caption}</text>')
    else:
        parts.append(f'<text x="{tx}" y="{y + h / 2 + 6}" fill="{TEXT3 if muted else TEXT}" font-family="{DISPLAY}" '
                     f'font-size="16" font-weight="700">{title}</text>')
    return "".join(parts)


def connector(x, y1, y2, label=None) -> str:
    parts = [f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="{STRONG}" stroke-width="1.5"/>',
             f'<circle cx="{x}" cy="{y1}" r="3" fill="{STRONG}"/><circle cx="{x}" cy="{y2}" r="3" fill="{STRONG}"/>']
    if label:
        parts.append(f'<text x="{x + 12}" y="{(y1 + y2) / 2 + 4}" fill="{TEXT3}" font-family="{MONO}" font-size="12">{label}</text>')
    return "".join(parts)


def architecture() -> str:
    w, h = 960, 568
    pad = 40
    inner = w - 2 * pad
    parts = [
        f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="16" fill="{BG}" stroke="{LINE}"/>',
        f'<defs><clipPath id="card"><rect x="1" y="1" width="{w - 2}" height="{h - 2}" rx="16"/></clipPath></defs>',
        f'<g clip-path="url(#card)">{dots(w - 220, 0, 220, 150)}</g>',
    ]

    # clients
    parts.append(eyebrow(pad, 52, "Clients"))
    gap = 16
    cw = (inner - 2 * gap) / 3
    clients = [("Mission Control", "web interface"), ("StarCore for Android", "mobile app"), ("CLI", "interactive or one-shot")]
    for i, (title, caption) in enumerate(clients):
        parts.append(tile(pad + i * (cw + gap), 68, cw, 64, title, caption))
    parts.append(connector(w / 2, 140, 188, "HTTPS · JSON API · sessions"))

    # engine
    ey = 196
    parts.append(f'<rect x="{pad}" y="{ey}" width="{inner}" height="132" rx="16" fill="{CARD}" stroke="{LINE}"/>')
    parts.append(eyebrow(pad + 24, ey + 34, "Engine"))
    parts.append(f'<circle cx="{pad + inner - 32}" cy="{ey + 30}" r="4" fill="{ACCENT}"/>')
    parts.append(f'<text x="{pad + 24}" y="{ey + 68}" fill="{TEXT}" font-family="{DISPLAY}" font-size="24" '
                 'font-weight="700">StarCore Engine</text>')
    chips = ["API", "Authentication", "Configuration", "Satellite lifecycle", "Commands"]
    cx = pad + 24
    for chip in chips:
        cwid = 26 + len(chip) * 7.1
        parts.append(f'<rect x="{cx}" y="{ey + 86}" width="{cwid:.0f}" height="28" rx="8" fill="{CONTROL}"/>')
        parts.append(f'<text x="{cx + cwid / 2:.0f}" y="{ey + 105}" fill="{TEXT2}" font-family="{SANS}" font-size="13" '
                     f'text-anchor="middle">{chip}</text>')
        cx += cwid + 10
    parts.append(connector(w / 2, ey + 140, ey + 188, "Satellite interface"))

    # satellites
    sy = ey + 196
    parts.append(eyebrow(pad, sy + 8, "Satellites"))
    sw = (inner - 2 * gap) / 3
    native = SATELLITES[:5]
    for i, (_, label, folder) in enumerate(native):
        row, col = divmod(i, 3)
        parts.append(tile(pad + col * (sw + gap), sy + 24 + row * 70, sw, 56, label, folder=folder))
    # the one Link Satellite sits in the sixth slot, saying what it is
    lx, ly = pad + 2 * (sw + gap), sy + 24 + 70
    parts.append(tile(lx, ly, sw, 56, "Docker", "Link Satellite · placeholder", folder=SATELLITES[5][2], muted=True))
    return svg(w, h, "StarCore architecture: clients, the Engine and its Satellites", "\n".join(parts))


def satellite_tile(folder: str, label: str) -> str:
    body = (f'<rect x="0.5" y="0.5" width="47" height="47" rx="12" fill="{CARD}" stroke="{LINE}"/>'
            + icon(folder, 12, 12, 24))
    return svg(48, 48, label, body)


def main():
    (HERE / "header.svg").write_text(header(), "utf-8", newline="\n")
    (HERE / "architecture.svg").write_text(architecture(), "utf-8", newline="\n")
    for name, label, folder in SATELLITES:
        (HERE / f"satellite-{name}.svg").write_text(satellite_tile(folder, label), "utf-8", newline="\n")
    print("wrote", ", ".join(sorted(p.name for p in HERE.glob("*.svg"))))


if __name__ == "__main__":
    main()
