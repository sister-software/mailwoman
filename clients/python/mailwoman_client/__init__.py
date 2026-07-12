"""mailwoman-client — typed Python clients for Mailwoman's drop-in geocoding APIs.

Mailwoman ships three HTTP drop-ins — a Photon-compatible autocomplete API, a
Nominatim-compatible geocoding API, and a libpostal-compatible parse/expand API. This
package bundles a typed client for each, **generated from their published OpenAPI 3.1
specs** with `openapi-python-client`, under one distributable (`mailwoman_client.photon`,
`mailwoman_client.nominatim`, `mailwoman_client.libpostal`).

The `*.photon` / `*.nominatim` / `*.libpostal` subpackages are generated verbatim — do not
hand-edit them (they are overwritten on regen; see `clients/README.md`). Everything in this
module is the thin, hand-written ergonomics layer over that generated code: friendly client
classes with a sensible default `base_url`.

Quick start (hosted Photon trial endpoint, no local server needed):

    from mailwoman_client import PhotonClient
    from mailwoman_client.photon.api.geocoding import search

    client = PhotonClient.hosted()          # https://photon.sister.software
    fc = search.sync(client=client, q="berlin", limit=3)
    for feature in fc.features:
        print(feature.properties.name, feature.geometry.coordinates)

Self-hosting (`npx @mailwoman/photon serve`)? Every client defaults to its local `serve`
port, so `PhotonClient()` / `NominatimClient()` / `LibpostalClient()` just work against a
localhost server. Point elsewhere with `PhotonClient(base_url="http://…")`.
"""

from .libpostal.client import Client as _LibpostalBase
from .nominatim.client import Client as _NominatimBase
from .photon.client import Client as _PhotonBase

__all__ = (
    "PhotonClient",
    "NominatimClient",
    "LibpostalClient",
    "PHOTON_HOSTED_BASE_URL",
)

#: The hosted public Photon trial endpoint (conservative rate limits). Only Photon has a
#: hosted trial; the Nominatim and libpostal drop-ins are self-host only.
PHOTON_HOSTED_BASE_URL = "https://photon.sister.software"


class PhotonClient(_PhotonBase):
    """Client for the Photon-compatible autocomplete / reverse geocoding API (`/api`, `/reverse`).

    Defaults to the local `npx @mailwoman/photon serve` port (2322). Use
    :meth:`hosted` for the public trial endpoint, or pass ``base_url=`` for anything else.
    Call it with the generated endpoint functions, e.g.
    ``mailwoman_client.photon.api.geocoding.search.sync(client=client, q=…)``.
    """

    DEFAULT_BASE_URL = "http://127.0.0.1:2322"

    def __init__(self, base_url: str | None = None, **kwargs) -> None:
        super().__init__(base_url=base_url or self.DEFAULT_BASE_URL, **kwargs)

    @classmethod
    def hosted(cls, **kwargs) -> "PhotonClient":
        """Return a client pointed at the hosted public trial endpoint (:data:`PHOTON_HOSTED_BASE_URL`)."""
        return cls(base_url=PHOTON_HOSTED_BASE_URL, **kwargs)


class NominatimClient(_NominatimBase):
    """Client for the Nominatim-compatible geocoding API (`/search`, `/reverse`, `/lookup`, `/status`).

    Defaults to the local `npx @mailwoman/nominatim serve` port (8080). Pass ``base_url=``
    to point elsewhere. Self-host only — there is no hosted public endpoint.
    """

    DEFAULT_BASE_URL = "http://127.0.0.1:8080"

    def __init__(self, base_url: str | None = None, **kwargs) -> None:
        super().__init__(base_url=base_url or self.DEFAULT_BASE_URL, **kwargs)


class LibpostalClient(_LibpostalBase):
    """Client for the libpostal-compatible parse / expand API (`/parse`, `/expand`).

    Defaults to the local `npx @mailwoman/libpostal serve` port (8081). Pass ``base_url=``
    to point elsewhere. Self-host only — there is no hosted public endpoint.
    """

    DEFAULT_BASE_URL = "http://127.0.0.1:8081"

    def __init__(self, base_url: str | None = None, **kwargs) -> None:
        super().__init__(base_url=base_url or self.DEFAULT_BASE_URL, **kwargs)
