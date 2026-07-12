from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="NominatimAddressDetails")


@_attrs_define
class NominatimAddressDetails:
    """The structured address breakdown returned under `address` when `addressdetails=1`. Keys mirror Nominatim's OSM-
    derived tag names.

        Attributes:
            house_number (str | Unset):
            road (str | Unset):
            neighbourhood (str | Unset):
            suburb (str | Unset):
            city (str | Unset):
            town (str | Unset):
            village (str | Unset):
            county (str | Unset):
            state (str | Unset):
            postcode (str | Unset):
            country (str | Unset):
            country_code (str | Unset): ISO-3166 alpha-2, lowercased.
    """

    house_number: str | Unset = UNSET
    road: str | Unset = UNSET
    neighbourhood: str | Unset = UNSET
    suburb: str | Unset = UNSET
    city: str | Unset = UNSET
    town: str | Unset = UNSET
    village: str | Unset = UNSET
    county: str | Unset = UNSET
    state: str | Unset = UNSET
    postcode: str | Unset = UNSET
    country: str | Unset = UNSET
    country_code: str | Unset = UNSET
    additional_properties: dict[str, str] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        house_number = self.house_number

        road = self.road

        neighbourhood = self.neighbourhood

        suburb = self.suburb

        city = self.city

        town = self.town

        village = self.village

        county = self.county

        state = self.state

        postcode = self.postcode

        country = self.country

        country_code = self.country_code

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if house_number is not UNSET:
            field_dict["house_number"] = house_number
        if road is not UNSET:
            field_dict["road"] = road
        if neighbourhood is not UNSET:
            field_dict["neighbourhood"] = neighbourhood
        if suburb is not UNSET:
            field_dict["suburb"] = suburb
        if city is not UNSET:
            field_dict["city"] = city
        if town is not UNSET:
            field_dict["town"] = town
        if village is not UNSET:
            field_dict["village"] = village
        if county is not UNSET:
            field_dict["county"] = county
        if state is not UNSET:
            field_dict["state"] = state
        if postcode is not UNSET:
            field_dict["postcode"] = postcode
        if country is not UNSET:
            field_dict["country"] = country
        if country_code is not UNSET:
            field_dict["country_code"] = country_code

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        house_number = d.pop("house_number", UNSET)

        road = d.pop("road", UNSET)

        neighbourhood = d.pop("neighbourhood", UNSET)

        suburb = d.pop("suburb", UNSET)

        city = d.pop("city", UNSET)

        town = d.pop("town", UNSET)

        village = d.pop("village", UNSET)

        county = d.pop("county", UNSET)

        state = d.pop("state", UNSET)

        postcode = d.pop("postcode", UNSET)

        country = d.pop("country", UNSET)

        country_code = d.pop("country_code", UNSET)

        nominatim_address_details = cls(
            house_number=house_number,
            road=road,
            neighbourhood=neighbourhood,
            suburb=suburb,
            city=city,
            town=town,
            village=village,
            county=county,
            state=state,
            postcode=postcode,
            country=country,
            country_code=country_code,
        )

        nominatim_address_details.additional_properties = d
        return nominatim_address_details

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> str:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: str) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
