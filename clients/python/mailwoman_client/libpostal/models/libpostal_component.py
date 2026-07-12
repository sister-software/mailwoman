from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="LibpostalComponent")


@_attrs_define
class LibpostalComponent:
    """A libpostal `parse_address` component — a label and the text span it covers, in order.

    Attributes:
        label (str): The libpostal label, e.g. `house_number`, `road`, `city`, `state`, `postcode`.
        value (str): The text the label covers.
    """

    label: str
    value: str

    def to_dict(self) -> dict[str, Any]:
        label = self.label

        value = self.value

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "label": label,
                "value": value,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        label = d.pop("label")

        value = d.pop("value")

        libpostal_component = cls(
            label=label,
            value=value,
        )

        return libpostal_component
