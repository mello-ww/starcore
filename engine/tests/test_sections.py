"""starcore.sections: the Satellites a host's manifest-declared sections are, from the registry."""

from types import SimpleNamespace
import unittest

from starcore import sections


def satellite(name, section_of=None, enabled=True, icon_name=None, title=None, error=None):
    document = {"title": title} if title is not None else {}
    ui = SimpleNamespace(document=document, error=error) if title is not None or error else None
    manifest = SimpleNamespace(name=name, section_of=section_of, icon_name=icon_name, description=f"{name} things")
    return SimpleNamespace(manifest=manifest, enabled=enabled, ui=ui)


def engine(*satellites):
    return SimpleNamespace(registry=SimpleNamespace(all=lambda: list(satellites)))


class HostedSectionsTest(unittest.TestCase):
    def test_only_the_enabled_satellites_naming_the_host_in_registry_order(self):
        found = sections.hosted(engine(
            satellite("Host"),
            satellite("SecretPlace", section_of="Host", icon_name="lock", title="Secret place"),
            satellite("Elsewhere", section_of="Other"),
            satellite("Asleep", section_of="Host", enabled=False),
            satellite("PlainName", section_of="Host"),
        ), "Host")
        self.assertEqual(found, [
            {"name": "SecretPlace", "title": "Secret place", "icon": "lock", "description": "SecretPlace things"},
            {"name": "PlainName", "title": "Plain Name", "icon": "folder", "description": "PlainName things"},
        ])

    def test_a_refused_document_gives_no_title(self):
        found = sections.hosted(engine(satellite("BrokenDoc", section_of="Host", title="Ignored", error="invalid")), "Host")
        self.assertEqual(found[0]["title"], "Broken Doc")

    def test_a_satellite_never_hosts_itself(self):
        self.assertEqual(sections.hosted(engine(satellite("Loop", section_of="Loop")), "Loop"), [])


if __name__ == "__main__":
    unittest.main()
