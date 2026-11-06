# RGY1: the registry artifact layout

RGY1 is the binary container `@mailwoman/registry` ships its lookup tables in. This document is the
normative layout. The Rust writer in `crates/registry-build`, the Rust reader in `crates/registry-core`
and the TypeScript reader in `lib/rgy1/reader.ts` follow it, and `lib/rgy1/layout.test.ts` walks the
committed fixture artifacts with its own byte reader against `test/fixtures/layout.json`, so agreement
between the writer and a reader is never the only check.

RGY1 is inspired by PIX1 (`docs/engineering/reference/pix1.ksy`) and shares no bytes with it. PIX1 sorts
tuples by UTF-16 code units. RGY1 orders every table by a numeric key computed from the code's spelling, so
no reader compares strings and no comparator has to agree across languages.

## Integers and offsets

Every integer is unsigned little-endian. Version 1 limits every offset and length to `u32`, so an
artifact is smaller than 4 GiB. Every offset is relative to byte 0 of the artifact, never to a backing
buffer. A reader given a subarray behaves as it would given the same bytes alone.

`align8(x)` is `x` rounded up to a multiple of 8.

## Envelope

| Byte offset | Type     | Field                                                                               |
| ----------- | -------- | ----------------------------------------------------------------------------------- |
| 0           | 4 bytes  | ASCII `RGY1`                                                                        |
| 4           | `u16`    | Envelope version, `1`                                                               |
| 6           | `u16`    | Envelope flags, `0`; a reader refuses any set bit                                   |
| 8           | `u32`    | Header byte length                                                                  |
| 12          | `u32`    | Section count                                                                       |
| 16          | `u32`    | Directory byte offset, equal to `align8(32 + header length)`                        |
| 20          | `u32`    | Total artifact byte length                                                          |
| 24          | `u32`    | First payload byte offset, equal to `align8(directory offset + section count × 24)` |
| 28          | `u32`    | Reserved, `0`                                                                       |
| 32          | variable | The header: canonical UTF-8 JSON                                                    |

The bytes between the header's end and the directory are zero. A reader checks each equality above and
refuses an artifact whose stated total length differs from the byte count it was given.

## Header

The header is one JSON object serialized without whitespace, with its keys in byte order and every
nested object's keys in byte order. Numbers are integers. Strings are UTF-8 with JSON's mandatory escapes
only. The writer produces this form by serializing a `serde_json::Map`, which is a `BTreeMap`.

The header carries no wall-clock time, host path or hash of the artifact itself. The artifact's SHA-256
lives in `data/manifests/artifacts.json`, written by `tools/generate.run.ts` after the bytes exist.

Fields every artifact carries:

| Key                    | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `artifact`             | The artifact's name, such as `country-airport-collision`                     |
| `profile`              | The source profile, such as `open-2026-11` or `fixture-synthetic`            |
| `namespaces`           | The identifier namespaces the artifact answers for                           |
| `sources`              | `{ id, sha256, publication }` per source the artifact was compiled from      |
| `coverage`             | Counts the artifact holds, per namespace or relation                         |
| `schemaVersion`        | The namespace semantic-schema version, `1`                                   |
| `normalizationVersion` | The normalization version of the records the artifact was compiled from, `1` |
| `envelopeVersion`      | `1`                                                                          |
| `encodings`            | Section kind name to encoding version, for every kind the writer knows       |
| `generator`            | The writer's crate name and version                                          |

A records artifact adds `rows`, `columns` (`{ name, type, width }` in column order; a `u8` column with a
closed vocabulary adds `values`, and a key column that can be absent adds `absent`) and, when it holds a
relation, `relations` (`{ name, source, targets }` in relation order). A membership artifact adds `status`
or `kinds`. The collision artifact adds `meaning`.

## Directory

The directory starts at the directory offset and holds one 24-byte entry per section:

| Entry offset | Type  | Field                                                                  |
| ------------ | ----- | ---------------------------------------------------------------------- |
| 0            | `u16` | Section kind                                                           |
| 2            | `u16` | The encoding version of that kind                                      |
| 4            | `u16` | Element width in bytes; `0` for a variable-width or bit-packed payload |
| 6            | `u16` | Section flags; bit 0 means required for interpretation                 |
| 8            | `u32` | Section byte offset                                                    |
| 12           | `u32` | Section byte length                                                    |
| 16           | `u32` | Logical element count, defined per kind                                |
| 20           | `u32` | Auxiliary value, defined per kind; `0` when the kind defines none      |

Sections appear in directory order, each starting at a multiple of 8 at or after the previous section's
end, with zero bytes in any gap. The first section starts at the first payload offset. Fewer than eight
zero bytes may follow the last section, so the total length is a multiple of 8.

A reader refuses an unknown kind marked required and skips an unknown kind that is not. A known kind
with an encoding the reader does not implement is refused.

## Keys

A table is direct-addressed by a key computed from the code's canonical spelling. The key arity is the
section's auxiliary value.

| Arity | Key space | Key                                                         |
| ----- | --------- | ----------------------------------------------------------- |
| 2     | 676       | `(a − 65) × 26 + (b − 65)` for two upper-case ASCII letters |
| 3     | 17,576    | `((a − 65) × 26 + (b − 65)) × 26 + (c − 65)`                |
| 0     | 1,000     | The decimal value of three ASCII digits                     |

The length and alphabet are checked before the key is computed. A code outside its grammar has no key
and is absent from every table.

## Section kinds

`definitions/sections.json` is the single definition of the kinds; `tools/generate-sections.run.ts`
writes `lib/rgy1/sections.generated.ts` and `crates/registry-core/src/sections.rs` from it.

| Id  | Kind               | Width      | Count                | Aux                      | Payload                                                              |
| --- | ------------------ | ---------- | -------------------- | ------------------------ | -------------------------------------------------------------------- |
| 1   | `bitset`           | 0          | Key space size       | Key arity                | `ceil(count / 8)` bytes; bit `key & 7` of byte `key >> 3`            |
| 2   | `id-table`         | 1, 2 or 4  | Key space size       | Key arity                | Row id plus one per key; `0` means absent                            |
| 3   | `string-offsets`   | 4          | Strings plus one     | 0                        | Monotonic byte offsets into the `utf8` section, ending at its length |
| 4   | `utf8`             | 0          | Byte length          | 0                        | Strict UTF-8; string `i` is bytes `offsets[i]..offsets[i+1]`         |
| 5   | `column`           | 1, 2, 4, 8 | Rows                 | Column index in header   | Fixed-width cells; width 8 is an IEEE 754 double                     |
| 6   | `relation-offsets` | 4          | Source keys plus one | Relation index in header | Monotonic offsets into the matching `relation-targets`               |
| 7   | `relation-targets` | 4          | Targets              | Relation index in header | Row ids in the relation's target set                                 |

A string pool's string 0 is the empty string, so a column cell of `0` reads as no value. An `id-table`
with width 2 addresses at most 65,534 rows (`0xFFFE`); the writer refuses more.

## Reader validation

A reader validates once on load: magic, version, flags, reserved field, total length, header UTF-8, the
two alignment equalities, zero fill between header and directory and between sections, each section's
bounds, order and alignment, each kind's width and count rules, and each bitset's and id-table's key
space. A string pool's offsets and a relation's offsets are checked when the typed view is built, where
the paired section is known. Repeated probes then read the table in place.

## The artifacts this release ships

| Artifact                      | Sections                                                                                   | Serves                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `iso3166-1-alpha2-membership` | `bitset` (arity 2)                                                                         | `isCountryCodeAlpha2`                                             |
| `iso3166-1-alpha3-membership` | `bitset` (arity 3)                                                                         | `isCountryCodeAlpha3`                                             |
| `iso3166-1-records`           | `id-table` ×3, `column` ×6, `string-offsets`, `utf8`                                       | `getCountryByAlpha2`, `getCountryByAlpha3`, `getCountryByNumeric` |
| `iata-airport-membership`     | `bitset` (arity 3)                                                                         | `isAirportCode`                                                   |
| `iata-airport-records`        | `id-table`, `column` ×13, `string-offsets`, `utf8`, `relation-offsets`, `relation-targets` | `getAirportByIATA`, `airportsInCountry`                           |
| `country-airport-collision`   | `bitset` (arity 3)                                                                         | `isCountryAirportCollision`                                       |

The collision bitset holds the intersection of the `iso3166-1-alpha3-membership` and
`iata-airport-membership` bitsets. Its payload is 2,197 bytes before the envelope, and
`lib/overlap/country-airport.test.ts` holds every one of its 17,576 bits equal to a set intersection
computed from the normalized JSON.
