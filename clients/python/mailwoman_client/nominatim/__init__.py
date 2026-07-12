"""A client library for accessing @mailwoman/nominatim"""

from .client import AuthenticatedClient, Client

__all__ = (
    "AuthenticatedClient",
    "Client",
)
