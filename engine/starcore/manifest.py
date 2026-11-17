class SatelliteManifest:
    def __init__(self, name: str, version: str, author: str, description: str, icon: str = None,
                 section_of: str = None, icon_name: str = None, provides: dict = None, icons: dict = None):
        self.name = name
        self.version = version
        self.author = author
        self.description = description
        # optional name of the satellite's own icon, one of `icons` below.
        # None means clients draw icon_name, else a generic one.
        self.icon = icon
        # optional name of another satellite whose page hosts this one's
        # interface as a section, e.g. a private area shown as a tab.
        # Purely presentational: clients leave it out of their own
        # navigation and open the host instead. Never an access control -
        # every route stays as protected as any other.
        self.section_of = section_of
        # optional name from the shared icon set (contracts/ui/vocabulary.json)
        # that every client can draw - what stands for the satellite when it
        # ships no icon of its own, or its own one was refused
        self.icon_name = icon_name
        # the satellite's own icons (its [icons] table and icons/ folder), as
        # engine/starcore/icons.py validated them: {name: {fallback, stroke?,
        # paths?}}. Clients draw their paths; they never read an SVG.
        self.icons = icons or {}
        # Satellite capabilities this one provides to others, normalised by
        # ui_contract.normalise_provides: {"files.browse": {"version": 1,
        # "operations": {"list": "entries"}}}. Shared blocks (a file browser,
        # later a media picker) are bound to a capability, never to the
        # Satellite that happens to provide it - see docs/ui-contract.md.
        self.provides = provides or {}
