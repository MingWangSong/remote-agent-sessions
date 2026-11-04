"""Build terminal ThemeIcons from the checked-in official SVG outlines.

Optional build dependency: pip install fonttools==4.60.1
Runtime uses only the checked-in WOFF; no Python or fontTools is required.
"""
from pathlib import Path
from xml.etree import ElementTree

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

root = Path(__file__).resolve().parents[1]
glyphs = {".notdef": TTGlyphPen(None).glyph()}
for name, source in [("codex", "codex-dark.svg"), ("claude", "claude.svg")]:
    svg = ElementTree.parse(root / "media/brands" / source).getroot()
    assert svg.get("viewBox") == "0 0 24 24"
    pen = TTGlyphPen(None)
    # 24 SVG units -> 1000 em, with SVG's y-down coordinates flipped to y-up.
    outline = TransformPen(Cu2QuPen(pen, max_err=0.5, reverse_direction=True),
                           (1000 / 24, 0, 0, -1000 / 24, 0, 850))
    for element in svg.findall("{http://www.w3.org/2000/svg}path"):
        parse_path(element.attrib["d"], outline)
    glyphs[name] = pen.glyph()

# COLR/CPAL keeps Claude's official terracotta without relying on terminal color
# overrides (VS Code only generates terminal CSS for its standard ANSI colors).
glyphs["claude.color"] = glyphs["claude"]
glyphs["claude"] = TTGlyphPen(None).glyph()

builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder(list(glyphs))
builder.setupCharacterMap({0xE001: "codex", 0xE002: "claude"})
builder.setupGlyf(glyphs)
builder.setupHorizontalMetrics({name: (1000, 0) for name in glyphs})
builder.setupHorizontalHeader(ascent=850, descent=-150)
builder.setupNameTable({"familyName": "TmuxDock Session Marks", "styleName": "Regular",
                        "uniqueFontIdentifier": "TmuxDockSessionMarks-1",
                        "fullName": "TmuxDock Session Marks", "psName": "TmuxDockSessionMarks"})
builder.setupOS2(sTypoAscender=850, sTypoDescender=-150, usWinAscent=850, usWinDescent=150)
builder.setupPost()
builder.setupMaxp()
builder.setupCOLR({"claude": [("claude.color", 0)]}, version=0)
builder.setupCPAL([[(217 / 255, 119 / 255, 87 / 255, 1)]])
builder.font["head"].created = builder.font["head"].modified = 2082844800
builder.font.recalcTimestamp = False
builder.font.flavor = "woff"
builder.font.save(root / "media/brands/session-marks.woff")
