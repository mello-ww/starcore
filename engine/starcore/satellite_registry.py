class SatelliteRegistry:
    def __init__(self):
        self._satellites = []

    def add(self, satellite):
        self._satellites.append(satellite)

    def replace(self, satellite):
        """Swaps in a freshly (re)loaded Satellite, keeping its position in the list.

        Mission Control's satellite nav and list are ordered by discovery order,
        so a reload has to keep that place rather than moving the satellite to
        the end the way a plain remove-then-add would.
        """
        name = satellite.manifest.name.lower()
        for index, existing in enumerate(self._satellites):
            if existing.manifest.name.lower() == name:
                self._satellites[index] = satellite
                return
        self._satellites.append(satellite)

    def get(self, name):
        for satellite in self._satellites:
            if satellite.manifest.name.lower() == str(name).lower():
                return satellite
        return None

    def all(self):
        return self._satellites
