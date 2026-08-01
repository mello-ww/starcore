from pathlib import Path



class Satellite:
    def __init__(self, name: str, satellite_type: str, path: Path):
        self.name = name
        self.type = satellite_type
        self.path = path