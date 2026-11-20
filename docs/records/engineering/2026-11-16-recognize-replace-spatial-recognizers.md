# recognize: replacing the spatial text recognizers

This record is step 2 of the order in the 2026-11-16 "Direction change" comment on issue 3064, for the spatial recognizers. Issue 3096 tracks the work.
`@mailwoman/recognize` becomes the only reader of the coordinate, plus code, DIGIPIN, H3, geohash, Who's On First, Census GEOID, GNIS and GeoJSON texts. `parsePointQuery`, `isFullPlusCode`, `isShortPlusCode`, the DIGIPIN text validation and `PLUS_CODE_TOKEN` are deleted.
The base is `origin/main` at `8e2a74b6cb`.
Each claim is marked **observed** (a command printed it), **inferred** or **decided**.

## The final differential before the deletion (observed)

`packages/mailwoman/tools/dev-tools/recognizer/point-differential.run.ts` ran on the current tree before it was deleted. It compared 48,763 distinct inputs. The committed report matched the code's output (`--check` exited 0) before the DMS fix in `AnglePair`, with these counts:

| Old reader             | Equal | Only the old code | Only `recognize` | Different values |
| ---------------------- | ----- | ----------------- | ---------------- | ---------------- |
| `parsePointQuery`      | 6,638 | 32                | 102              | 0                |
| `isFullPlusCode`       | 792   | 0                 | 0                | 0                |
| `isShortPlusCode`      | 1,673 | 0                 | 0                | 0                |
| `getLatLngFromDIGIPIN` | 818   | 0                 | 0                | 0                |
| `PLUS_CODE_TOKEN`      | 8,339 | 0                 | 1,127            | 0                |

After the DMS fix the same run counted 6,637 equal and 1 different value for `parsePointQuery`: `12°30′20S, 5E`, the one input the fix targets. The other counts didn't move. The tool and its report are deleted.

## What was kept (decided)

`packages/spatial/data/fixtures/point-query-frozen.fixture.json` holds 627 cases drawn from those inputs, each a trimmed text and the reading `pointFromText` returns, or `null`. It follows the pattern of `query-shape-frozen.fixture.json`: the legacy parser's results are the recorded oracle, and the new function is tested against them.

| Category                              | Cases | Meaning                                                                                       |
| ------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `agreed:*`                            | 360   | both readers returned the same value: 60 for each of six kinds, spread over the sorted inputs |
| `legacy_only`                         | 28    | `parsePointQuery` returned a point and the specification refuses the text                     |
| `recognize_only`                      | 88    | `parsePointQuery` returned `null` and the specification reads a point                         |
| `hemisphere_after_complete_dms_group` | 1     | the DMS defect                                                                                |
| `neither`                             | 150   | no reader returned a point, drawn evenly from 36,358                                          |

The `legacy_only` and `recognize_only` counts are lower than the report's 32 and 102 because the fixture keeps each trimmed text once and the report counted padded variants.
The old recognizers' parameter checks are deleted with their tests. Their cases are in the fixture, or in the recognizer's own tests.

## Where the point reader lives (decided)

`packages/spatial/lib/point/reading.ts`. `@mailwoman/spatial` already depends on `@mailwoman/postcode`, which depends on `@mailwoman/recognize`, so the new direct edge adds no path.

```text
spatial   -> core, postcode, recognize (new, direct)
postcode  -> recognize
recognize -> core, registry
```

The cycle check was a walk over the `dependencies`, `peerDependencies` and `optionalDependencies` of every `packages/*/package.json`: `recognize`, `registry` and `core` do not reach `spatial` (observed). `packages/spatial/tsconfig.json` references `../recognize`, and `yarn compile` builds it.

## Behavior changes

Each class lists the old result, the new result and the specification that decides it.

| Class                                          | Example                                               | Old result                                | New result                                            | Specification                                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A third number after the second separator      | `1,2,3`                                               | the point 1, 2                            | no point                                              | A coordinate pair has two numbers. The old parser dropped what followed a second separator.                                                                                 |
| A `geo:` URI that RFC 5870 refuses (23 inputs) | `geo:48.8584,2.2945;crs=Moon-2011`, `geo:1,2,35;u=-1` | a point                                   | no point                                              | RFC 5870 section 3.3: the reference system is WGS84, and the uncertainty isn't negative.                                                                                    |
| The long s folded to `s` (2 inputs)            | `httpſ://spelunker.whosonfirst.org/id/1`              | the Who's On First id 1                   | no point                                              | The scheme and the prefix are ASCII letters. The old `iu` flags folded U+017F to `s`.                                                                                       |
| A bare fraction (102 inputs)                   | `.5, .25`                                             | no point                                  | the point 0.5, 0.25                                   | A decimal number may omit the integer digits.                                                                                                                               |
| A plus code beside punctuation (1,127 inputs)  | `(VFQ6+92P) Managua, Nicaragua`                       | the code is read as a place name and left | the code replaces the coordinate and leaves the parse | The Open Location Code specification bounds a code by any character outside its alphabet.                                                                                   |
| A capital S after a complete DMS group         | `12°30′20S, 5E`                                       | latitude 12.5056 north                    | latitude -12.5056, longitude 5                        | A hemisphere letter after degrees, minutes and seconds is a hemisphere.                                                                                                     |
| A hyphenated DIGIPIN with a letter             | `39J-49L-L8T4`                                        | an address                                | the DIGIPIN point of its cell                         | India Post's display form. `isDeterministicSpatial` trusts it.                                                                                                              |
| A hyphenated DIGIPIN of only digits            | `234-567-8923`                                        | an address                                | no point, reason `digit_group`                        | The digits 2 to 9 in the form 3-3-4 are also a North American phone number. The rule is in `isDeterministicSpatial`, and India Post's document defines no prefix or marker. |
| A GeoJSON `Point`                              | `{"type":"Point","coordinates":[2.2945,48.8584]}`     | an address                                | the point 48.8584, 2.2945                             | RFC 7946 section 3.1.2 puts longitude first. The validator returns latitude first.                                                                                          |

## The point reader's handler map (decided)

`recognizePointQuery` runs one recognizer over the `coordinates`, `spatial` and `identifiers` families. A recognition becomes a reading only when the validator accepted it and its span is the whole text. An embedded or rejected recognition never does, so `Apt 4, 12 Main St` and `geo:48.8584,2.2945;crs=Moon-2011` read as no point.
The caller trims, because the grammars admit no outer white space. The earth app trims where it takes the typed input.

The handler object is checked with `satisfies HandlerMap<typeof families>`, so a kind added to any family fails the build until it has a handler. A type-level test in `point/reading.test.ts` keeps one kind out of a map and expects the compiler to refuse it.

| Kind                                                                                                                              | Result                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `coordinate.decimal_pair`, `.decimal_pair_spaced`, `.dms_pair`, `.dms_pair_spaced`, `.labeled_pair`, `.maps_segment`              | a `coordinates` point with the payload's order                                                  |
| `coordinate.geo_uri`                                                                                                              | a `coordinates` point, order `lat_lon` (RFC 5870 fixes it)                                      |
| `plus_code.token`                                                                                                                 | a `plus_code` point with the branded code and its full flag                                     |
| `digipin.display`                                                                                                                 | a `digipin` point when it holds a letter, otherwise not a point query with reason `digit_group` |
| `digipin.compact`                                                                                                                 | not a point query, reason `ambiguous_without_prefix` (ten characters are also a phone number)   |
| `geojson.object`                                                                                                                  | a `geojson_point` for a `Point`, otherwise not a point query with reason `names_no_position`    |
| `census.geoid_block`, `.geoid_block_group`, `.geoid_county`, `.geoid_state`, `.geoid_tract`, `gnis.reference`, `gnis.summary_url` | not a point query, reason `names_no_position`                                                   |
| `geohash.prefixed`, `h3.cell`, `h3.prefixed_cell`, `wof.reference`, `wof.spelunker_url`                                           | a `geohash`, `h3` or `wof` point                                                                |

A bare H3 cell is a point here although `isDeterministicIdentifier` withholds it from an address parse. The earth map's copy menu writes a bare cell, and the search field reads back what the map copied (**decided**).
When a Census GEOID and an H3 cell cover one text, the point wins.

## The plus code brands (decided)

The `PlusCode` validator's payload holds one of two optional fields, `full_code` as `Validated.FullPlusCode` and `short_code` as `Validated.ShortPlusCode`. `decodePlusCode` takes the full brand and returns a cell, `recoverNearestPlusCode` takes the short brand and returns a cell, and `encodePlusCode` returns the full brand. A validated value can't make either decoder fail, so neither returns `null`. The one error is in the handlers: a validated payload with neither field is an engine defect and throws a `RangeError`.
The change moved the `spatial` artifact and the engine binary from 480,220 to 480,173 bytes.

## The geocode comparison (observed)

`applyPlusCodeOverride` runs at the end of every geocode, so the comparison ran the compiled command-line tool. The weights, the data root and the inputs were the same on both sides: `geocode --stdin --json`, one warm session, en-US, with the weights `doctor` reports and the data under `/mnt/mw`.
The baseline run used one checkout compiled at `8e2a74b6cb`, before any change to a file the geocode path reads. The second run used the same checkout after the change and a second compile. The two checkouts are one directory because the tool imports workspace libraries from their sources, and it doesn't read the spatial artifact or the engine binary that changed first.
It compared **2,392 inputs**: the 1,339 distinct inputs of every gauntlet case under the two-letter country directories, the override test's one input, and 1,053 generated inputs with plus codes leading, trailing, in parentheses, in quotes, followed by a period, between semicolons and hyphens, repeated, and with 2, 4, 6, 8 digits and with 3, 5 and 7 digits before the separator.

**2,106 results are identical** byte for byte, and **286 differ**. The full list with both results is `2026-11-16-recognize-replace-spatial-recognizers-geocode-differences.json` beside this record.

A script classified every input by the first plus-code token the old pattern found and the first one the recognizer finds. The classes were 1,329 inputs with no token in either reading, 660 with the same token and 403 with a token only the recognizer finds. All 1,329 and all 660 results are identical. That covers every gauntlet input and every token with an odd digit count, so the override still removes those tokens. Of the 403 inputs with a token only the recognizer finds, 286 differ and 117 don't, because the old result already matched the new one. No differing input has another cause, so **0 differences fall outside the listed behavior change**.

Examples:

| Input                             | Old result                                 | New result                                                           |
| --------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `(VFQ6+92P) Managua, Nicaragua`   | 12.7933, -85.0395, tier `admin`            | 12.8885, -84.5399, tier `plus_code`, uncertainty 2 m                 |
| `Managua, Nicaragua, (VFQ6+92P),` | country component `VFQ6+92P`, tier `admin` | 11.8885, -86.5399, tier `plus_code`, the code no longer in `country` |
| `Managua, Nicaragua VFQ6+92P.`    | tier `admin`                               | tier `plus_code`                                                     |

A short code recovers against the locality the parse resolved, so the same code gives different cells beside different localities. That behavior is the old one and this change leaves it.

## The earth app (observed)

The earth build reads the compiled `out/`. The point reader imports the engine and the three artifacts, 414.83 kB before gzip and 32.31 kB gzipped as their own chunk.
The first build with a static import raised the entry chunk from 2,089.60 kB to 2,503.10 kB, and `vite build` failed in the service worker step: the precache refuses a file over 2 MiB, and the entry sat 7 kB under it. The earth app now imports the reader on first use, the way it imports the H3 reader, in `packages/earth/lib/runtime/point/point-reader.ts`.

| Build output                           | `origin/main`            | This branch                                |
| -------------------------------------- | ------------------------ | ------------------------------------------ |
| entry chunk `index-*.js`               | 2,089.60 kB              | 2,088.73 kB (gzip 592.97 to 592.74)        |
| the chunk that holds the engine binary | 1,232.00 kB              | 970.34 kB and 262.77 kB, total 1,233.11 kB |
| the point reader and three artifacts   | none                     | 414.83 kB (gzip 32.31)                     |
| precache                               | 58 entries, 7,552.11 KiB | 60 entries, 7,957.55 KiB                   |

The earth browser suite ran 46 tests on this branch: 44 passed, 1 was skipped and 1 failed. The failure is `210/national-rooftop.spec.ts`, the Houston case `1502 A Cage Street`, which resolved to 29.7848, -95.3614 where the fixture expects 29.7747, -95.335 within 0.006 degrees. The same test failed on `origin/main` at `a6e4cf318c` with the same coordinates, so the change doesn't cause it. The three tests of `220-point-queries.spec.ts` passed on this branch.

## What was deleted

`packages/spatial/lib/point-query.ts` and its test, `isFullPlusCode`, `isShortPlusCode`, the DIGIPIN text validation with its two `Unsafe` decoders, `PLUS_CODE_TOKEN`, the `PointQuery` type with `POINT_QUERY_LABEL` and `POINT_QUERY_PHRASE`, and the differential tool with its report.
No caller of the two `Unsafe` DIGIPIN decoders existed outside their module and test (observed with a search of the tree), so both are gone and `getLatLngFromDIGIPINInto` is the one buffer decoder.
`parsePointQuery` had five call sites, all in `packages/earth`: `GazettePage.tsx` twice, `LiveModelVisualizer.tsx`, `geocoder-runtime.ts` and `remote-geocoder-runtime.ts`. Four files in `packages/earth` and `packages/react` also call `coordinatePairText`, and they now import it from `@mailwoman/spatial/point/text`.
