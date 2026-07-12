from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.libpostal_component import LibpostalComponent
from ...models.parse_request import ParseRequest
from ...types import Response


def _get_kwargs(
    *,
    body: ParseRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/parse",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | list[LibpostalComponent] | None:
    if response.status_code == 200:
        response_200 = []
        _response_200 = response.json()
        for response_200_item_data in _response_200:
            response_200_item = LibpostalComponent.from_dict(response_200_item_data)

            response_200.append(response_200_item)

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 500:
        response_500 = Error.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | list[LibpostalComponent]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: ParseRequest,
) -> Response[Error | list[LibpostalComponent]]:
    """Parse an address (JSON body)

     Parse a free-text address into ordered labeled components.

    Args:
        body (ParseRequest): A `/parse` request body. Provide `query` (or its alias `address`).

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | list[LibpostalComponent]]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: ParseRequest,
) -> Error | list[LibpostalComponent] | None:
    """Parse an address (JSON body)

     Parse a free-text address into ordered labeled components.

    Args:
        body (ParseRequest): A `/parse` request body. Provide `query` (or its alias `address`).

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | list[LibpostalComponent]
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: ParseRequest,
) -> Response[Error | list[LibpostalComponent]]:
    """Parse an address (JSON body)

     Parse a free-text address into ordered labeled components.

    Args:
        body (ParseRequest): A `/parse` request body. Provide `query` (or its alias `address`).

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | list[LibpostalComponent]]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: ParseRequest,
) -> Error | list[LibpostalComponent] | None:
    """Parse an address (JSON body)

     Parse a free-text address into ordered labeled components.

    Args:
        body (ParseRequest): A `/parse` request body. Provide `query` (or its alias `address`).

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | list[LibpostalComponent]
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
