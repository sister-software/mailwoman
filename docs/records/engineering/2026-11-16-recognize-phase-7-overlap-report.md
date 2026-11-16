# recognize Phase 7, part 1: the remaining families and the spatial overlap report

This record is part 1 of Phase 7 of issue 3064. It follows `2026-11-15-recognize-phase-0-inventory.md`, section 2, which lists the recognizers that overlap.
Issue 3090 tracks the work.
It adds the grammars, validators and typed payloads of the remaining recognizer families, extends the Phase 4 differential to every spatial text recognizer, and reports where `recognize` accepts what each of them accepts.
It deletes no recognizer and changes no caller. A later task applies decision 8, starting from this record.

Each claim is marked **observed** (a command printed it), **inferred** (read from code, with the reading stated) or **decided** (a choice this work made, with its reason).
Every count comes from the committed report `packages/recognize/data/reports/point-query-differential.json`, written by `packages/mailwoman/tools/dev-tools/recognize/point-differential.run.ts`, unless a line says otherwise.

## 1. What `recognize` reads now

| Family        | Shape                                                                                                               | Scope                                                | Validator       |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| `coordinates` | `coordinate.decimal_pair_spaced`                                                                                    | Whole input only                                     | `SpacedPair`    |
| `coordinates` | `coordinate.dms_pair`                                                                                               | Whole input or embedded, `token` boundary            | `AnglePair`     |
| `coordinates` | `coordinate.dms_pair_spaced`                                                                                        | Whole input only                                     | `AnglePair`     |
| `coordinates` | `coordinate.labeled_pair`                                                                                           | Whole input or embedded, `token` boundary            | `LabeledPair`   |
| `coordinates` | `coordinate.maps_segment`                                                                                           | Whole input or embedded, `token` boundary            | `MapsSegment`   |
| `spatial`     | `plus_code.token`                                                                                                   | Whole input or embedded, `token` boundary            | `PlusCode`      |
| `spatial`     | `digipin.compact`                                                                                                   | Whole input only                                     | `DIGIPIN`       |
| `spatial`     | `digipin.display`                                                                                                   | Whole input or embedded, `token` boundary            | `DIGIPIN`       |
| `spatial`     | `geojson.object`                                                                                                    | Whole input only                                     | `GeoJSON`       |
| `identifiers` | `h3.cell`, `h3.prefixed_cell`                                                                                       | Whole input, and also embedded for the prefixed form | `H3Cell`        |
| `identifiers` | `geohash.prefixed`                                                                                                  | Whole input or embedded, `token` boundary            | `Geohash`       |
| `identifiers` | `wof.reference`, `wof.spelunker_url`                                                                                | Whole input only                                     | `WhosOnFirstID` |
| `identifiers` | `census.geoid_state`, `census.geoid_county`, `census.geoid_tract`, `census.geoid_block_group`, `census.geoid_block` | Whole input only                                     | `CensusGEOID`   |
| `identifiers` | `gnis.reference`, `gnis.summary_url`                                                                                | Whole input only                                     | `GNISFeatureID` |

The generated reference, `docs/engineering/reference/recognize-shapes.mdx` and one page for each family, lists every shape with its grammar, captures, payload fields, rejection codes, declared overlaps with witnesses and source line.

All five coordinate shapes build the payload of the decimal pair: a validated latitude, a validated longitude and the axis order.

### The specification behind each rule (observed from the pages read for this work)

- Open Location Code: the alphabet `23456789CFGHJMPQRVWX` (section "Character Set > Digits"), the separator `+` after eight digits (sections "Format Separator" and "Formatting"), codes of 2 to 15 digits with an even count below 10 (section "Code length"), a short code with 2 to 6 digits kept before the separator (section "Short Codes"), and upper case on output with case-insensitive input (section "API Requirements"). `@mailwoman/spatial` reads only the 10 and 11 digit full forms and the short forms, and `plus_code.token` does the same. A padded code and a code with more than three digits after the separator are valid in the specification and are not read.
- DIGIPIN: the alphabet `2 3 4 5 6 7 8 9 C J K L M P F T` (technical document, section 4.3) and a length of ten characters (section 2). The document forbids hyphens and requires upper case. `@mailwoman/spatial` reads the display form `39J-49L-L8T4` and lower case, so the shapes do too (decided, to match what the spatial decoder accepts). This is a difference between the published document and the spatial module.
- GeoJSON: the nine case-sensitive type names (RFC 7946 section 1.4), `coordinates` (section 3.1), a position of two or more numbers with longitude first and an optional altitude (section 3.1.1), `geometries` (section 3.1.8), `geometry` of a feature, which may be `null` (section 3.2), `features` (section 3.3) and the WGS 84 reference system (section 4).
- Census GEOID: the state is 2 digits, the county 3, the tract 6, the block group 1 and the block 4, and each level prepends its parents, so the GEOIDs are 2, 5, 11, 12 and 15 digits (the Census Bureau's page "GEOID Structure for Geographic Areas"). The first digit of a block is its block group.
- GNIS: the Census Bureau page says GNIS codes allow up to 10 digits. The USGS pages that define the feature identifier returned no content when read, so the 10 digit limit is the Census Bureau's statement and not USGS's.
- H3: a cell index is 64 bits with a reserved bit, four mode bits, three reserved bits, four resolution bits, a seven bit base cell and fifteen three-bit digits, and a cell has mode 1 (the H3 documentation, "H3 Cell Index"). The string is the hexadecimal digits without padding, so a cell is 15 digits that start with `8`. The page doesn't state the 15 digit length. It follows from the layout (inferred).
- Geohash: base 32 over the digits and the lower case letters except `a`, `i`, `l` and `o` (the Wikipedia article's "Textual representation"). No maximum length is stated, and the shape reads 1 to 12 characters as `parsePointQuery` does.
- Who's On First: an identifier is a unique 64-bit number (the documentation's "Portability"). The Spelunker address form `https://spelunker.whosonfirst.org/id/<id>/` isn't on the documentation pages read, and the shape reads it as `parsePointQuery` does.

### Where the GEOID and GNIS rules came from

- The state codes come from `AdminLevel1Code` in `@mailwoman/tiger` (`packages/tiger/lib/state.ts`): 57 codes for the 50 states, the District of Columbia and the territories. `@mailwoman/recognize` cannot depend on that package, because `tiger` depends on `spatial`, `spatial` on `postcode` and `postcode` on `recognize`. `packages/mailwoman/tools/dev-tools/recognize/fips-states.run.ts` writes the table into `crates/recognize-core/src/validators/us_state_fips.rs`, and its `--check` compares the committed file with `tiger`.
- The GEOID part lengths are the ones `GeoIDPartLength` in `packages/tiger/lib/geoid.ts` already encodes (2, 3, 6, 1, 4). `tiger`'s matchers read a prefix of a longer string. A whole-input grammar cannot reuse that, so the shapes hold the lengths directly.
- A search for an existing GNIS identifier parser (`mwdev_symbol`, then a grep for `gnis` in `packages/*/lib`, `tools` and `sdk`) found readers that take the identifier as an integer from the USGS layer (`packages/corpus/lib/us/tools/fetch/usgs/gnis.ts`) and a URL writer (`gnisFeatureURL` in `packages/gazetteer/tools/pipeline/us/gnis-backfill.ts`, observed). No code reads the identifier from text, so the shapes are new.
- A bare GNIS number has no shape (decided). A GNIS identifier is an integer of up to ten digits (the Census Bureau's statement), so every house number and every postcode of up to ten digits is also one. A bare shape would match each of them and give the caller no evidence. The prefix is the only evidence the text means a GNIS feature: `gnis:1234567`, `gnis 1234567`, or the summary page address that `gnisFeatureURL` writes.
- A GEOID and a bare H3 cell are candidates. A recognition says the digits have the structure of the identifier, with a known state code for a GEOID. Whether the area exists is a membership question. `isDeterministicIdentifier` in `@mailwoman/recognize/deterministic/identifiers` returns false for them.

### GeoJSON (observed)

The grammar is the cheap structural test: the text is a JSON object that holds a `"type"` member with one of the nine type names, in whole-input scope. The validator parses the text with `serde_json`, which the engine binary links already for its result JSON, and returns typed rejections: `malformed_json`, `unknown_geojson_type`, `misplaced_geojson_type`, `missing_member`, `malformed_position`, `longitude_out_of_range` and `latitude_out_of_range`. A document nested more than 128 levels is `malformed_json`. The payload carries the top-level type and, for a `Point`, the validated position.
The input limit is the family's 65,536 bytes: the engine refuses a longer text before it searches, whatever the text holds, so a call that includes `spatial` fails for any text of that length.
A position written with more than 15 digits may differ from the nearest `f64` in its last bit, because the `float_roundtrip` feature of `serde_json` costs 43,616 bytes of binary and stays off (decided).

## 2. Method

The report compares five spatial readings with their `recognize` counterpart on 48,763 distinct inputs (observed):

- `parsePointQuery` against the whole-text validated recognitions of the three families, as a point, plus code, H3 cell, geohash or Who's On First id. The two are compared on the parsed value: the latitude and longitude to full precision, the axis order, the upper-cased code with its full flag, the lower-cased cell or hash, and the id as a number.
- `isFullPlusCode` and `isShortPlusCode` against `plus_code.token` with its `full` flag.
- The checked DIGIPIN decoder `getLatLngFromDIGIPIN`: whether it throws, and the decoded cell center of the input against the cell center of the payload's code, decoded by the same function.
- `PLUS_CODE_TOKEN` against the first `plus_code.token` span. The module keeps the pattern unexported, so the tool holds a copy and fails if `packages/mailwoman/lib/plus-code-override.ts` spells it differently.

The inputs are the string literals of `point-query.test.ts`, `open-location-code.test.ts` and `digipin.test.ts`, and generated inputs from a seeded generator: decimal pairs and `geo:` URIs from Phase 4, 9,000 random pairs of angles with every mark and hemisphere letter, 2,500 labeled pairs, Maps segments, 6,000 plus codes with every prefix length and neighbor character, 4,000 DIGIPIN forms, identifiers with every prefix and bound, Unicode case-folding near misses, 6,000 random strings over the alphabet of all the shapes, address texts, and a padded variant of one input in seven.
The report holds every disagreement with both readings and a reason, up to 12 equal examples per recognizer, the count of equal readings by kind, and the SHA-256 of the full ordered table of readings, which a rerun reproduces (the tool's `--check`).

White space around the text (decided): `recognize` reports spans of the text it is given and its grammars admit no outer white space, so the caller passes `text.trim()`, as `parsePointQuery` trims its own input. The tool applies that contract to `parsePointQuery` only. The plus code and DIGIPIN readers don't trim, and the tool compares them on the text as given. Of 10,782 padded inputs, 1,595 are read by `parsePointQuery` only because it trims (observed). The alternative, a `recognize` option that trims, would make every offset refer to a text the caller didn't pass.

## 3. The spatial recognizers

| Recognizer             | Inputs | Equal values | Only spatial | Only `recognize` | Different values |
| ---------------------- | ------ | ------------ | ------------ | ---------------- | ---------------- |
| `parsePointQuery`      | 48,763 | 6,638        | 32           | 102              | 0                |
| `isFullPlusCode`       | 48,763 | 792          | 0            | 0                | 0                |
| `isShortPlusCode`      | 48,763 | 1,673        | 0            | 0                | 0                |
| `getLatLngFromDIGIPIN` | 48,763 | 818          | 0            | 0                | 0                |
| `PLUS_CODE_TOKEN`      | 48,763 | 8,339        | 0            | 1,127            | 0                |

The equal readings of `parsePointQuery` are 2,878 coordinates, 3,104 plus codes, 289 H3 cells, 284 geohashes and 83 Who's On First ids.
The two readings agree on the value in every input both accept, and a pair read longitude first reports `lon_lat` on both sides.

### `parsePointQuery`: the 32 inputs only the spatial recognizer accepts (observed, every one listed)

Seven drop what follows a second separator. `parsePointQuery` splits at the first separator and ignores the rest, so a third number is dropped: `1,2,3`, `1;2;3`, `1 ,2, 3`, `1, 2, `, `12°, 30°, 5°`, `9,0,` and `1;2;3 ` all read as the point `1,2` (or `12,30`, `9,0`). `recognize` reads no point from them. This is a defect of the spatial code (Phase 4 found it).

Twenty-three are `geo:` URIs with a parameter list that RFC 5870 section 3.3 refuses. The spatial pattern accepts any text after the first `;`, and `recognize` rejects them with a typed code or finds no match:
`geo:48.8584,2.2945;crs=Moon-2011`, `geo:48.8584,2.2945;u=-1`, `geo:48.8584,2.2945;u=5;crs=wgs84`, `geo:48.8584,2.2945;x=1;crs=wgs84`, `geo:48.8584,2.2945;u=1;u=2`, `geo:48.8584,2.2945;`, `geo:48.8584,2.2945;=`, `geo:48.8584,2.2945;a b`, `geo:48.8584,2.2945;a=%2`, `geo:48.8584,2.2945;é=1`, the same ten with the altitude `1,2,35` in place of `48.8584,2.2945`, and three padded forms: `\tgeo:48.8584,2.2945;u=-1\n`, `﻿geo:48.8584,2.2945;a b` and `geo:1,2,35;`. The parameters `crs=Moon-2011` and `u=-1` are the cases where `parsePointQuery` returns a point for a coordinate in a reference system other than WGS84, or with a negative uncertainty (looks wrong).

Two are Unicode case folds. The legacy patterns carry the `iu` flags, and in those flags `ſ` (U+017F) matches `s` and the Kelvin sign (U+212A) matches `k`, so `httpſ://spelunker.whosonfirst.org/id/1` and `whoſonfirſt:1` read as the Who's On First id 1. The grammars read ASCII letters (looks wrong).

### `parsePointQuery`: the 102 inputs only `recognize` accepts

All 102 hold a bare fraction, a number written `.5` with no digit before the point (`0,.5`, `12.5, .5`, `90.5 .5`). `recognize` reads the number as `signed_decimal` does and `parsePointQuery` needs digits before the point. This is the Phase 4 class, and the whitespace-only forms are now read by `coordinate.decimal_pair_spaced`.

### `PLUS_CODE_TOKEN`: the 1,127 inputs only `recognize` accepts

Every one has a neighbor of the token other than white space or a comma: `(`, `)`, `.`, `+` or another character outside the letters, digits and connectors (`xp4ww6j2+f48)`, `)WR+GP5(`, `(g2+5x `, `8Q+8X+`). `recognize` bounds a token by any character other than a letter, a digit or a connector, and `PLUS_CODE_TOKEN` requires white space, a comma or an edge of the text. The `recognize` rule reads `(VFQ6+92P)` and `VFQ6+92P.` as codes, and a caller that moves to it changes when the override fires.

Of the 8,339 equal readings, 2,198 are tokens with 3, 5 or 7 digits before the separator, such as `VFQ+92` and `H2Q+V3`. `PLUS_CODE_TOKEN` accepts them and `applyPlusCodeOverride` removes them from the components and then has no cell to decode. `recognize` reports them as candidates with the typed rejection `invalid_prefix_length`. A replacement that read validated recognitions only would stop removing them (observed).

### Callers (observed with `git grep` at the head of this branch)

| Recognizer             | Caller                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parsePointQuery`      | `packages/earth/lib/explorers/Gazette/GazettePage.tsx:110` and `:158`, `packages/earth/lib/explorers/LiveModelVisualizer.tsx:99`, `packages/earth/lib/runtime/use/geocoder-runtime.ts:546`, `packages/earth/lib/runtime/use/remote-geocoder-runtime.ts:146`. `packages/earth/lib/runtime/point/place.ts:106` to `:125` reads the `PointQuery` they return. |
| `isFullPlusCode`       | `packages/spatial/lib/point-query.ts:241`, `packages/spatial/lib/open-location-code.ts:42` (`decodePlusCode`), `packages/mailwoman/lib/plus-code-override.ts:75`                                                                                                                                                                                           |
| `isShortPlusCode`      | `packages/spatial/lib/point-query.ts:243`, `packages/spatial/lib/open-location-code.ts:142` (`recoverNearestPlusCode`)                                                                                                                                                                                                                                     |
| `getLatLngFromDIGIPIN` | None outside `packages/spatial/lib/digipin.ts` and its test (observed, and the package root doesn't export the module)                                                                                                                                                                                                                                     |
| `PLUS_CODE_TOKEN`      | `packages/mailwoman/lib/plus-code-override.ts:46`, in `applyPlusCodeOverride`, which `packages/mailwoman/lib/geocode/core.ts:830` calls                                                                                                                                                                                                                    |

## 4. Decision 8: where the condition holds

The condition is "`recognize` accepts every input the spatial recognizer accepts, with the same parsed values".

| Recognizer             | Holds on the report's inputs                                                                                                                                      | What would have to change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parsePointQuery`      | No: 32 of 48,763 inputs, in three classes                                                                                                                         | The third-number drop, the non-WGS84 `crs` and the case folds are defects of the spatial code, and the first is the Phase 4 finding. Either the operator accepts that a deleted `parsePointQuery` stops returning a point for those inputs, or `parsePointQuery` is corrected first and the report is rerun. A `recognize` grammar that accepted them would be looser than RFC 5870. Every caller must also pass `text.trim()`, as the report states, and sees the 102 bare-fraction inputs as new points. |
| `isFullPlusCode`       | Yes: 792 equal, 0 only spatial                                                                                                                                    | No change. The grammar has the regular expression's alphabet and counts, so the agreement is inferred to hold on every input. A caller reads `full` from `plus_code.token` and passes the text as given, because the function doesn't trim.                                                                                                                                                                                                                                                                |
| `isShortPlusCode`      | Yes: 1,673 equal, 0 only spatial                                                                                                                                  | No change, on the same reading. The validator's count test rejects an odd count before the separator, which is the even-prefix rule.                                                                                                                                                                                                                                                                                                                                                                       |
| `getLatLngFromDIGIPIN` | Yes: 818 equal, 0 only spatial, with equal cells                                                                                                                  | No change for recognition. The decoder stays in `@mailwoman/spatial`, because it decodes and doesn't recognize. It has no caller, so no caller needs repointing.                                                                                                                                                                                                                                                                                                                                           |
| `PLUS_CODE_TOKEN`      | Yes as acceptance of a token span: 8,339 equal, 0 only spatial. No if the replacement reads validated recognitions only: 2,198 of the equal readings are rejected | `applyPlusCodeOverride` must read `plus_code.token` candidates, validated or rejected, to keep removing the 3, 5 and 7 digit tokens, or the operator decides that it stops removing them. The 1,127 punctuation-neighbor tokens are new matches, and the override's behavior on them is a model-behavior question for the caller's evaluation.                                                                                                                                                             |

Three recognizers meet the condition on the report's inputs, and `PLUS_CODE_TOKEN` meets it with the caller's reading stated. `parsePointQuery` fails it, and its three classes are the only failures (observed on 48,763 inputs, and unproven for inputs the generator didn't reach).

## 5. Size and speed

### The engine binary (observed, `node packages/recognize/tools/build-wasm.run.ts --check`)

| Build                                                                        | Bytes   |
| ---------------------------------------------------------------------------- | ------- |
| `main`                                                                       | 404,269 |
| This branch                                                                  | 479,693 |
| This branch with `float_roundtrip` on `serde_json` (not kept)                | 523,309 |
| This branch with the GeoJSON parse stubbed out                               | 463,168 |
| This branch with the GeoJSON parse and the `AnglePair` validator stubbed out | 449,635 |

The binary grows by 75,424 bytes. The GeoJSON parse is 16,525 bytes, the `AnglePair` validator with its angle program and the splitters is 13,533 bytes, and the remaining 45,366 bytes are the other validators, the payload serialization of 12 more payload types, and the declarations of 20 more shapes (each number is the difference between two builds, one of them with the function body removed).
The ABI version and the artifact schema version are unchanged, because no export's signature and no artifact layout changed.

### Artifacts (observed)

| Artifact                              | `main`               | This branch          | Backends                                             |
| ------------------------------------- | -------------------- | -------------------- | ---------------------------------------------------- |
| `coordinates.rca1`                    | 41,304               | 116,088              | whole sparse 44,215, embedded sparse 25,109          |
| `identifiers.rca1`                    | not present          | 54,216               | whole sparse 7,133, embedded dense 27,496            |
| `spatial.rca1`                        | not present          | 35,408               | whole sparse 20,302, embedded dense 8,944            |
| `primitives.rca1`, `structure.rca1`   | 10,440 and 94,512    | unchanged            | dense                                                |
| `postal.rca1`, `postcode_legacy.rca1` | 1,873,640 and 35,432 | 1,873,640 and 35,432 | postal regenerated with the new overlap declarations |

The default dense budget of the compiler is now 100,000 bytes (it was 2 MiB). The `coordinates` whole-input automaton has 780 states and is 44,215 bytes sparse, and a build of an intermediate grammar with 568 states was 292,128 bytes dense. A dense state holds a transition for every byte class. The family has more than 64 classes, so each state costs 512 bytes. The `structure` partitions that the speed requirement measures stay dense. The postal family passes its own budget. The loader's truncation and mutation tests load an artifact once for each byte, and they ran for more than 14 minutes on the dense `coordinates` artifact of 1,113,176 bytes of the first build, so they now read the `primitives` artifact, which has the same layout.
The TypeScript hexadecimal modules grow with the artifacts: `lib/embedded.generated.ts` 809,242 to 960,090 bytes, `lib/artifacts/coordinates.generated.ts` 83,274 to 232,843 bytes, and two new modules of 109,098 and 71,470 bytes.

### Speed (observed, `node packages/postcode/tools/bench.run.ts`, load average 1.7 before and 1.1 after, without a CI run in progress)

| Input                                                      | `computeQueryShape` (µs) | `structure`, legacy, `primitives`, `coordinates` (µs) | With `spatial` and `identifiers` (µs) |
| ---------------------------------------------------------- | ------------------------ | ----------------------------------------------------- | ------------------------------------- |
| `68161`                                                    | 2.36                     | 1.19                                                  | 3.91                                  |
| `SW1A 1AA`                                                 | 5.64                     | 1.53                                                  | 3.42                                  |
| `350 5th Ave, New York, NY 10118`                          | 15.20                    | 6.40                                                  | 4.86                                  |
| `〒100-0001 東京都千代田区千代田1-1`                       | 9.41                     | 5.14                                                  | 5.92                                  |
| `金龍酒家, 12 Gerrard Street, London WC2H 7JS`             | 20.18                    | 9.17                                                  | 6.78                                  |
| `1600 Pennsylvania Avenue NW, Washington, ...` (300 units) | 109.48                   | 27.97                                                 | 33.95                                 |
| `1111111111...` (300 units)                                | 87.75                    | 20.83                                                 | 22.61                                 |
| `漢漢漢漢漢漢...` (300 units)                              | 70.49                    | 17.51                                                 | 20.97                                 |

The composition that replaces `query-shape` stays below `computeQueryShape` on all eight inputs with the larger `coordinates` family, and so does the composition with the two new families (observed). The columns come from one process in one run.

## 6. Decisions the issue left open

- **One shape for plus codes (decided).** `plus_code.token` reads 2 to 8 digits before the separator and the validator sorts them into full, short and rejected, so one grammar answers `isFullPlusCode`, `isShortPlusCode` and `PLUS_CODE_TOKEN`.
- **Grammars as filters (decided).** A capture can be made once in a grammar, and a pair with a mark on one side or the other needs each capture in two places, so the exact grammar of an angle cannot carry captures in the shapes. The shapes compile a looser filter that requires a mark or a hemisphere letter in each pair, so no overlap with a decimal pair arises, and the validator reads the span with the capture walk over the exact grammar, which is never compiled. A span the filter accepts and the validator refuses is a typed rejection (`malformed_angle`, `no_coordinate_mark`, `unsplittable_pair`). The first build of the exact grammar gave a whole-input automaton of 1,243 states and an embedded one of 803, and the filter gave 822 and 450 (both dense, both with the full white space set). The sparse backend then shrank the artifact more than the filter did.
- **No leading white space in an embedded shape (decided).** An embedded search keeps the earliest start of a match, and a start on white space before the digits would make the neighbor check refuse a match that a later start satisfies. The angle filter lets white space follow a sign and never lead.
- **GeoJSON lives in `spatial`, not `identifiers` (decided).** A GeoJSON text stands for a place, and an identifier is a name for one. The family's input limit then covers it.
- **Dense budget (decided).** See section 5.
- **The IR schema (decided).** `definitions/ir.schema.json` gains the optional `role`, `order` and `boundary` properties that the IR writer already emitted for definitions, because a repository family now declares a boundary. The IR version is unchanged.
- **Unknown.** Whether H3 validation past the 15 digit format (the base cell range and the unused digits) should reject. The shape reads only the format, as `parsePointQuery` does.
