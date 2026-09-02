class SatelliteConfig:
    def __init__(self, data:dict):
        self.data = data

    def get(self, key, default=None):
        return self.data.get(key, default)
