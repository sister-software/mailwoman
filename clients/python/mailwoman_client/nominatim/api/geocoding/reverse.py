from http import HTTPStatus
from typing import Any, cast

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.nominatim_feature_collection import NominatimFeatureCollection
from ...models.nominatim_result import NominatimResult
from ...models.reverse_addressdetails import ReverseAddressdetails
from ...models.reverse_format import ReverseFormat
from ...models.schema_org_place import SchemaOrgPlace
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    lat: float,
    lon: float,
    zoom: int | Unset = UNSET,
    addressdetails: ReverseAddressdetails | Unset = ReverseAddressdetails.VALUE_0,
    format_: ReverseFormat | Unset = ReverseFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["lat"] = lat

    params["lon"] = lon

    params["zoom"] = zoom

    json_addressdetails: int | Unset = UNSET
    if not isinstance(addressdetails, Unset):
        json_addressdetails = addressdetails.value

    params["addressdetails"] = json_addressdetails

    json_format_: str | Unset = UNSET
    if not isinstance(format_, Unset):
        json_format_ = format_.value

    params["format"] = json_format_

    params["accept-language"] = accept_language

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/reverse",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> (
    Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace | None
):
    if response.status_code == 200:

        def _parse_response_200(
            data: object,
        ) -> NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                response_200_type_0 = NominatimResult.from_dict(data)

                return response_200_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                response_200_type_1 = NominatimFeatureCollection.from_dict(data)

                return response_200_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                response_200_type_2 = SchemaOrgPlace.from_dict(data)

                return response_200_type_2
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace,
                data,
            )

        response_200 = _parse_response_200(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 500:
        response_500 = Error.from_dict(response.json())

        return response_500

    if response.status_code == 501:
        response_501 = Error.from_dict(response.json())

        return response_501

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[
    Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace
]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    lat: float,
    lon: float,
    zoom: int | Unset = UNSET,
    addressdetails: ReverseAddressdetails | Unset = ReverseAddressdetails.VALUE_0,
    format_: ReverseFormat | Unset = ReverseFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> Response[
    Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace
]:
    """Reverse geocoding

     Resolve a coordinate to the nearest address (point-in-polygon over the WOF admin hierarchy).

    Args:
        lat (float):
        lon (float):
        zoom (int | Unset):
        addressdetails (ReverseAddressdetails | Unset):  Default: ReverseAddressdetails.VALUE_0.
        format_ (ReverseFormat | Unset):  Default: ReverseFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace]
    """

    kwargs = _get_kwargs(
        lat=lat,
        lon=lon,
        zoom=zoom,
        addressdetails=addressdetails,
        format_=format_,
        accept_language=accept_language,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    lat: float,
    lon: float,
    zoom: int | Unset = UNSET,
    addressdetails: ReverseAddressdetails | Unset = ReverseAddressdetails.VALUE_0,
    format_: ReverseFormat | Unset = ReverseFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> (
    Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace | None
):
    """Reverse geocoding

     Resolve a coordinate to the nearest address (point-in-polygon over the WOF admin hierarchy).

    Args:
        lat (float):
        lon (float):
        zoom (int | Unset):
        addressdetails (ReverseAddressdetails | Unset):  Default: ReverseAddressdetails.VALUE_0.
        format_ (ReverseFormat | Unset):  Default: ReverseFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace
    """

    return sync_detailed(
        client=client,
        lat=lat,
        lon=lon,
        zoom=zoom,
        addressdetails=addressdetails,
        format_=format_,
        accept_language=accept_language,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    lat: float,
    lon: float,
    zoom: int | Unset = UNSET,
    addressdetails: ReverseAddressdetails | Unset = ReverseAddressdetails.VALUE_0,
    format_: ReverseFormat | Unset = ReverseFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> Response[
    Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace
]:
    """Reverse geocoding

     Resolve a coordinate to the nearest address (point-in-polygon over the WOF admin hierarchy).

    Args:
        lat (float):
        lon (float):
        zoom (int | Unset):
        addressdetails (ReverseAddressdetails | Unset):  Default: ReverseAddressdetails.VALUE_0.
        format_ (ReverseFormat | Unset):  Default: ReverseFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace]
    """

    kwargs = _get_kwargs(
        lat=lat,
        lon=lon,
        zoom=zoom,
        addressdetails=addressdetails,
        format_=format_,
        accept_language=accept_language,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    lat: float,
    lon: float,
    zoom: int | Unset = UNSET,
    addressdetails: ReverseAddressdetails | Unset = ReverseAddressdetails.VALUE_0,
    format_: ReverseFormat | Unset = ReverseFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> (
    Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace | None
):
    """Reverse geocoding

     Resolve a coordinate to the nearest address (point-in-polygon over the WOF admin hierarchy).

    Args:
        lat (float):
        lon (float):
        zoom (int | Unset):
        addressdetails (ReverseAddressdetails | Unset):  Default: ReverseAddressdetails.VALUE_0.
        format_ (ReverseFormat | Unset):  Default: ReverseFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | NominatimFeatureCollection | NominatimResult | None | SchemaOrgPlace
    """

    return (
        await asyncio_detailed(
            client=client,
            lat=lat,
            lon=lon,
            zoom=zoom,
            addressdetails=addressdetails,
            format_=format_,
            accept_language=accept_language,
        )
    ).parsed
