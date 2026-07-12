from enum import Enum


class SearchFormat(str, Enum):
    JSONLD = "jsonld"

    def __str__(self) -> str:
        return str(self.value)
