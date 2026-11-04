class SatelliteManifest:
    def __init__(self, name: str, version: str, author: str, description: str, icon: str = None,
                 section_of: str = None, icon_name: str = None, provides: dict = None):
        self.name = name
        self.version = version
        self.author = author
        self.description = description
        # optional filename (e.g. "icon.svg") of an icon this satellite ships
        # under its own mission_control/ directory - resolved and validated at
        # load time by SatelliteLoader, served through the same generic
        # /api/satellites/<name>/assets/<file> route as page.js/page.css.
        # None means "no icon" and Mission Control falls back to a generic one.
        self.icon = icon
        # optional name of another satellite whose page hosts this one's
        # interface as a section, e.g. a private area shown as a tab.
        # Purely presentational: clients leave it out of their own
        # navigation and open the host instead. Never an access control -
        # every route stays as protected as any other.
        self.section_of = section_of
        # optional name from the shared icon set (contracts/ui/vocabulary.json)
        # that every client can draw natively - the Android app can't draw a
        # Satellite's own SVG, so without this it shows a generic icon
        self.icon_name = icon_name
        # Satellite capabilities this one provides to others, normalised by
        # ui_contract.normalise_provides: {"files.browse": {"version": 1,
        # "operations": {"list": "entries"}}}. Shared blocks (a file browser,
        # later a media picker) are bound to a capability, never to the
        # Satellite that happens to provide it - see docs/ui-contract.md.
        self.provides = provides or {}
