class SatelliteRegistry:
    def __init__(self):
        self._satellites = []

    def add(self, satellite):
        self._satellites.append(satellite)

    def get(self, name):
        for satellite in self._satellites:
            if satellite.manifest.name.lower() == str(name).lower():
                return satellite
        return None

    def all(self):
        return self._satellites
