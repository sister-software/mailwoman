from enum import Enum


class ReverseFormat(str, Enum):
    GEOJSON = "geojson"
    JSON = "json"
    JSONLD = "jsonld"
    JSONV2 = "jsonv2"

    def __str__(self) -> str:
        return str(self.value)
