# recognize: the postal generation of the query shape

This record covers issue 3102, the inference-side change of issue 3064. The base is `origin/main` at `232f4a3864`.
Each claim is marked **observed** (a command printed it), **inferred** or **decided**.
The scratch scripts that took the measurements aren't committed, and the commands are quoted where a reader needs them.

## What changed

A model card selects the generation of the query-shape rules with `requires.query_shape`.
The value `"legacy"`, or no value, keeps today's answers. The value `"postal"` selects the new ones. Any other value makes `readRequiredChannels` throw.
`NeuralAddressClassifier.queryShapeGeneration` reports the value, `computeQueryShape(input, generation)` takes it, and a `postal` shape records it in `generation`.
A `legacy` shape stays as the engine returned it, with no `generation` field, so its bytes equal the original classifier's (decided).

The `postal` generation changes three things (observed from the code):

- `knownFormats` holds a postcode hit for each candidate of the postal family and a PO box hit for each box. A postcode hit lists the accepting countries as a `CountrySet`, the form, the locale of the most populous accepting country, and a confidence derived from the country count.
- Token classes and scripts come from `codePointScript` in `@mailwoman/registry`, which reads the Unicode Script property of the runtime for every script the registry holds.
- The eleven behaviors of the legacy classifier that looked accidental are specified.

## Consumers (observed)

`computeQueryShape(` has 27 non-test call expressions in 21 files, and 1 of them is the stage the pipeline injects.

| Side                                                    | Consumers                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow the card                                         | the runtime pipeline stage (`mailwoman/lib/runtime-pipeline.ts`), the browser classify stage, the geocode core (3 calls), `intent-refusal`, `span-script`, the script router (3), `pair-index`, `api-engine` and `docker/server.ts` through `deriveGeocodeRegister` |
| Follow the shape they receive                           | the kind classifier (its inner call passes `shape.generation`), the locale hint, the decoder prior, postcode repair and the phrase grouper                                                                                                                          |
| Postal for every model, because they hold no model card | `detectedAsPostcode` in the bare-postcode recipe, `hierarchyScript` in the WOF adapter (through `textScript`), and `postcode-format.ts`                                                                                                                             |
| Legacy, outside the card's reach                        | 10 tools and evaluation scripts that pin model 10.8.0's behavior, `geocode/result.ts` (it reads segments, and both generations return the same segments), and `usePOISearch` (a browser hook with no card)                                                          |

## The confidence rule (decided, then measured)

`postal/confidence.ts` states the rule in one place.
`confidence = 0.95 - 0.45 * ln(n) / ln(181)`, minus 0.05 for a bare run of digits, hyphens and white space.
`n` is the number of countries that accept the form, and 181 is the size of the family.
The three constants are round numbers that no failing row fitted: 0.95 is the highest legacy value, 0.5 is the legacy locale hint's value for an ambiguous five-digit run, and 0.05 is the step of the legacy table.

The form of a hit comes from what the span holds: `designated` for a printed prefix, `alnum` for a span with a letter, and `numeric` otherwise.

| Form                                   | Input        | Legacy    | Postal                    |
| -------------------------------------- | ------------ | --------- | ------------------------- |
| `us_zip4`                              | `12345-6789` | 0.95      | 0.90 (n=1, numeric)       |
| `ca_postcode`                          | `K1A0B1`     | 0.95      | 0.95 (n=1)                |
| `ca_postcode`, two tokens              | `K1A 0B1`    | 0.90      | 0.95 (n=1)                |
| `jp_postcode` with the prefix          | `〒100-0001` | 0.95      | 0.95 (designated, n=1)    |
| `jp_postcode` bare                     | `100-0001`   | 0.95      | 0.84 (numeric, n=2)       |
| `uk_postcode`                          | `SW1A1AA`    | 0.90      | 0.89 (n=2)                |
| `uk_postcode`, two tokens              | `SW1A 1AA`   | 0.90      | 0.95 (n=1)                |
| `nl_postcode`                          | `1012AB`     | 0.90      | 0.95 (n=1)                |
| `nl_postcode`, two tokens              | `1012 AB`    | 0.90      | 0.95 (n=1)                |
| `us_zip`, `fr_postcode`, `de_postcode` | `68161`      | 0.60 each | 0.55 once (numeric, n=56) |
| `cz`, `sk`, `se`, `gr`                 | `123 45`     | 0.60 each | 0.78 once (numeric, n=4)  |
| `po_box`                               | `PO Box 5`   | 0.85      | 0.85                      |

Three filters keep ordinary text from standing as a postcode.
They came from the first row-level measurement, where this change's own code caused the loss: a hit for `Qld 4069`, `LOT 19` and a house number of four digits, each at 0.58 to 0.95.
A bare run of fewer than five digits is no hit, a word of letters followed by a number is no hit, and a candidate with a separate word of three letters or more is no hit.
A printed hit absorbs the bare hit on the same code.
The `123 45` row shows a limit of the rule: it scores above the five-digit run because fewer countries write it, and a house number plus a two-digit number reads as a code (inferred).

## Scripts

`codePointScript(codePoint)` returns the ISO 15924 code of the Script property, from the runtime's `\p{Script=…}` classes. It adds no byte to a bundle.
The Unicode version is the runtime's, so a Worker, a browser and Node can differ on a code point that a later version assigned (observed from the design, pinned by `unicode-script.test.ts` for 35 code points).

The rule for Common and Inherited follows UAX #24, section 5 (decided):

- A Common code point counts toward no script.
- An Inherited code point takes the script of the code point before it in the token and counts toward that script. At the start of a token, or after a Common code point, it counts toward none.
- A default-ignorable code point is no part of a token's text. A token starts after the ones that lead it and ends before the ones that trail it.
- A tie goes to the earlier first code point, then to the longer run, then to the earlier code. One comparator ranks the scripts of a token and of a text.

Over the 87,556 inputs of the comparison set, the legacy classifier reported `Zzzz` for 3,079 inputs. The `postal` generation reports 27 scripts that the legacy ten omit, in 2,650 inputs: Grek 579, Deva 355, Hebr 263, Armn 221, Geor 186, Thai 177, Beng 130, Taml 95, Sinh 83, Gujr 73, Telu 65, Mlym 58, Tibt 55, Knda 39, Guru 37, Mymr 34, Laoo 28, Orya 26, Goth 26, Syrc 21, Cans 20, Khmr 19, Olck 18, Ethi 17, Thaa 15, Cher 9 and Tfng 1 (observed).

## The eleven behaviors

Each row is tested in `query-shape.postal.test.ts`, under the `postal` generation only.

| #   | Legacy                                                                                     | Postal                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Greek, and every script outside the ten, was `alphanumeric` with the script `Zzzz`         | `alpha`, with its own script                                                                                                                       |
| 2   | `123-4567` was `jp_postcode` at 0.95                                                       | a numeric form that 2 countries accept, at 0.84. The prefix `〒` is the designated form at 0.95                                                    |
| 3   | `Box 1012, LG` joined a comma into a two-token `nl_postcode`                               | the postal family reads whole-text candidates, and no candidate crosses a comma                                                                    |
| 4   | a zero-width space became part of a token, set its script to `Zzzz` and blocked a postcode | it is default-ignorable. The token starts after it, and offsets stay in the original text                                                          |
| 5   | fullwidth Latin letters were class `cjk`                                                   | Latin script, class `alpha`                                                                                                                        |
| 6   | only the first PO box was reported                                                         | every PO box is                                                                                                                                    |
| 7   | the token tie went to the first script seen and the text tie to the code                   | one order: earlier start, longer run, code                                                                                                         |
| 8   | any two upper-case letters in a later segment were a region abbreviation                   | an upper-case code that the codex holds as a subdivision code (US 56, CA 13, AU 8 and GB 4 codes, 79 distinct), in any segment, with its countries |
| 9   | a hit shared the token's span object                                                       | already fresh in both generations, since the swap's reader builds each span. The test pins it                                                      |
| 10  | `segment(text, locale)` ignored `locale`, and two separator values had no writer           | already absent from the swap's types. This change deletes the last of it, the `locale` option of the pipeline's stage                              |
| 11  | a region abbreviation's `span` was a string                                                | `{ start, end, body }`                                                                                                                             |

Rows 9 and 10 were fixed by the swap in both generations, so the tests state the current answer (observed).

The per-country distribution that the rule for row 8 accepts is the codex's four tables. The codex holds no subdivision code for any other country, so a region abbreviation outside those four is no longer reported (inferred).

## Legacy pieces to delete when the next model ships

Each piece has a `LEGACY-QUERY-SHAPE` marker in its header.

- `packages/postcode/lib/recognizer/legacy.ts`, its generated artifact and declarations, and `legacy-formats/table.ts`.
- The `legacy` branch of `computeQueryShape`, the `legacy` value of `QueryShapeGeneration`, and the generation parameter of every caller in the consumer table.
- The hand-written ranges of `packages/recognizer/lib/charset.ts` and the `charset.rs` script tables that the `structure` pass reads for a token's script and class.
- `packages/postcode/lib/frozen-shapes.ts` with `frozen-shapes.json`, the one reader that remains being the postcode repair of a card that declares a span mode other than `postal`.

## Parses with the published weights (observed)

Two worktrees ran one scratch script. One is `origin/main` at `232f4a3864` and the other is this branch. The script builds the pipeline the CLI's default `parse` path builds (`NeuralAddressClassifier.loadRoutedFromWeights({ locale: "en-US" })`, `createRuntimePipeline` with `fst: "auto"`, `streetEvidence: "auto"` and `poiQueryKind: "extract"`) and parses each input with locale `en-US`. It writes the SHA-256 of the whole result with its timing left out. Both load the weights of the data-root overlay `/mnt/mw/weights/en-us`.

The inputs are every distinct `input` under `gauntlet/cases/<cc>/` and every distinct `raw` of `heldout-dev-v0.8.18.v2.rows.jsonl`.

| Inputs compared | Identical | Inputs that differ |
| --------------: | --------: | -----------------: |
|          87,556 |    87,556 |                  0 |

A third run on the branch, with the weights root's card unchanged and symlinked, matched the first on 86,804 inputs and differed on 752. Those 752 come from the scratch weights root and not from the code, so the row-level comparison below pairs two runs on scratch roots (observed, cause inferred).

## The postal selection, row by row (observed)

The scratch weights root `en-us` holds a symlink to every file of `/mnt/mw/weights/en-us` except a copy of `model-card.json` that adds `requires.query_shape: "postal"`. The data root and the published card stay unedited.
The legacy arm uses the same root with the unchanged card. Each arm parsed the 87,556 inputs and wrote the components, the kind, the locale and the path.

| Count                    |   Rows |
| ------------------------ | -----: |
| Compared                 | 87,556 |
| Identical                | 84,961 |
| Differ                   |  2,595 |
| Differ in the components |     10 |
| Differ in the kind       |  1,856 |
| Differ in the path       |    731 |
| Differ in the locale     |      0 |

By change, one row can sit in several (the classes come from comparing the two shapes of the input):

| Change                            |  Rows |                                            Countries |
| --------------------------------- | ----: | ---------------------------------------------------: |
| script coverage                   | 1,553 |       191 (GR 41, AM 38, PR 36, CY 32, MT 30, HN 26) |
| fixed class of a non-Latin letter | 1,552 |                                         the same 191 |
| zero-width space                  |    27 |                          13 (AD 5, BW 3, LK 3, SS 3) |
| postal hits                       |   310 | 23 (PT 90, CH 42, IN 42, HR 38, AX 24, PL 16, LU 14) |
| region abbreviation               |    28 |                          7 (PT 15, CH 4, NO 4, AR 2) |
| hit confidence only               |   731 |                                           1 (JP 731) |

What moved (observed):

- **The kind of 1,856 rows.** 1,716 moved from `structured_address` to `locality_only`, 67 from `landmark` to `locality_only`, 46 from `structured_address` to `vague`, 21 from `structured_address` to `landmark`. A non-Latin name reads as `alpha` now, so the kind classifier takes it for a locality. 283 more rows moved because a printed form (`CH-9524`, `AX-22820`) is a postcode hit now, and the text without it is a locality.
- **The path of 731 Japanese rows.** The pipeline's normalizer drops the postal mark, so `〒819-1100` reaches the shape as `819-1100`. The legacy generation read that as `jp_postcode` at 0.95, so the fast path answered. The postal generation scores it 0.84 for the two countries that accept it, so the kind's confidence is 0.94 and the full pipeline runs. Both paths return the same postcode component, at confidence 0.91 where the fast path gave 0.95.
- **The components of 10 rows.** Four Czech rows lost three duplicate `postcode` nodes each. `ΆΠΟΣΚΕΠ, WEST MACEDONIA` read the second part as a region, where it was a country. Three rows that end in `SANTA FE` read `Santa FE` as a region, where `FE` had been a region abbreviation. A Hong Kong row read `Street2` as a suffix. A Romanian row, `(CF nr. 104013)`, gained a second postcode, `104013`.
- **The gauntlet.** 1,225 cases have expected components (127 have none and are skipped), and a case passes when each expected component appears in the parse's tuples. 578 pass under both arms and 647 fail under both. No case passes under the legacy arm and fails under the postal arm, and no case passes under the postal arm and fails under the legacy arm.

Against the held-out gold spans, of the 2,595 rows that differ, 2,595 hold gold. 5 rows gained a gold component (2 in each of `script-coverage`, `accident:class` and `accident:region-abbreviation`, 1 other) and 0 lost one (observed).

The Romanian `104013` is a loss of the kind this rule makes: a six-digit run that few countries accept scores high (inferred from the rule, observed on that row).
The confidence rule counts countries and can't tell a company number from a code, so it caused that loss.
The published weights trained beside the legacy prior. Of the 1,856 kind changes, all but 10 land on rows whose components stayed the same, so these rows give no evidence that the new inputs hurt the weights (observed).

Ten examples of each change, with their countries, are in the scratch report that this record's numbers come from. The pull request lists the first ten.

## Corpus effect, measured and not applied (observed)

The corpus `v0.8.19-retention-overlay` stays as built, and the measurement wrote no file under the data root.

- `detectedAsPostcode` over the rendered surfaces of the bare-postcode recipe's source rows: CZ 5,338, SK 2,118 and NL 100,000 surfaces, from the OpenAddresses `countrywide.csv` files that `currentSourcePath("openaddresses", "extracted")` names. 0 answers change. The Czech and Slovak files hold fewer distinct postcodes than 100,000.
- `hierarchyScript` over 150,000 localities with their region and country names from `admin-global-priority.db`, a random draw by id. 0 answers change. 60 locality names change from `Zzzz` to `Grek`, and neither script is a CJK script.

One reserved evaluation input changes. `detectedAsPostcode("3511 SA")` is true under the legacy table and false under the postal family. The family states that the Netherlands issues no code that ends in `SA`, `SD` or `SS`. The recipe renders source postcodes, and none of the 100,000 Dutch surfaces ends in one of the three. The recipe's test pins the exception.

The next corpus build's delta from these two functions is zero on these samples (inferred for the build, since the samples are draws).

## Speed and size (observed)

Per call of `computeQueryShape`, in microseconds, on the eight inputs of `packages/postcode/tools/bench.run.ts`, one process, 30,000 calls after 5,000 warm-up calls, at a load average near 1.3 on a Ryzen 9 8945HS.
The loop repeats one input, so the recognizer's same-text staging flatters every figure, and the legacy column is the faster of the two for that reason.

| Input                                          | origin/main | legacy here | postal here |
| ---------------------------------------------- | ----------: | ----------: | ----------: |
| `68161`                                        |        0.54 |        0.55 |       13.38 |
| `SW1A 1AA`                                     |        0.65 |        0.78 |        4.02 |
| `350 5th Ave, New York, NY 10118`              |        1.38 |        1.39 |       30.95 |
| `〒100-0001 東京都千代田区千代田1-1`           |        1.24 |        2.10 |       11.00 |
| `金龍酒家, 12 Gerrard Street, London WC2H 7JS` |        1.75 |        1.90 |        9.58 |
| the White House address, four times            |        7.04 |        7.75 |      119.88 |
| 300 digits                                     |        3.17 |        3.20 |      214.85 |
| 300 ideographs                                 |        9.72 |       10.18 |       42.29 |

Through the full pipeline, 87,556 parses took 598 s on `origin/main` and 587 s with the legacy arm, and 593 s with the postal arm (6.83, 6.71 and 6.77 ms per input), at load averages near 2. The query shape is 0.3% of a parse.

| Artifact                                                     |                      origin/main |                                this branch |
| ------------------------------------------------------------ | -------------------------------: | -----------------------------------------: |
| earth entry chunk (`index-*.js`)                             |                  2,079,563 bytes | 2,076,011 bytes (21,141 bytes under 2 MiB) |
| docs site, `yarn workspace @mailwoman/docs build`: all files |                 51,235,321 bytes |                           51,235,213 bytes |
| docs site: JavaScript, 291 files                             |                  8,173,716 bytes |                            8,173,609 bytes |
| engine Worker upload (`wrangler deploy --dry-run`)           | 18,193.29 KiB, gzip 4,480.07 KiB |           18,233.26 KiB, gzip 4,489.18 KiB |

The script data is the runtime's, so the `structure` artifact (94,512 bytes) and the engine binary are unchanged and the earth chunk shrank. The chunk is smaller because `postcode-format.ts` no longer imports the frozen table (inferred).

## Decisions the issue left open

- The card field is `requires.query_shape` (decided by the coordinator).
- The legacy shape holds no `generation` field, so the published-weights comparison holds at 0 differences without a field to ignore.
- A bare run of fewer than five digits, a word followed by a number and a candidate with a separate word of three letters are no postcode hit. The first row-level run showed the cause in this change's confidence rule.
- Region abbreviations come from the codex's four subdivision tables, with no table added for another country.
- `locale-hint` reads the locale of a postal hit from the hit, so it adds no dependency.
- PO boxes live in `@mailwoman/recognize` as a reader of the structure tokens, and no Rust family changed, so the engine binary, the artifacts and the ABI are unchanged.
