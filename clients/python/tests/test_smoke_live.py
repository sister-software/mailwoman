"""Live smoke test for the generated Photon client against the hosted trial endpoint.

Hits https://photon.sister.software (the public trial server) and asserts the typed client
round-trips a real forward-geocoding query. Network-dependent; skipped automatically if the
endpoint is unreachable, so it never fails a hermetic CI leg.

Run just this: ``pytest tests/test_smoke_live.py``.
"""

import httpx
import pytest
from mailwoman_client import PhotonClient
from mailwoman_client.photon.api.geocoding import search
from mailwoman_client.photon.models import PhotonFeatureCollection


def test_photon_search_berlin_hosted() -> None:
    client = PhotonClient.hosted()
    try:
        result = search.sync(client=client, q="berlin", limit=3)
    except httpx.HTTPError as exc:  # network flake / endpoint down — don't fail hermetic CI
        pytest.skip(f"hosted endpoint unreachable: {exc}")

    assert isinstance(result, PhotonFeatureCollection)
    assert result.type_ == "FeatureCollection"
    assert len(result.features) == 3
    first = result.features[0]
    # `type` is guaranteed present on every Photon feature (osm_key/osm_value/type always set).
    assert first.properties.type_ == "city"
    # A GeoJSON Point carries [lon, lat].
    assert len(first.geometry.coordinates) == 2
