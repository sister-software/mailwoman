---
license: odbl
tags:
  - gazetteer
  - overture-maps
  - openstreetmap
  - mailwoman
pretty_name: Mailwoman candidate gazetteer, Overture Divisions part
---

# Mailwoman candidate gazetteer: the Overture Divisions part

This dataset is the Overture Divisions part of the Mailwoman candidate gazetteer (`candidate.db`), offered by
itself under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) as its section 4.6
requires.

© OpenStreetMap contributors, Overture Maps Foundation. Overture's [attribution
page](https://docs.overturemaps.org/attribution/) gives its Divisions theme `License for theme: ODbL`.

## How it relates to `candidate.db`

`candidate.db` is a Collective Database under ODbL 1.0 section 4.5(a). This part is one independent database
inside it. The other rows come from Who's On First, GeoNames and the postcode databases, and they keep their own
terms. Each published gazetteer's `layer_manifest.attribution` states this part and this offer's address.

The part stays independent because no row outside it depends on it. The gazetteer build writes every Overture
division as its own row and adds no name, Wikidata id or population to a Who's On First record. When a division
matches a Who's On First place, the build records the pair in `overture_wof_match`. A division's parent may be a Who's On First id.
The division's row stores that reference. The candidate build reads a division's row only to change
another division's row.

## Contents

One sealed SQLite database per gazetteer version, `candidate-overture-divisions-<version>.db`, with the
candidate's own table definitions:

| Table                | Rows it holds                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidate`          | every name row whose `spr_id` is 8000000000000 to 8999999999999                                                                                     |
| `candidate_ancestor` | the closure rows of those places. A row's parent may be a Who's On First id and name, so that parent ID refers to another record in the collection. |
| `candidate_interval` | the interval labels of those places                                                                                                                 |
| `overture_wof_match` | the Who's On First record each division was matched to, and the evidence (`country`, `wikidata`, `geonames` or `name`)                              |
| `country_codes`      | the codes `candidate.country_id` decodes to                                                                                                         |
| `placetype_codes`    | the placetypes `candidate.placetype_id` decodes to                                                                                                  |
| `layer_manifest`     | the part's license, credit, source candidate md5, Overture release and row counts                                                                   |

`mailwoman gazetteer build overture-part --candidate <candidate.db> --out <file> --release <overture release>
--part-version <gazetteer version>` writes the file from a built candidate.

## License

The data in this dataset is licensed under the Open Database License 1.0. Keep this license on the data and on
any database derived from it, and credit `© OpenStreetMap contributors, Overture Maps Foundation`.
