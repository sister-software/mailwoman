from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.nominatim_feature_collection import NominatimFeatureCollection
from ...models.nominatim_result import NominatimResult
from ...models.schema_org_place import SchemaOrgPlace
from ...models.search_addressdetails import SearchAddressdetails
from ...models.search_bounded import SearchBounded
from ...models.search_format import SearchFormat
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    q: str | Unset = UNSET,
    street: str | Unset = UNSET,
    city: str | Unset = UNSET,
    county: str | Unset = UNSET,
    state: str | Unset = UNSET,
    country: str | Unset = UNSET,
    postalcode: str | Unset = UNSET,
    countrycodes: str | Unset = UNSET,
    limit: int | Unset = 10,
    bounded: SearchBounded | Unset = SearchBounded.VALUE_0,
    addressdetails: SearchAddressdetails | Unset = SearchAddressdetails.VALUE_0,
    format_: SearchFormat | Unset = SearchFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["q"] = q

    params["street"] = street

    params["city"] = city

    params["county"] = county

    params["state"] = state

    params["country"] = country

    params["postalcode"] = postalcode

    params["countrycodes"] = countrycodes

    params["limit"] = limit

    json_bounded: int | Unset = UNSET
    if not isinstance(bounded, Unset):
        json_bounded = bounded.value

    params["bounded"] = json_bounded

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
        "url": "/search",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> (
    Error
    | list[NominatimResult]
    | list[SchemaOrgPlace]
    | NominatimFeatureCollection
    | None
):
    if response.status_code == 200:

        def _parse_response_200(
            data: object,
        ) -> list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection:
            try:
                if not isinstance(data, list):
                    raise TypeError()
                response_200_type_0 = []
                _response_200_type_0 = data
                for response_200_type_0_item_data in _response_200_type_0:
                    response_200_type_0_item = NominatimResult.from_dict(
                        response_200_type_0_item_data
                    )

                    response_200_type_0.append(response_200_type_0_item)

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
            if not isinstance(data, list):
                raise TypeError()
            response_200_type_2 = []
            _response_200_type_2 = data
            for response_200_type_2_item_data in _response_200_type_2:
                response_200_type_2_item = SchemaOrgPlace.from_dict(
                    response_200_type_2_item_data
                )

                response_200_type_2.append(response_200_type_2_item)

            return response_200_type_2

        response_200 = _parse_response_200(response.json())

        return response_200

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
    Error | list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection
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
    q: str | Unset = UNSET,
    street: str | Unset = UNSET,
    city: str | Unset = UNSET,
    county: str | Unset = UNSET,
    state: str | Unset = UNSET,
    country: str | Unset = UNSET,
    postalcode: str | Unset = UNSET,
    countrycodes: str | Unset = UNSET,
    limit: int | Unset = 10,
    bounded: SearchBounded | Unset = SearchBounded.VALUE_0,
    addressdetails: SearchAddressdetails | Unset = SearchAddressdetails.VALUE_0,
    format_: SearchFormat | Unset = SearchFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> Response[
    Error | list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection
]:
    """Forward geocoding

     Geocode a free-text `q`, or a structured (`street`/`city`/`state`/`postalcode`/`country`) query,
    into ranked results.

    Args:
        q (str | Unset):
        street (str | Unset):
        city (str | Unset):
        county (str | Unset):
        state (str | Unset):
        country (str | Unset):
        postalcode (str | Unset):
        countrycodes (str | Unset):
        limit (int | Unset):  Default: 10.
        bounded (SearchBounded | Unset):  Default: SearchBounded.VALUE_0.
        addressdetails (SearchAddressdetails | Unset):  Default: SearchAddressdetails.VALUE_0.
        format_ (SearchFormat | Unset):  Default: SearchFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection]
    """

    kwargs = _get_kwargs(
        q=q,
        street=street,
        city=city,
        county=county,
        state=state,
        country=country,
        postalcode=postalcode,
        countrycodes=countrycodes,
        limit=limit,
        bounded=bounded,
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
    q: str | Unset = UNSET,
    street: str | Unset = UNSET,
    city: str | Unset = UNSET,
    county: str | Unset = UNSET,
    state: str | Unset = UNSET,
    country: str | Unset = UNSET,
    postalcode: str | Unset = UNSET,
    countrycodes: str | Unset = UNSET,
    limit: int | Unset = 10,
    bounded: SearchBounded | Unset = SearchBounded.VALUE_0,
    addressdetails: SearchAddressdetails | Unset = SearchAddressdetails.VALUE_0,
    format_: SearchFormat | Unset = SearchFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> (
    Error
    | list[NominatimResult]
    | list[SchemaOrgPlace]
    | NominatimFeatureCollection
    | None
):
    """Forward geocoding

     Geocode a free-text `q`, or a structured (`street`/`city`/`state`/`postalcode`/`country`) query,
    into ranked results.

    Args:
        q (str | Unset):
        street (str | Unset):
        city (str | Unset):
        county (str | Unset):
        state (str | Unset):
        country (str | Unset):
        postalcode (str | Unset):
        countrycodes (str | Unset):
        limit (int | Unset):  Default: 10.
        bounded (SearchBounded | Unset):  Default: SearchBounded.VALUE_0.
        addressdetails (SearchAddressdetails | Unset):  Default: SearchAddressdetails.VALUE_0.
        format_ (SearchFormat | Unset):  Default: SearchFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection
    """

    return sync_detailed(
        client=client,
        q=q,
        street=street,
        city=city,
        county=county,
        state=state,
        country=country,
        postalcode=postalcode,
        countrycodes=countrycodes,
        limit=limit,
        bounded=bounded,
        addressdetails=addressdetails,
        format_=format_,
        accept_language=accept_language,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    q: str | Unset = UNSET,
    street: str | Unset = UNSET,
    city: str | Unset = UNSET,
    county: str | Unset = UNSET,
    state: str | Unset = UNSET,
    country: str | Unset = UNSET,
    postalcode: str | Unset = UNSET,
    countrycodes: str | Unset = UNSET,
    limit: int | Unset = 10,
    bounded: SearchBounded | Unset = SearchBounded.VALUE_0,
    addressdetails: SearchAddressdetails | Unset = SearchAddressdetails.VALUE_0,
    format_: SearchFormat | Unset = SearchFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> Response[
    Error | list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection
]:
    """Forward geocoding

     Geocode a free-text `q`, or a structured (`street`/`city`/`state`/`postalcode`/`country`) query,
    into ranked results.

    Args:
        q (str | Unset):
        street (str | Unset):
        city (str | Unset):
        county (str | Unset):
        state (str | Unset):
        country (str | Unset):
        postalcode (str | Unset):
        countrycodes (str | Unset):
        limit (int | Unset):  Default: 10.
        bounded (SearchBounded | Unset):  Default: SearchBounded.VALUE_0.
        addressdetails (SearchAddressdetails | Unset):  Default: SearchAddressdetails.VALUE_0.
        format_ (SearchFormat | Unset):  Default: SearchFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection]
    """

    kwargs = _get_kwargs(
        q=q,
        street=street,
        city=city,
        county=county,
        state=state,
        country=country,
        postalcode=postalcode,
        countrycodes=countrycodes,
        limit=limit,
        bounded=bounded,
        addressdetails=addressdetails,
        format_=format_,
        accept_language=accept_language,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    q: str | Unset = UNSET,
    street: str | Unset = UNSET,
    city: str | Unset = UNSET,
    county: str | Unset = UNSET,
    state: str | Unset = UNSET,
    country: str | Unset = UNSET,
    postalcode: str | Unset = UNSET,
    countrycodes: str | Unset = UNSET,
    limit: int | Unset = 10,
    bounded: SearchBounded | Unset = SearchBounded.VALUE_0,
    addressdetails: SearchAddressdetails | Unset = SearchAddressdetails.VALUE_0,
    format_: SearchFormat | Unset = SearchFormat.JSONV2,
    accept_language: str | Unset = UNSET,
) -> (
    Error
    | list[NominatimResult]
    | list[SchemaOrgPlace]
    | NominatimFeatureCollection
    | None
):
    """Forward geocoding

     Geocode a free-text `q`, or a structured (`street`/`city`/`state`/`postalcode`/`country`) query,
    into ranked results.

    Args:
        q (str | Unset):
        street (str | Unset):
        city (str | Unset):
        county (str | Unset):
        state (str | Unset):
        country (str | Unset):
        postalcode (str | Unset):
        countrycodes (str | Unset):
        limit (int | Unset):  Default: 10.
        bounded (SearchBounded | Unset):  Default: SearchBounded.VALUE_0.
        addressdetails (SearchAddressdetails | Unset):  Default: SearchAddressdetails.VALUE_0.
        format_ (SearchFormat | Unset):  Default: SearchFormat.JSONV2.
        accept_language (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | list[NominatimResult] | list[SchemaOrgPlace] | NominatimFeatureCollection
    """

    return (
        await asyncio_detailed(
            client=client,
            q=q,
            street=street,
            city=city,
            county=county,
            state=state,
            country=country,
            postalcode=postalcode,
            countrycodes=countrycodes,
            limit=limit,
            bounded=bounded,
            addressdetails=addressdetails,
            format_=format_,
            accept_language=accept_language,
        )
    ).parsed
