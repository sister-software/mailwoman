from enum import Enum


class ReverseFormat(str, Enum):
    JSONLD = "jsonld"

    def __str__(self) -> str:
        return str(self.value)
