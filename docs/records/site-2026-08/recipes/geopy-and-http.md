---
title: Point your existing stack at Mailwoman
id: geopy-and-http
role: guide
audience: product-reader
source-of-truth: nominatim/routes.ts, nominatim/cli.ts, docker/README.md, docker/docker-compose.yml
prerequisites: Docker or Podman; a Python environment with geopy for the client examples; a mounted gazetteer for geocoding (parse-only needs none)
verified-with: mailwoman v7.3.0, geopy 2.5.0
---

You already have a geocoding client. It's a `geopy.Nominatim` call in a Python script, or a `fetch` against `/search` somewhere in a batch job. It points at the public Nominatim server, and that server asks for at most one request per second, so a table of any size takes days. Or it points at a hosted API that bills per request, and the bill scales with the table. Or you run your own Nominatim, which means PostgreSQL, an `osm2pgsql` import measured in hours and tens of gigabytes, and a box you can't put inside an app.

You don't have to rewrite the client to fix any of that. Mailwoman ships a [Nominatim-compatible endpoint](../concepts/switching-from-nominatim.mdx) — same `/search` and `/reverse` contract, from a SQLite file instead of a PostgreSQL cluster. Point the client you already have at a local instance and it works, with no code change. By the end of this page you'll have that instance running from one `docker run`, and your geopy (or plain-HTTP) calls hitting it.

## Start the server

The container installs the published `@mailwoman/*` packages and bakes the model weights in, so a first run parses with no data at all. Geocoding needs a gazetteer, which stays out of the image and mounts at `/data`. Run the Nominatim drop-in and point it at a mailwoman data root:

```bash
docker run --rm -p 8080:8080 \
  -v /path/to/mailwoman-data:/data:ro \
  -e MAILWOMAN_CANDIDATE_DB=/data/wof/candidate.db \
  ghcr.io/sister-software/mailwoman:latest \
  node node_modules/@mailwoman/nominatim/out/cli.js serve
```

Don't have a gazetteer yet? The worldwide candidate database is one download (~1.4 GB, and it opens read-only, so the `:ro` mount above is correct):

```bash
mkdir -p mailwoman-data/wof
curl -fSL https://public.sister.software/mailwoman/gazetteer/2026-07-07a/candidate.db \
  -o mailwoman-data/wof/candidate.db
```

If you'd rather run the whole set of drop-ins together (native `/v1` API, Nominatim, Photon, libpostal), the repo ships a [`docker-compose.yml`](https://github.com/sister-software/mailwoman/blob/main/docker/docker-compose.yml):

```bash
MAILWOMAN_DATA_HOST=/path/to/mailwoman-data \
  docker compose -f docker/docker-compose.yml up nominatim
```

Either way you get a server on port 8080. Check it's up:

```bash
curl -s http://localhost:8080/status
# {"status":0,"message":"OK"}
```

No Docker? The same command runs straight from npm — `npx @mailwoman/nominatim serve --port 8080 --candidate-db /path/to/mailwoman-data/wof/candidate.db`. Podman works too: swap `docker` for `podman`, the flags are the same.

## geopy: forward geocoding

geopy's `Nominatim` class takes a `domain` and a `scheme`, so pointing it at your local server is two keyword arguments. Nothing else about your code changes:

```python
from geopy.geocoders import Nominatim

geo = Nominatim(domain="localhost:8080", scheme="http", user_agent="my-app")

loc = geo.geocode("1600 Pennsylvania Avenue NW, Washington, DC 20500", addressdetails=True)

print(loc.address)
print(loc.latitude, loc.longitude)
print(loc.raw["address"])
```

That prints a rooftop-level result — the query carried a house number, so the resolver returns the point, not a street or city centroid:

```text
1600, Pennsylvania Avenue NW, Washington, DC, 20500
38.89767510742324 -77.03654697024702
{'city': 'Washington', 'state': 'DC', 'postcode': '20500', 'house_number': '1600', 'road': 'Pennsylvania Avenue NW'}
```

`addressdetails=True` is what fills `raw["address"]` with the parsed components. Drop it and you still get `.address`, `.latitude`, and `.longitude`.

## geopy: reverse geocoding

`reverse` takes a `(lat, lon)` pair and returns the nearest address. Mailwoman answers it with a point-in-polygon lookup over the WhosOnFirst admin polygons:

```python
rev = geo.reverse((38.897675, -77.036547))

print(rev.address)
print(rev.raw["address"])
```

```text
White House Grounds, Washington, District of Columbia, United States
{'suburb': 'White House Grounds', 'city': 'Washington', 'state': 'District of Columbia', 'country': 'United States', 'country_code': 'us'}
```

## The enriched block plain Nominatim doesn't send

Every result carries an OpenCage-style `annotations` block that upstream Nominatim has no equivalent for: coordinate formats (DMS, MGRS, geohash, Maidenhead, Mercator), a qibla bearing, sun times, the IANA timezone, and — when their data bundles are mounted — the UN/LOCODE and EU NUTS codes. geopy keeps it on `loc.raw["annotations"]`:

```python
loc = geo.geocode("1600 Pennsylvania Avenue NW, Washington, DC 20500")
tz = loc.raw["annotations"]["timezone"]
print(tz["name"], tz["offset_sec"])
# America/New_York -14400
```

## Other stacks: any HTTP client

geopy is one client. The endpoint is plain HTTP with the Nominatim query contract, so anything that speaks `GET /search?q=…` works — `curl`, `requests`, a Go or Rust client, a browser `fetch`. Here it is with `curl`:

```bash
curl -s "http://localhost:8080/search?q=350+5th+Ave,+New+York,+NY+10118&format=json&addressdetails=1"
```

```json
[
	{
		"lat": "40.747773",
		"lon": "-73.985046",
		"display_name": "350, 5th Ave, New York, NY, 10118",
		"class": "place",
		"type": "house",
		"address": {
			"city": "New York",
			"state": "NY",
			"postcode": "10118",
			"house_number": "350",
			"road": "5th Ave"
		}
	}
]
```

`format=json` and `addressdetails=1` are the standard Nominatim query parameters, so a client you built against the real thing sends the same request here.

For type-ahead and autocomplete — the partial-query, as-you-type case — reach for the [Photon drop-in](../concepts/switching-from-photon.mdx) instead. It's the same image with a different command (`node node_modules/@mailwoman/photon/out/cli.js serve`, port 2322) and returns GeoJSON `FeatureCollection`s, which is what Photon clients expect.

## Where to go next

- [Switching from Nominatim](../concepts/switching-from-nominatim.mdx) is the full endpoint map, the response differences, and the fields Mailwoman fills that upstream leaves empty (and the few it leaves out).
- [The free first pass](./multi-service-geocoding.md) is the recipe for the paid-API case: geocode everything locally, then spend money only on the residual the local pass couldn't pin well enough. Every result tells you, per row, how good its answer is.
- [Batch geocoding](./batch-geocoding.md) uses the native `/v1/batch` endpoint (same image, default command) when you control the client and want per-row error isolation over a whole table in one request.
