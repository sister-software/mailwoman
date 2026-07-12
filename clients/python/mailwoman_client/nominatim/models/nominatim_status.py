from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="NominatimStatus")


@_attrs_define
class NominatimStatus:
    """The `/status` payload. `status: 0` means OK.

    Attributes:
        status (int): `0` = OK; non-zero = a fault code.
        message (str):
        data_updated (str | Unset): When the underlying data was last built (ISO-8601).
    """

    status: int
    message: str
    data_updated: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        status = self.status

        message = self.message

        data_updated = self.data_updated

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "status": status,
                "message": message,
            }
        )
        if data_updated is not UNSET:
            field_dict["data_updated"] = data_updated

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        status = d.pop("status")

        message = d.pop("message")

        data_updated = d.pop("data_updated", UNSET)

        nominatim_status = cls(
            status=status,
            message=message,
            data_updated=data_updated,
        )

        return nominatim_status
