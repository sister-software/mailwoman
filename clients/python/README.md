# mailwoman-client (Python)

Typed Python clients for [Mailwoman](https://mailwoman.sister.software)'s three HTTP drop-in
APIs, **generated from their published OpenAPI 3.1 specs** and bundled under one distributable:

| Subpackage                   | Drop-in for | Endpoints                                   |
| ---------------------------- | ----------- | ------------------------------------------- |
| `mailwoman_client.photon`    | Photon      | `/api`, `/reverse`                          |
| `mailwoman_client.nominatim` | Nominatim   | `/search`, `/reverse`, `/lookup`, `/status` |
| `mailwoman_client.libpostal` | libpostal   | `/parse`, `/expand`                         |

The three subpackages are generated verbatim by [`openapi-python-client`](https://github.com/openapi-generators/openapi-python-client)
(they run their own `ruff` pass) and are **overwritten on regen** — do not hand-edit them. The
only hand-written code is the thin ergonomics layer in `mailwoman_client/__init__.py`:
`PhotonClient` / `NominatimClient` / `LibpostalClient`, each with a sensible default `base_url`.
See [`../README.md`](../README.md) for the regeneration command.

## Install

```bash
pip install mailwoman-client
```

Requires Python 3.10+. The only runtime dependencies are `httpx` and `attrs`.

## Usage

Forward-geocode against the hosted Photon trial endpoint (`https://photon.sister.software`, no
local server needed):

```python
from mailwoman_client import PhotonClient
from mailwoman_client.photon.api.geocoding import search

client = PhotonClient.hosted()  # or PhotonClient(base_url="http://127.0.0.1:2322") to self-host
result = search.sync(client=client, q="berlin", limit=3)

for feature in result.features:
    lon, lat = feature.geometry.coordinates
    props = feature.properties
    print(f"{props.name} ({props.type_}) — {lat:.4f}, {lon:.4f} [{props.country or '?'}]")
```

Verified output (against `https://photon.sister.software`):

```
Berlin (city) — 52.5015, 13.4019 [Germany]
Berlin (city) — 41.6114, -72.7758 [United States]
Berlín (city) — 13.5000, -88.5333 [?]
```

### Self-hosting

`PhotonClient()`, `NominatimClient()`, and `LibpostalClient()` default to their local
`serve` ports (2322 / 8080 / 8081), so they work out of the box against a self-hosted server
(`npx @mailwoman/photon serve`, etc.). Only Photon has a hosted public trial endpoint; the
Nominatim and libpostal drop-ins are self-host only. Point anywhere with `base_url=`.

### Async

Every endpoint module also exposes an `asyncio` coroutine alongside `sync`:

```python
result = await search.asyncio(client=client, q="berlin", limit=3)
```

## License

AGPL-3.0-only OR LicenseRef-Commercial (see the [repository](https://github.com/sister-software/mailwoman)).
