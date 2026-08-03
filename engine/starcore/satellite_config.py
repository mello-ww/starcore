class SatelliteConfig:
    def __init__(self, data:dict):
        self.data = data

    def get(self, key):
        return self.data.get(key)