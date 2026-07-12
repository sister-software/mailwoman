from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.lookup_addressdetails import LookupAddressdetails
from ...models.lookup_format import LookupFormat
from ...models.nominatim_feature_collection import NominatimFeatureCollection
from ...models.nominatim_result import NominatimResult
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    osm_ids: str,
    addressdetails: LookupAddressdetails | Unset = LookupAddressdetails.VALUE_0,
    format_: LookupFormat | Unset = LookupFormat.JSONV2,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["osm_ids"] = osm_ids

    json_addressdetails: int | Unset = UNSET
    if not isinstance(addressdetails, Unset):
        json_addressdetails = addressdetails.value

    params["addressdetails"] = json_addressdetails

    json_format_: str | Unset = UNSET
    if not isinstance(format_, Unset):
        json_format_ = format_.value

    params["format"] = json_format_

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/lookup",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | list[NominatimResult] | NominatimFeatureCollection | None:
    if response.status_code == 200:

        def _parse_response_200(
            data: object,
        ) -> list[NominatimResult] | NominatimFeatureCollection:
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
            if not isinstance(data, dict):
                raise TypeError()
            response_200_type_1 = NominatimFeatureCollection.from_dict(data)

            return response_200_type_1

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
) -> Response[Error | list[NominatimResult] | NominatimFeatureCollection]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    osm_ids: str,
    addressdetails: LookupAddressdetails | Unset = LookupAddressdetails.VALUE_0,
    format_: LookupFormat | Unset = LookupFormat.JSONV2,
) -> Response[Error | list[NominatimResult] | NominatimFeatureCollection]:
    """Look up known place ids

     Resolve one or more OSM/place ids to result objects. Part of the router contract; not wired in the
    bundled `serve` engine yet (answers `501`).

    Args:
        osm_ids (str):
        addressdetails (LookupAddressdetails | Unset):  Default: LookupAddressdetails.VALUE_0.
        format_ (LookupFormat | Unset):  Default: LookupFormat.JSONV2.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | list[NominatimResult] | NominatimFeatureCollection]
    """

    kwargs = _get_kwargs(
        osm_ids=osm_ids,
        addressdetails=addressdetails,
        format_=format_,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    osm_ids: str,
    addressdetails: LookupAddressdetails | Unset = LookupAddressdetails.VALUE_0,
    format_: LookupFormat | Unset = LookupFormat.JSONV2,
) -> Error | list[NominatimResult] | NominatimFeatureCollection | None:
    """Look up known place ids

     Resolve one or more OSM/place ids to result objects. Part of the router contract; not wired in the
    bundled `serve` engine yet (answers `501`).

    Args:
        osm_ids (str):
        addressdetails (LookupAddressdetails | Unset):  Default: LookupAddressdetails.VALUE_0.
        format_ (LookupFormat | Unset):  Default: LookupFormat.JSONV2.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | list[NominatimResult] | NominatimFeatureCollection
    """

    return sync_detailed(
        client=client,
        osm_ids=osm_ids,
        addressdetails=addressdetails,
        format_=format_,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    osm_ids: str,
    addressdetails: LookupAddressdetails | Unset = LookupAddressdetails.VALUE_0,
    format_: LookupFormat | Unset = LookupFormat.JSONV2,
) -> Response[Error | list[NominatimResult] | NominatimFeatureCollection]:
    """Look up known place ids

     Resolve one or more OSM/place ids to result objects. Part of the router contract; not wired in the
    bundled `serve` engine yet (answers `501`).

    Args:
        osm_ids (str):
        addressdetails (LookupAddressdetails | Unset):  Default: LookupAddressdetails.VALUE_0.
        format_ (LookupFormat | Unset):  Default: LookupFormat.JSONV2.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | list[NominatimResult] | NominatimFeatureCollection]
    """

    kwargs = _get_kwargs(
        osm_ids=osm_ids,
        addressdetails=addressdetails,
        format_=format_,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    osm_ids: str,
    addressdetails: LookupAddressdetails | Unset = LookupAddressdetails.VALUE_0,
    format_: LookupFormat | Unset = LookupFormat.JSONV2,
) -> Error | list[NominatimResult] | NominatimFeatureCollection | None:
    """Look up known place ids

     Resolve one or more OSM/place ids to result objects. Part of the router contract; not wired in the
    bundled `serve` engine yet (answers `501`).

    Args:
        osm_ids (str):
        addressdetails (LookupAddressdetails | Unset):  Default: LookupAddressdetails.VALUE_0.
        format_ (LookupFormat | Unset):  Default: LookupFormat.JSONV2.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | list[NominatimResult] | NominatimFeatureCollection
    """

    return (
        await asyncio_detailed(
            client=client,
            osm_ids=osm_ids,
            addressdetails=addressdetails,
            format_=format_,
        )
    ).parsed
