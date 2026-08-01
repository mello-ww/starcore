class SatelliteRegistry:
    def __init__(self):
        self._satellites = []

    def add(self, satellite):
        self._satellites.append(satellite)

    def all(self):
        return self._satellites