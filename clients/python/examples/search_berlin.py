"""Forward-geocode "berlin" against the hosted Photon trial endpoint and print the top 3 hits.

Run: ``python examples/search_berlin.py`` (from clients/python, after `pip install -e .`).
"""

from mailwoman_client import PhotonClient
from mailwoman_client.photon.api.geocoding import search

client = PhotonClient.hosted()  # https://photon.sister.software
result = search.sync(client=client, q="berlin", limit=3)

for feature in result.features:
    lon, lat = feature.geometry.coordinates
    props = feature.properties
    print(f"{props.name} ({props.type_}) — {lat:.4f}, {lon:.4f} [{props.country or '?'}]")
