from __future__ import annotations

from collections.abc import Mapping
from typing import (
    Any,
    Literal,
    TypeVar,
    cast,
)

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="SchemaOrgPlaceAddress")


@_attrs_define
class SchemaOrgPlaceAddress:
    """
    Attributes:
        type_ (Literal['PostalAddress']):
        street_address (str | Unset):
        post_office_box_number (str | Unset):
        address_locality (str | Unset):
        address_region (str | Unset):
        postal_code (str | Unset):
        address_country (str | Unset): ISO-3166 alpha-2 (uppercased).
    """

    type_: Literal["PostalAddress"]
    street_address: str | Unset = UNSET
    post_office_box_number: str | Unset = UNSET
    address_locality: str | Unset = UNSET
    address_region: str | Unset = UNSET
    postal_code: str | Unset = UNSET
    address_country: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        street_address = self.street_address

        post_office_box_number = self.post_office_box_number

        address_locality = self.address_locality

        address_region = self.address_region

        postal_code = self.postal_code

        address_country = self.address_country

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "@type": type_,
            }
        )
        if street_address is not UNSET:
            field_dict["streetAddress"] = street_address
        if post_office_box_number is not UNSET:
            field_dict["postOfficeBoxNumber"] = post_office_box_number
        if address_locality is not UNSET:
            field_dict["addressLocality"] = address_locality
        if address_region is not UNSET:
            field_dict["addressRegion"] = address_region
        if postal_code is not UNSET:
            field_dict["postalCode"] = postal_code
        if address_country is not UNSET:
            field_dict["addressCountry"] = address_country

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = cast(Literal["PostalAddress"], d.pop("@type"))
        if type_ != "PostalAddress":
            raise ValueError(f"@type must match const 'PostalAddress', got '{type_}'")

        street_address = d.pop("streetAddress", UNSET)

        post_office_box_number = d.pop("postOfficeBoxNumber", UNSET)

        address_locality = d.pop("addressLocality", UNSET)

        address_region = d.pop("addressRegion", UNSET)

        postal_code = d.pop("postalCode", UNSET)

        address_country = d.pop("addressCountry", UNSET)

        schema_org_place_address = cls(
            type_=type_,
            street_address=street_address,
            post_office_box_number=post_office_box_number,
            address_locality=address_locality,
            address_region=address_region,
            postal_code=postal_code,
            address_country=address_country,
        )

        return schema_org_place_address
