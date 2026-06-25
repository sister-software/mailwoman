# Third-Party Notices

Mailwoman is distributed under [AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
(with a commercial license available — contact `teffen@sister.software`). It builds upon the
third-party code and data listed below.

The list is split by where each dependency reaches you:

- **Code** and **Data bundled in the published packages** travel inside the npm tarballs and
  are redistributed to everyone who installs Mailwoman.
- **Used only when developing Mailwoman in this repository** covers sources that build the
  model, corpus, evals, and documentation site. None of these are redistributed in any
  published npm package — they apply only when working in the repo.

---

## Code

### Pelias Parser — MIT

Mailwoman originated as a TypeScript fork of [Pelias Parser](https://github.com/pelias/parser).
Portions derived from it — the tokenizer, rule-based classifiers, and the
`ExclusiveCartesianSolver` in `@mailwoman/core` and `@mailwoman/classifiers` — remain under
the [MIT license](https://github.com/pelias/parser/blob/master/LICENSE).

## Data bundled in the published packages

These ship inside `@mailwoman/core` (under `data/`), with the upstream license text vendored
beside each dataset.

### libpostal dictionaries — MIT

Address-component dictionaries from [libpostal](https://github.com/openvenues/libpostal)
(© 2015 openvenues), under `core/data/libpostal/` and
`core/data/internal/dictionaries/libpostal/`. License: `core/data/libpostal/LICENSE`.

### Google libaddressinput (chromium-i18n) — Apache-2.0

Per-country address metadata from Google's
[libaddressinput](https://github.com/google/libaddressinput), fetched from
`chromium-i18n.appspot.com/ssl-address`, under `core/data/chromium-i18n/ssl-address/`.
License: `core/data/chromium-i18n/LICENSE`.

### Who's On First — community/various

Reference dictionaries derived from [Who's On First](https://whosonfirst.org/), under
`core/data/whosonfirst/`. WOF data draws on several sources with their own licenses; see the
[Who's On First licenses](https://www.whosonfirst.org/docs/licenses/).

## The model

`@mailwoman/neural-weights-en-us` and `@mailwoman/neural-weights-fr-fr` ship an ONNX model
trained from scratch by Sister Software (AGPL-3.0). The training corpus is derived from the
open data listed below (Who's On First, OpenAddresses, GeoNames); the model weights are a
first-party artifact and the corpus provenance is tracked per row.

## Used only when developing Mailwoman in this repository

The following are used to build the corpus, gazetteer shards, evaluations, and the
documentation site. They are **not** redistributed in any published npm package.

### GeoNames — CC-BY 4.0

[GeoNames](https://www.geonames.org/) postal and centroid data is used to build gazetteer
postcode shards and the training corpus, under
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

### OpenAddresses — various

[OpenAddresses](https://openaddresses.io/) address points are used in the training corpus and
evaluations. Per-source licenses differ; many require attribution and share-alike.

### OpenStreetMap — ODbL

[OpenStreetMap](https://www.openstreetmap.org/) data (via Who's On First and Overture) is
licensed under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).

### MapLibre GL JS — BSD-3-Clause

The documentation site renders maps with
[MapLibre GL JS](https://maplibre.org/), under the
[BSD 3-Clause License](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt).

### Protomaps

The documentation site renders vector tiles via [Protomaps](https://protomaps.com/). The
PMTiles format is public-domain; Earth-scale tilesets derive from OpenStreetMap and carry its
attribution. See [Protomaps legal](https://protomaps.com/legal).

### MDN Web Docs — CC-BY-SA 2.5

Some documentation examples derive from [MDN](https://developer.mozilla.org/) by Mozilla
Contributors, under [CC-BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/).

### TypeDoc

API documentation is generated with [TypeDoc](https://typedoc.org) and the
[TypeDoc Markdown plugin](https://github.com/tgreyuk/typedoc-plugin-markdown).

---

## A special thanks to

- The folks at OpenStreetMap, for building and maintaining the world's largest open map.
- Julian Simioni of [Geocode Earth](https://geocode.earth), for guidance and kindness in all
  things geospatial.
- The maintainers of [code-server](https://github.com/coder/code-server).
- And [everyone who has contributed to Mailwoman](https://github.com/sister-software/mailwoman/graphs/contributors).
