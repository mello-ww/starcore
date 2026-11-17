"""A Satellite's own icons (engine/starcore/icons.py): what the Engine accepts from an SVG file,
what it turns it into, and how a document names one (UI contract 1.2, contract change 5)."""

from pathlib import Path
import json
import tempfile
import unittest

from starcore import icons, ui_contract

HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">'


def svg(body: str, head: str = HEAD) -> str:
    return f"{head}{body}</svg>"


class NormaliseTests(unittest.TestCase):
    def test_every_shape_becomes_absolute_path_data(self):
        icon = icons.normalise_svg(svg(
            '<line x1="1" y1="2" x2="3" y2="4"/>'
            '<polyline points="1 1, 2 2 3 1"/>'
            '<polygon points="0,0 4,0 4,4"/>'
            '<rect x="2" y="2" width="4" height="3"/>'
            '<g><path d="m1 1 2 0 0 2z"/></g>'
            '<title>ignored</title>'))
        self.assertEqual(icon["stroke"], 1.6)
        self.assertEqual(icon["paths"], [
            "M1 2L3 4",
            "M1 1L2 2L3 1",
            "M0 0L4 0L4 4Z",
            "M2 2L6 2L6 5L2 5Z",
            "M1 1L3 1L3 3Z",
        ])

    def test_circles_and_rounded_rectangles_become_cubic_curves(self):
        icon = icons.normalise_svg(svg('<circle cx="12" cy="12" r="10"/><rect x="0" y="0" width="10" height="10" rx="2"/>'))
        circle, rect = icon["paths"]
        self.assertTrue(circle.startswith("M22 12C22 17.523 17.523 22 12 22C"))
        self.assertTrue(circle.endswith("Z"))
        self.assertEqual(circle.count("C"), 4)
        self.assertEqual(rect.count("C"), 4)
        self.assertTrue(rect.startswith("M2 0L8 0C"))

    def test_relative_and_shorthand_commands(self):
        [path] = icons.normalise_svg(svg('<path d="M2 2h4v4H2V2zM10 10q2 -2 4 0t4 0s2 2 4 0"/>'))["paths"]
        self.assertTrue(path.startswith("M2 2L6 2L6 6L2 6L2 2ZM10 10C"))
        self.assertTrue(ui_contract.valid_icon_path(path))
        self.assertTrue(path.endswith("22 10"))

    def test_arcs_become_cubic_curves_ending_where_the_arc_ends(self):
        # half a circle of radius 4, then the flags written together ("018 0"), as SVG allows
        [half] = icons.normalise_svg(svg('<path d="M8 12a4 4 0 0 1 8 0"/>'))["paths"]
        self.assertEqual(half.count("C"), 2)
        self.assertTrue(half.endswith("16 12"))
        self.assertIn("12 8", half)  # passes through the top of the circle
        [compact] = icons.normalise_svg(svg('<path d="M8 12a4 4 0 018 0"/>'))["paths"]
        self.assertEqual(compact, half)

    def test_refused_files(self):
        refused = {
            "a DOCTYPE": '<!DOCTYPE svg [<!ENTITY x "y">]>' + svg('<path d="M0 0L1 1"/>'),
            "a script": svg('<script>alert(1)</script>'),
            "a style": svg('<style>path{}</style>'),
            "a link": svg('<use href="#a"/>'),
            "an xlink": svg('<path xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="x" d="M0 0L1 1"/>'),
            "an event": svg('<path onclick="x()" d="M0 0L1 1"/>'),
            "a transform": svg('<path transform="scale(2)" d="M0 0L1 1"/>'),
            "a fill": svg('<path fill="red" d="M0 0L1 1"/>'),
            "a colour": svg('<path stroke="#f00" d="M0 0L1 1"/>'),
            "a foreign element": svg('<foreignObject/>'),
            "an image": svg('<image width="1" height="1"/>'),
            "another view box": svg('<path d="M0 0L1 1"/>', HEAD.replace("0 0 24 24", "0 0 48 48")),
            "no fill none": svg('<path d="M0 0L1 1"/>', HEAD.replace(' fill="none"', "")),
            "a thick stroke": svg('<path d="M0 0L1 1"/>', HEAD.replace('stroke-width="1.6"', 'stroke-width="9"')),
            "nothing drawn": svg(''),
            "a bad path": svg('<path d="M0 0 X 1"/>'),
            "a path without M": svg('<path d="L1 1"/>'),
            "a bad arc flag": svg('<path d="M0 0a1 1 0 2 1 2 2"/>'),
            "text": svg('hello<path d="M0 0L1 1"/>'),
            "not XML": "<svg",
            "not svg": '<html xmlns="http://www.w3.org/1999/xhtml"/>',
            "too many shapes": svg('<line x1="0" y1="0" x2="1" y2="1"/>' * 33),
            "a huge number": svg('<line x1="0" y1="0" x2="1e9" y2="1"/>'),
        }
        for reason, text in refused.items():
            with self.subTest(reason), self.assertRaises(icons.IconError):
                icons.normalise_svg(text)

    def test_every_shipped_icon_is_accepted(self):
        repository = Path(__file__).resolve().parents[2]
        files = sorted(repository.glob("satellites/*/*/icons/*.svg"))
        self.assertTrue(files)
        for path in files:
            with self.subTest(str(path.relative_to(repository))):
                icon = icons.read_icon(path)
                self.assertTrue(all(ui_contract.valid_icon_path(item) for item in icon["paths"]))


class DeclaredTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        (self.root / "icons").mkdir()
        (self.root / "icons" / "dot.svg").write_text(svg('<line x1="12" y1="12" x2="12.01" y2="12"/>'), "utf-8")
        (self.root / "icons" / "bad.svg").write_text(svg('<script/>'), "utf-8")

    def tearDown(self):
        self.folder.cleanup()

    def test_a_refused_file_keeps_its_fallback_and_bad_declarations_are_left_out(self):
        loaded, problems = icons.load_icons(self.root, {
            "dot": "circle", "bad": "box", "gone": "box", "camera": "camera", "Bad_Name": "box", "odd": "nope",
        })
        self.assertEqual(loaded["dot"], {"fallback": "circle", "stroke": 1.6, "paths": ["M12 12L12.01 12"]})
        self.assertEqual(loaded["bad"], {"fallback": "box"})
        self.assertEqual(loaded["gone"], {"fallback": "box"})
        self.assertEqual(set(loaded), {"dot", "bad", "gone"})
        self.assertEqual(len(problems), 5)

    def test_the_document_carries_the_icons_and_may_name_them(self):
        loaded, _ = icons.load_icons(self.root, {"dot": "circle"})
        document = {"contract": "starcore.ui/1.2", "entry": "home",
                    "navigation": [{"page": "home", "label": "Home", "icon": "dot"}],
                    "pages": {"home": {"title": "Home", "blocks": [
                        {"type": "list", "items": "$.rows", "item": {"title": "$.name", "icon": "dot"}}]}}}
        path = self.root / "ui.json"
        path.write_text(json.dumps(document), "utf-8")
        definition = ui_contract.load_definition(self.root, "Fake", icons=loaded)
        self.assertIsNone(definition.error)
        self.assertEqual(definition.document["icons"], loaded)

        # the revision follows the icon's file
        changed = dict(loaded, dot=dict(loaded["dot"], paths=["M1 1L2 2"]))
        self.assertNotEqual(ui_contract.load_definition(self.root, "Fake", icons=changed).revision, definition.revision)

        # a name the Satellite doesn't declare is refused, and a ui.json can't write icons itself
        self.assertIsNotNone(ui_contract.load_definition(self.root, "Fake").error)
        path.write_text(json.dumps(dict(document, icons=loaded)), "utf-8")
        self.assertIn("satellite.toml", ui_contract.load_definition(self.root, "Fake", icons=loaded).error)

    def test_a_served_documents_icons_are_checked(self):
        base = {"contract": "starcore.ui/1.2", "entry": "home", "pages": {"home": {"title": "Home", "blocks": []}}}
        self.assertEqual(ui_contract.validate(dict(base, icons={"dot": {"fallback": "circle"}})), [])
        for icons_value in ({"camera": {"fallback": "camera"}}, {"dot": {"fallback": "nope"}},
                            {"dot": {"fallback": "circle", "stroke": 2, "paths": ["<script>"]}},
                            {"dot": {"fallback": "circle", "stroke": 9, "paths": ["M1 1L2 2"]}},
                            {"dot": {"fallback": "circle", "extra": 1}}):
            with self.subTest(icons_value):
                self.assertTrue(ui_contract.validate(dict(base, icons=icons_value)))
        self.assertTrue(ui_contract.validate(dict(base, contract="starcore.ui/1.1", icons={"dot": {"fallback": "circle"}})))


if __name__ == "__main__":
    unittest.main()
