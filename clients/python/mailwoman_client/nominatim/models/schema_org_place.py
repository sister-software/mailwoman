from __future__ import annotations

from collections.abc import Mapping
from typing import (
    TYPE_CHECKING,
    Any,
    Literal,
    TypeVar,
    cast,
)

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.schema_org_place_address import SchemaOrgPlaceAddress
    from ..models.schema_org_place_geo import SchemaOrgPlaceGeo


T = TypeVar("T", bound="SchemaOrgPlace")


@_attrs_define
class SchemaOrgPlace:
    """A schema.org `Place` JSON-LD object (the `format=jsonld` projection). Only populated fields are emitted.

    Attributes:
        context (Literal['https://schema.org']):
        type_ (Literal['Place']):
        name (str | Unset):
        geo (SchemaOrgPlaceGeo | Unset):
        address (SchemaOrgPlaceAddress | Unset):
    """

    context: Literal["https://schema.org"]
    type_: Literal["Place"]
    name: str | Unset = UNSET
    geo: SchemaOrgPlaceGeo | Unset = UNSET
    address: SchemaOrgPlaceAddress | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        context = self.context

        type_ = self.type_

        name = self.name

        geo: dict[str, Any] | Unset = UNSET
        if not isinstance(self.geo, Unset):
            geo = self.geo.to_dict()

        address: dict[str, Any] | Unset = UNSET
        if not isinstance(self.address, Unset):
            address = self.address.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "@context": context,
                "@type": type_,
            }
        )
        if name is not UNSET:
            field_dict["name"] = name
        if geo is not UNSET:
            field_dict["geo"] = geo
        if address is not UNSET:
            field_dict["address"] = address

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.schema_org_place_address import SchemaOrgPlaceAddress
        from ..models.schema_org_place_geo import SchemaOrgPlaceGeo

        d = dict(src_dict)
        context = cast(Literal["https://schema.org"], d.pop("@context"))
        if context != "https://schema.org":
            raise ValueError(
                f"@context must match const 'https://schema.org', got '{context}'"
            )

        type_ = cast(Literal["Place"], d.pop("@type"))
        if type_ != "Place":
            raise ValueError(f"@type must match const 'Place', got '{type_}'")

        name = d.pop("name", UNSET)

        _geo = d.pop("geo", UNSET)
        geo: SchemaOrgPlaceGeo | Unset
        if isinstance(_geo, Unset):
            geo = UNSET
        else:
            geo = SchemaOrgPlaceGeo.from_dict(_geo)

        _address = d.pop("address", UNSET)
        address: SchemaOrgPlaceAddress | Unset
        if isinstance(_address, Unset):
            address = UNSET
        else:
            address = SchemaOrgPlaceAddress.from_dict(_address)

        schema_org_place = cls(
            context=context,
            type_=type_,
            name=name,
            geo=geo,
            address=address,
        )

        return schema_org_place
