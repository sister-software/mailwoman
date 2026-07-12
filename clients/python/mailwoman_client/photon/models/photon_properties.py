from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="PhotonProperties")


@_attrs_define
class PhotonProperties:
    """OSM-derived feature properties, populated from the resolved place. `osm_key`, `osm_value`, and `type` are always
    present so a Photon client never dereferences `undefined`. Unlisted keys may also appear.

        Attributes:
            osm_id (int | str | Unset):
            osm_type (str | Unset):
            osm_key (str | Unset): OSM key, e.g. `place`, `highway`, `building`.
            osm_value (str | Unset): OSM value, e.g. `city`, `house`, `residential`.
            type_ (str | Unset): Photon place type, e.g. `city`, `street`, `house`, `country`.
            name (str | Unset):
            housenumber (str | Unset):
            street (str | Unset):
            postcode (str | Unset):
            city (str | Unset):
            district (str | Unset):
            county (str | Unset):
            state (str | Unset):
            country (str | Unset):
            countrycode (str | Unset): ISO-3166 alpha-2, lowercased.
            extent (list[float] | Unset): Bounding box `[minLon, maxLat, maxLon, minLat]` (Photon convention).
    """

    osm_id: int | str | Unset = UNSET
    osm_type: str | Unset = UNSET
    osm_key: str | Unset = UNSET
    osm_value: str | Unset = UNSET
    type_: str | Unset = UNSET
    name: str | Unset = UNSET
    housenumber: str | Unset = UNSET
    street: str | Unset = UNSET
    postcode: str | Unset = UNSET
    city: str | Unset = UNSET
    district: str | Unset = UNSET
    county: str | Unset = UNSET
    state: str | Unset = UNSET
    country: str | Unset = UNSET
    countrycode: str | Unset = UNSET
    extent: list[float] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        osm_id: int | str | Unset
        if isinstance(self.osm_id, Unset):
            osm_id = UNSET
        else:
            osm_id = self.osm_id

        osm_type = self.osm_type

        osm_key = self.osm_key

        osm_value = self.osm_value

        type_ = self.type_

        name = self.name

        housenumber = self.housenumber

        street = self.street

        postcode = self.postcode

        city = self.city

        district = self.district

        county = self.county

        state = self.state

        country = self.country

        countrycode = self.countrycode

        extent: list[float] | Unset = UNSET
        if not isinstance(self.extent, Unset):
            extent = self.extent

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if osm_id is not UNSET:
            field_dict["osm_id"] = osm_id
        if osm_type is not UNSET:
            field_dict["osm_type"] = osm_type
        if osm_key is not UNSET:
            field_dict["osm_key"] = osm_key
        if osm_value is not UNSET:
            field_dict["osm_value"] = osm_value
        if type_ is not UNSET:
            field_dict["type"] = type_
        if name is not UNSET:
            field_dict["name"] = name
        if housenumber is not UNSET:
            field_dict["housenumber"] = housenumber
        if street is not UNSET:
            field_dict["street"] = street
        if postcode is not UNSET:
            field_dict["postcode"] = postcode
        if city is not UNSET:
            field_dict["city"] = city
        if district is not UNSET:
            field_dict["district"] = district
        if county is not UNSET:
            field_dict["county"] = county
        if state is not UNSET:
            field_dict["state"] = state
        if country is not UNSET:
            field_dict["country"] = country
        if countrycode is not UNSET:
            field_dict["countrycode"] = countrycode
        if extent is not UNSET:
            field_dict["extent"] = extent

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_osm_id(data: object) -> int | str | Unset:
            if isinstance(data, Unset):
                return data
            return cast(int | str | Unset, data)

        osm_id = _parse_osm_id(d.pop("osm_id", UNSET))

        osm_type = d.pop("osm_type", UNSET)

        osm_key = d.pop("osm_key", UNSET)

        osm_value = d.pop("osm_value", UNSET)

        type_ = d.pop("type", UNSET)

        name = d.pop("name", UNSET)

        housenumber = d.pop("housenumber", UNSET)

        street = d.pop("street", UNSET)

        postcode = d.pop("postcode", UNSET)

        city = d.pop("city", UNSET)

        district = d.pop("district", UNSET)

        county = d.pop("county", UNSET)

        state = d.pop("state", UNSET)

        country = d.pop("country", UNSET)

        countrycode = d.pop("countrycode", UNSET)

        extent = cast(list[float], d.pop("extent", UNSET))

        photon_properties = cls(
            osm_id=osm_id,
            osm_type=osm_type,
            osm_key=osm_key,
            osm_value=osm_value,
            type_=type_,
            name=name,
            housenumber=housenumber,
            street=street,
            postcode=postcode,
            city=city,
            district=district,
            county=county,
            state=state,
            country=country,
            countrycode=countrycode,
            extent=extent,
        )

        photon_properties.additional_properties = d
        return photon_properties

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
