from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error_feature_collection import ErrorFeatureCollection
from ...models.photon_feature_collection import PhotonFeatureCollection
from ...models.schema_org_place import SchemaOrgPlace
from ...models.search_format import SearchFormat
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    q: str,
    limit: int | Unset = 15,
    lang: str | Unset = UNSET,
    lat: float | Unset = UNSET,
    lon: float | Unset = UNSET,
    osm_tag: list[str] | Unset = UNSET,
    layer: list[str] | Unset = UNSET,
    format_: SearchFormat | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["q"] = q

    params["limit"] = limit

    params["lang"] = lang

    params["lat"] = lat

    params["lon"] = lon

    json_osm_tag: list[str] | Unset = UNSET
    if not isinstance(osm_tag, Unset):
        json_osm_tag = osm_tag

    params["osm_tag"] = json_osm_tag

    json_layer: list[str] | Unset = UNSET
    if not isinstance(layer, Unset):
        json_layer = layer

    params["layer"] = json_layer

    json_format_: str | Unset = UNSET
    if not isinstance(format_, Unset):
        json_format_ = format_.value

    params["format"] = json_format_

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/api",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection | None:
    if response.status_code == 200:

        def _parse_response_200(
            data: object,
        ) -> list[SchemaOrgPlace] | PhotonFeatureCollection:
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                response_200_type_0 = PhotonFeatureCollection.from_dict(data)

                return response_200_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, list):
                raise TypeError()
            response_200_type_1 = []
            _response_200_type_1 = data
            for response_200_type_1_item_data in _response_200_type_1:
                response_200_type_1_item = SchemaOrgPlace.from_dict(
                    response_200_type_1_item_data
                )

                response_200_type_1.append(response_200_type_1_item)

            return response_200_type_1

        response_200 = _parse_response_200(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = ErrorFeatureCollection.from_dict(response.json())

        return response_400

    if response.status_code == 500:
        response_500 = ErrorFeatureCollection.from_dict(response.json())

        return response_500

    if response.status_code == 501:
        response_501 = ErrorFeatureCollection.from_dict(response.json())

        return response_501

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    q: str,
    limit: int | Unset = 15,
    lang: str | Unset = UNSET,
    lat: float | Unset = UNSET,
    lon: float | Unset = UNSET,
    osm_tag: list[str] | Unset = UNSET,
    layer: list[str] | Unset = UNSET,
    format_: SearchFormat | Unset = UNSET,
) -> Response[ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection]:
    """Forward / autocomplete geocoding

     Parse and resolve a free-text query into ranked places, returning a GeoJSON `FeatureCollection` (or
    a schema.org `Place[]` when `format=jsonld`).

    Args:
        q (str):
        limit (int | Unset):  Default: 15.
        lang (str | Unset):
        lat (float | Unset):
        lon (float | Unset):
        osm_tag (list[str] | Unset):
        layer (list[str] | Unset):
        format_ (SearchFormat | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection]
    """

    kwargs = _get_kwargs(
        q=q,
        limit=limit,
        lang=lang,
        lat=lat,
        lon=lon,
        osm_tag=osm_tag,
        layer=layer,
        format_=format_,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    q: str,
    limit: int | Unset = 15,
    lang: str | Unset = UNSET,
    lat: float | Unset = UNSET,
    lon: float | Unset = UNSET,
    osm_tag: list[str] | Unset = UNSET,
    layer: list[str] | Unset = UNSET,
    format_: SearchFormat | Unset = UNSET,
) -> ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection | None:
    """Forward / autocomplete geocoding

     Parse and resolve a free-text query into ranked places, returning a GeoJSON `FeatureCollection` (or
    a schema.org `Place[]` when `format=jsonld`).

    Args:
        q (str):
        limit (int | Unset):  Default: 15.
        lang (str | Unset):
        lat (float | Unset):
        lon (float | Unset):
        osm_tag (list[str] | Unset):
        layer (list[str] | Unset):
        format_ (SearchFormat | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection
    """

    return sync_detailed(
        client=client,
        q=q,
        limit=limit,
        lang=lang,
        lat=lat,
        lon=lon,
        osm_tag=osm_tag,
        layer=layer,
        format_=format_,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    q: str,
    limit: int | Unset = 15,
    lang: str | Unset = UNSET,
    lat: float | Unset = UNSET,
    lon: float | Unset = UNSET,
    osm_tag: list[str] | Unset = UNSET,
    layer: list[str] | Unset = UNSET,
    format_: SearchFormat | Unset = UNSET,
) -> Response[ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection]:
    """Forward / autocomplete geocoding

     Parse and resolve a free-text query into ranked places, returning a GeoJSON `FeatureCollection` (or
    a schema.org `Place[]` when `format=jsonld`).

    Args:
        q (str):
        limit (int | Unset):  Default: 15.
        lang (str | Unset):
        lat (float | Unset):
        lon (float | Unset):
        osm_tag (list[str] | Unset):
        layer (list[str] | Unset):
        format_ (SearchFormat | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection]
    """

    kwargs = _get_kwargs(
        q=q,
        limit=limit,
        lang=lang,
        lat=lat,
        lon=lon,
        osm_tag=osm_tag,
        layer=layer,
        format_=format_,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    q: str,
    limit: int | Unset = 15,
    lang: str | Unset = UNSET,
    lat: float | Unset = UNSET,
    lon: float | Unset = UNSET,
    osm_tag: list[str] | Unset = UNSET,
    layer: list[str] | Unset = UNSET,
    format_: SearchFormat | Unset = UNSET,
) -> ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection | None:
    """Forward / autocomplete geocoding

     Parse and resolve a free-text query into ranked places, returning a GeoJSON `FeatureCollection` (or
    a schema.org `Place[]` when `format=jsonld`).

    Args:
        q (str):
        limit (int | Unset):  Default: 15.
        lang (str | Unset):
        lat (float | Unset):
        lon (float | Unset):
        osm_tag (list[str] | Unset):
        layer (list[str] | Unset):
        format_ (SearchFormat | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorFeatureCollection | list[SchemaOrgPlace] | PhotonFeatureCollection
    """

    return (
        await asyncio_detailed(
            client=client,
            q=q,
            limit=limit,
            lang=lang,
            lat=lat,
            lon=lon,
            osm_tag=osm_tag,
            layer=layer,
            format_=format_,
        )
    ).parsed
