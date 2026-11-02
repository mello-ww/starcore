class SatelliteManifest:
    def __init__(self, name: str, version: str, author: str, description: str, icon: str = None,
                 section_of: str = None):
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
