---
title: Acknowledgements
sidebar_label: Third Party Notices
id: third-party-notices
---

Mailwoman is distributed under the [AGPL-3.0 license](https://www.gnu.org/licenses/agpl-3.0.html)
(with a commercial license available — contact `teffen@sister.software`), and is made
possible through the contributions of the open-source community.

The notices below are split by where each dependency reaches you:

- **Code** and **Data bundled in the published packages** travel inside the npm tarballs and
  are redistributed to everyone who installs Mailwoman.
- **Used only when developing Mailwoman** covers sources that build the model, corpus, evals,
  and this documentation site — none are redistributed in any published npm package.

## Code

### Pelias Parser

Mailwoman originated as a TypeScript fork of [Pelias Parser](https://github.com/pelias/parser).
Portions derived from it (the tokenizer, rule-based classifiers, and the solver) remain under
the [MIT license](https://github.com/pelias/parser/blob/master/LICENSE).

## Data bundled in the published packages

These ship inside `@mailwoman/core`, with the upstream license text vendored beside each
dataset in the package.

### libpostal

`@mailwoman/core` bundles address-component dictionaries from
[libpostal](https://github.com/openvenues/libpostal) (© 2015 openvenues), under the
[MIT license](https://github.com/openvenues/libpostal/blob/master/LICENSE).

### Google libaddressinput

`@mailwoman/core` bundles per-country address metadata from Google's
[libaddressinput](https://github.com/google/libaddressinput) (the `chromium-i18n`
`ssl-address` data), under the
[Apache-2.0 license](https://github.com/google/libaddressinput/blob/master/LICENSE).

### Who's On First

Mailwoman uses reference data from [Who's On First](https://whosonfirst.org/), a gazetteer of
places and their relationships. Its data is derived from several sources with their own
licenses. See the [Who's On First licenses](https://www.whosonfirst.org/docs/licenses/).

## The model

The `@mailwoman/neural-weights-*` packages ship an ONNX model trained from scratch by Sister
Software. Its training corpus is derived from the open data below (Who's On First,
OpenAddresses, GeoNames); the weights are a first-party artifact and the corpus provenance is
tracked per row.

## Used only when developing Mailwoman

The following build the corpus, gazetteer shards, evaluations, and this site. They are **not**
redistributed in any published npm package.

### GeoNames

[GeoNames](https://www.geonames.org/) postal and centroid data builds gazetteer postcode
shards and training corpus, under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

### OpenAddresses

[OpenAddresses](https://openaddresses.io/) address points are used in the training corpus and
evaluations. The license for each source differs, and many require attribution and
share-alike.

### OpenStreetMap

[OpenStreetMap](https://www.openstreetmap.org/) data is licensed under the
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/). Usage may
require attribution, and derived databases must be shared under the same license.

### MapLibre

This site renders maps with [MapLibre GL JS](https://maplibre.org/), under the
[BSD 3-Clause License](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt).

### Protomaps

This site renders vector tiles via [Protomaps](https://protomaps.com/). The PMTiles format is
public-domain; Earth-scale tilesets derive from OpenStreetMap and share its attribution. See
[Protomaps legal](https://protomaps.com/legal).

### MDN Web Docs

Some documentation examples derive from [MDN](https://developer.mozilla.org/) by
[Mozilla Contributors](https://developer.mozilla.org/en-US/docs/MDN/Community/Contributing),
under [CC-BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/).

### TypeDoc

Mailwoman generates API documentation with [TypeDoc](https://typedoc.org) and the
[TypeDoc Markdown plugin](https://github.com/tgreyuk/typedoc-plugin-markdown).

## A special thanks to...

- The folks at OpenStreetMap for building and maintaining the world's largest open map.
- Julian Simioni from [Geocode Earth](https://geocode.earth) for guidance, support, and
  kindness in all things geospatial.
- The brilliant engineers and maintainers of [code-server](https://github.com/coder/code-server).
- And [all the wonderful people](https://github.com/sister-software/mailwoman/graphs/contributors)
  who've contributed to Mailwoman.
