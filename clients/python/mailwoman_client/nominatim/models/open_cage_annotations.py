from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.open_cage_annotations_currency import OpenCageAnnotationsCurrency
    from ..models.open_cage_annotations_dms import OpenCageAnnotationsDMS
    from ..models.open_cage_annotations_fips import OpenCageAnnotationsFIPS
    from ..models.open_cage_annotations_mercator import OpenCageAnnotationsMercator
    from ..models.open_cage_annotations_nuts import OpenCageAnnotationsNUTS
    from ..models.open_cage_annotations_sun import OpenCageAnnotationsSun
    from ..models.open_cage_annotations_timezone import OpenCageAnnotationsTimezone


T = TypeVar("T", bound="OpenCageAnnotations")


@_attrs_define
class OpenCageAnnotations:
    """The OpenCage-style enrichment block, keyed and cased as OpenCage documents it. A Mailwoman extension over upstream
    Nominatim. Only populated fields are emitted.

        Attributes:
            dms (OpenCageAnnotationsDMS | Unset):
            mgrs (str | Unset):
            maidenhead (str | Unset):
            mercator (OpenCageAnnotationsMercator | Unset):
            geohash (str | Unset):
            qibla (float | Unset):
            sun (OpenCageAnnotationsSun | Unset):
            callingcode (float | Unset):
            currency (OpenCageAnnotationsCurrency | Unset):
            flag (str | Unset): The country's flag emoji.
            timezone (OpenCageAnnotationsTimezone | Unset):
            nuts (OpenCageAnnotationsNUTS | Unset): EU NUTS region codes (when the NUTS data bundle is present).
            un_locode (str | Unset):
            wikidata (str | Unset):
            fips (OpenCageAnnotationsFIPS | Unset):
    """

    dms: OpenCageAnnotationsDMS | Unset = UNSET
    mgrs: str | Unset = UNSET
    maidenhead: str | Unset = UNSET
    mercator: OpenCageAnnotationsMercator | Unset = UNSET
    geohash: str | Unset = UNSET
    qibla: float | Unset = UNSET
    sun: OpenCageAnnotationsSun | Unset = UNSET
    callingcode: float | Unset = UNSET
    currency: OpenCageAnnotationsCurrency | Unset = UNSET
    flag: str | Unset = UNSET
    timezone: OpenCageAnnotationsTimezone | Unset = UNSET
    nuts: OpenCageAnnotationsNUTS | Unset = UNSET
    un_locode: str | Unset = UNSET
    wikidata: str | Unset = UNSET
    fips: OpenCageAnnotationsFIPS | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        dms: dict[str, Any] | Unset = UNSET
        if not isinstance(self.dms, Unset):
            dms = self.dms.to_dict()

        mgrs = self.mgrs

        maidenhead = self.maidenhead

        mercator: dict[str, Any] | Unset = UNSET
        if not isinstance(self.mercator, Unset):
            mercator = self.mercator.to_dict()

        geohash = self.geohash

        qibla = self.qibla

        sun: dict[str, Any] | Unset = UNSET
        if not isinstance(self.sun, Unset):
            sun = self.sun.to_dict()

        callingcode = self.callingcode

        currency: dict[str, Any] | Unset = UNSET
        if not isinstance(self.currency, Unset):
            currency = self.currency.to_dict()

        flag = self.flag

        timezone: dict[str, Any] | Unset = UNSET
        if not isinstance(self.timezone, Unset):
            timezone = self.timezone.to_dict()

        nuts: dict[str, Any] | Unset = UNSET
        if not isinstance(self.nuts, Unset):
            nuts = self.nuts.to_dict()

        un_locode = self.un_locode

        wikidata = self.wikidata

        fips: dict[str, Any] | Unset = UNSET
        if not isinstance(self.fips, Unset):
            fips = self.fips.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if dms is not UNSET:
            field_dict["DMS"] = dms
        if mgrs is not UNSET:
            field_dict["MGRS"] = mgrs
        if maidenhead is not UNSET:
            field_dict["Maidenhead"] = maidenhead
        if mercator is not UNSET:
            field_dict["Mercator"] = mercator
        if geohash is not UNSET:
            field_dict["geohash"] = geohash
        if qibla is not UNSET:
            field_dict["qibla"] = qibla
        if sun is not UNSET:
            field_dict["sun"] = sun
        if callingcode is not UNSET:
            field_dict["callingcode"] = callingcode
        if currency is not UNSET:
            field_dict["currency"] = currency
        if flag is not UNSET:
            field_dict["flag"] = flag
        if timezone is not UNSET:
            field_dict["timezone"] = timezone
        if nuts is not UNSET:
            field_dict["NUTS"] = nuts
        if un_locode is not UNSET:
            field_dict["UN_LOCODE"] = un_locode
        if wikidata is not UNSET:
            field_dict["wikidata"] = wikidata
        if fips is not UNSET:
            field_dict["FIPS"] = fips

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.open_cage_annotations_currency import OpenCageAnnotationsCurrency
        from ..models.open_cage_annotations_dms import OpenCageAnnotationsDMS
        from ..models.open_cage_annotations_fips import OpenCageAnnotationsFIPS
        from ..models.open_cage_annotations_mercator import OpenCageAnnotationsMercator
        from ..models.open_cage_annotations_nuts import OpenCageAnnotationsNUTS
        from ..models.open_cage_annotations_sun import OpenCageAnnotationsSun
        from ..models.open_cage_annotations_timezone import OpenCageAnnotationsTimezone

        d = dict(src_dict)
        _dms = d.pop("DMS", UNSET)
        dms: OpenCageAnnotationsDMS | Unset
        if isinstance(_dms, Unset):
            dms = UNSET
        else:
            dms = OpenCageAnnotationsDMS.from_dict(_dms)

        mgrs = d.pop("MGRS", UNSET)

        maidenhead = d.pop("Maidenhead", UNSET)

        _mercator = d.pop("Mercator", UNSET)
        mercator: OpenCageAnnotationsMercator | Unset
        if isinstance(_mercator, Unset):
            mercator = UNSET
        else:
            mercator = OpenCageAnnotationsMercator.from_dict(_mercator)

        geohash = d.pop("geohash", UNSET)

        qibla = d.pop("qibla", UNSET)

        _sun = d.pop("sun", UNSET)
        sun: OpenCageAnnotationsSun | Unset
        if isinstance(_sun, Unset):
            sun = UNSET
        else:
            sun = OpenCageAnnotationsSun.from_dict(_sun)

        callingcode = d.pop("callingcode", UNSET)

        _currency = d.pop("currency", UNSET)
        currency: OpenCageAnnotationsCurrency | Unset
        if isinstance(_currency, Unset):
            currency = UNSET
        else:
            currency = OpenCageAnnotationsCurrency.from_dict(_currency)

        flag = d.pop("flag", UNSET)

        _timezone = d.pop("timezone", UNSET)
        timezone: OpenCageAnnotationsTimezone | Unset
        if isinstance(_timezone, Unset):
            timezone = UNSET
        else:
            timezone = OpenCageAnnotationsTimezone.from_dict(_timezone)

        _nuts = d.pop("NUTS", UNSET)
        nuts: OpenCageAnnotationsNUTS | Unset
        if isinstance(_nuts, Unset):
            nuts = UNSET
        else:
            nuts = OpenCageAnnotationsNUTS.from_dict(_nuts)

        un_locode = d.pop("UN_LOCODE", UNSET)

        wikidata = d.pop("wikidata", UNSET)

        _fips = d.pop("FIPS", UNSET)
        fips: OpenCageAnnotationsFIPS | Unset
        if isinstance(_fips, Unset):
            fips = UNSET
        else:
            fips = OpenCageAnnotationsFIPS.from_dict(_fips)

        open_cage_annotations = cls(
            dms=dms,
            mgrs=mgrs,
            maidenhead=maidenhead,
            mercator=mercator,
            geohash=geohash,
            qibla=qibla,
            sun=sun,
            callingcode=callingcode,
            currency=currency,
            flag=flag,
            timezone=timezone,
            nuts=nuts,
            un_locode=un_locode,
            wikidata=wikidata,
            fips=fips,
        )

        open_cage_annotations.additional_properties = d
        return open_cage_annotations

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
