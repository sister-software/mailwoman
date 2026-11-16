# recognize: the training encoder reads the postal artifact

This record is step 4 of the order in the 2026-11-16 "Direction change" comment on issue 3064, and issue 3100 tracks it. The training encoder's two postcode finders read the `postal` family through `recognize-core`, serving reads the same family, and `fancy-regex` and the trainer's JSON copies of the postcode patterns are deleted.
The base is `origin/main` at `e2211ef0d0`.
Each claim is marked **observed** (a command printed it), **inferred** or **decided**.

## What the operator changed (decided)

The first brief compiled `shapes.json` into a family and held the encoded tensors byte-identical to the old finders'. A later message from the operator replaced that goal. The postal family becomes the only source of postcode spans for training and serving, the published model keeps its inputs through the model card, and acceptance is agreement between the two sides plus an account of what moved.

## The finder (decided)

- One family, `postal`, with every shape declaring the `alnum` boundary: the engine reports an embedded match only when neither neighbor is an ASCII letter or an ASCII digit. A connector may touch a match, so `54000` stands in `Lahore-54000`. The `token` boundary refused that spelling in at least 84 of the 87 spans the first full comparison lost.
- One case rule: every shape matches either case. The data supports it: 687 anchored spans in the 72,209 rows hold a lower-case letter (`ol15 0bh`), and the old table, matched against the raw text, found none of them.
- Each shape states a `form` in its metadata: `designated` for a printed form, `alnum` for a bare form whose language holds a letter, `numeric` for a bare form of digits.
- Candidates are reduced to their code, ordered longest first, then by earliest start, then by form and shape ID, and listed once per range. A candidate that a connector separates from the rest of a longer candidate is dropped. The anchor painter keeps the first candidate the anchor table resolves among those that overlap.
- A candidate resolves only under a country its shapes belong to. It carries the countries of every shape that matches its range. Its table entry must hold weight on at least one of them, and the painted posterior holds only the weights on them. The existing arithmetic then renormalizes what remains over the locale set, as it does any posterior, and the weights keep their file order. An entry with weight only outside the candidate's countries is skipped, and a skipped candidate hides no other. A GB unit that fails the rule falls back to its outward district under the same rule. `restrictEntry` in `@mailwoman/neural` and `AnchorLookup::resolve` and `features` in `mtf-channels` implement it, and the entry layout expresses it without changing the tensor's meaning.
- The engine gained `Boundary::Alnum` and `Engine::whole_shapes`. The WebAssembly binary was rebuilt with `build-wasm.run.ts`. The C interface didn't change, so the ABI version stays.
- `anchorKey` in `@mailwoman/neural` and `anchor_key` in `mtf-channels` compute the key from the same span: remove each space, upper-case.

## Where the old shape table stays (decided)

Model 10.8.0's card declares `span_mode: "shaped"`, and the postcode repair pass reads the same table. A default-on model change needs a release verdict, so `packages/postcode/lib/frozen-shapes.json` and `frozen-shapes.ts` stay, frozen, and are deleted with the legacy-formats family when the first model that declares `span_mode: "postal"` ships. The training encoder doesn't read them.

Each reader of the table and the mode it runs under:

| Reader                                                                                                                                                                                                     | Mode                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collectMatches` in `@mailwoman/neural` `postcode/repair.ts`, which `repairPostcodeLabels` (the classifier's repair pass), `extractPostcodeAnchors` and the anchored path of the placetype pair prior call | the frozen table under `shaped`, `alnum-run` and no declaration; the `postal` family under `postal`, where a candidate without a digit is refused |
| `anchoredPostcodeSpans` in `anchor-inference.ts`                                                                                                                                                           | the frozen table under `shaped`; `findPostcodeSpans` under `postal`                                                                               |
| `wholePostcodeShape` in `@mailwoman/postcode` `postcode-format.ts`, which `countryFromPostcodeFormat` and `countriesFromPostcodeFormat` call for the resolver and the geocode session                      | every mode: it states the anchored GB, CA, IE and NL forms for a whole value, takes no card, and is unchanged                                     |
| `gb/anchor-fire.run.ts`, a development tool                                                                                                                                                                | the shaped replay it documents                                                                                                                    |

The last two rows are the places the frozen table survives under a `postal` card.

## Dependency change (observed)

`cargo tree -p mtf-channels -e normal` with the `finders` feature adds `recognize-core`, `regex-automata` (its search half) and `sha2` with its dependencies, and removes `fancy-regex`, `bit-set` and `regex-syntax`. Without the feature the tree is `serde` and `serde_json`, as before. `cargo tree -p mtf-wasm` lists `mtf-core` only, as before. `Cargo.lock` loses `fancy-regex`, and no other crate used it.

## Agreement between the finders (observed)

`postcode-agreement.run.ts` drew the v8.7.0 config's rows (corpus `v0.8.19-retention-overlay`, seed 43): the first 50,000 train rows and the validation draw, 22,209 rows. For each of the 72,209 rows it compared the encoder's candidates and anchor keys with `findPostcodeSpans` and `anchoredPostcodeSpans`.
**0 rows differ**, comparing the candidates, their countries and the anchor keys. 61,611 rows hold a candidate and 30,070 hold an anchored span.

## What moved against `shaped` (observed)

| Class               |   Rows |
| ------------------- | -----: |
| unchanged           | 71,537 |
| gains a span        |    672 |
| loses a span        |      0 |
| span changes extent |      0 |

The 672 gaining rows by what the new span has: 639 hold a lower-case letter and 33 hold white space inside the code. Before the resolution rule the comparison gained 1,928 rows: 1,240 with white space inside the code (CZ 1,001 rows and SE 118, the three-and-two digit codes), 687 with a lower-case letter and 4 outward codes, and 34 of the US rows held a false anchor.

| Country |   Rows | Rows that gain | Anchored spans, `shaped` | Anchored spans, `postal` |
| ------- | -----: | -------------: | -----------------------: | -----------------------: |
| GB      |  5,120 |            570 |                    4,308 |                    4,878 |
| NL      |  1,330 |             42 |                    1,209 |                    1,251 |
| US      | 12,836 |             11 |                   10,395 |                   10,406 |
| PK      |    934 |              9 |                      167 |                      176 |
| SI      |  2,227 |              8 |                        0 |                        8 |
| CH      |  1,450 |              5 |                        1 |                        6 |
| AR      |    444 |              4 |                        0 |                        4 |
| BE      |    266 |              4 |                        1 |                        5 |
| CZ      |  2,385 |              2 |                      967 |                      969 |
| SE      |    256 |              0 |                        3 |                        3 |

Examples: `halesowen b63 3jy` (GB, `B633JY`), `De Gieterij 212, 7553  VZ HENGELO` (NL, two spaces inside the code, from a longer row), `AVIO POLSKA ..., UL GRAZYNSKIEGO 141, 43 300 Bielsko-Biala` (PL, key `43300`), and `Shp 58 340 Waerenga Street West End 4443` (NZ, key `58340`, a house number the French shape reads as a code and the table holds under FR). The spaced CZ and SE codes paint only where the table holds those countries, and it holds few of them: the CZ rows that gain fell from 1,001 to 2 and the SE rows from 118 to 0.
The 33 remaining gains with white space inside the code are the rule working as stated: the shape belongs to a country that writes the code with a space (FR, NL and PL among them), and the table holds the key under that country. The data gives the finder no way to tell `58 340` as a house number from a French code. I left the 11 US gains uninspected.

Two earlier versions of the finder lost spans, and each was fixed before the comparison reported above:

- It dropped every candidate that overlapped a longer one before the lookup, so `VT 05401`, which a Somali shape matches, hid the ZIP code. 1,776 of 24,210 rows lost a span.
- It kept the `token` boundary, so a code after a hyphen stood only as part of a longer candidate. 87 of 72,209 rows lost a span: 59 PK (`Lahore-54000`), 22 FI and LT with a doubled prefix (`FI-FI-01730`), 3 GT, one HR row left uninspected, and the false positives `5613 CH` and `1401 SE`.

The fix for the first was the lookup-time competition. The fix for the second was the `alnum` boundary, and it let `69152` in the Brazilian CEP `69152-656` anchor under the key of Germany, France and the United States: 409 of 521 BR rows gained such a span. The connector rule above removed those.

## Parity records (observed)

Each record was verified on 2026-11-16, before the change on `origin/main` and after it. The two verification paths the reference page describes are one tool now: `parity.run.ts verify`. The Python capture and the separate Rust verification are gone. The records captured under `shaped` ran with `--set data.anchor_paint_mode=postal --ignore anchor_features --ignore anchor_confidence`. The tables are in `docs/engineering/reference/training-row-encoder.mdx`.

Every row that differs on `origin/main` differs in `address_system_ids`, because the address-system registry changed after the records were captured. After the change, a tensor other than the anchor tensors differs from `origin/main` in two records only: `c6-val-36864` has one more row, a gazetteer row whose suppression reads the anchor confidence (inferred from `encoder.rs`), and `code-unit-train-5k` has 62 more rows in `code_unit_features`.

### Changed code units (observed)

The draw of `code-unit-train-5k` holds 8,869 units. Each unit's old countries came from the retired syntax record's patterns, matched as the old finder matched them, and its new countries from `countriesAcceptingPostcode`. The encoder's count and serving's agreed on every unit. 51 distinct units changed, in 62 rows, and each changed from 0 to 1.

Cause 1, a printed prefix the retired record held as `null` (Luxembourg prints `L-`, the Faroe Islands print `FO`): `FO700` and the 50 units `L-1262`, `L-1264`, `L-1449`, `L-1526`, `L-1720`, `L-1723`, `L-1820`, `L-2453`, `L-2633`, `L-3394`, `L-3428`, `L-3539`, `L-4601`, `L-4602`, `L-4610`, `L-4879`, `L-4893`, `L-4907`, `L-4989`, `L-4995`, `L-5243`, `L-5425`, `L-5816`, `L-5870`, `L-5942`, `L-6195`, `L-6409`, `L-6581`, `L-6834`, `L-6961`, `L-7259`, `L-7307`, `L-7470`, `L-7471`, `L-7545`, `L-8057`, `L-8086`, `L-8225`, `L-8291`, `L-8310`, `L-8355`, `L-8416`, `L-8472`, `L-8551`, `L-8820`, `L-9019`, `L-9081`, `L-9164`, `L-9186`, `L-9960`.
Cause 2, the case-folding defects of issue 3088: none, because a code unit is ASCII.
Another cause: none.

## Parses with the published weights (observed)

Two worktrees ran one scratch script, as the swap record describes. One is `origin/main` at `e2211ef0d0` and the other is this branch. The script builds the pipeline the CLI's default `parse` path builds (`NeuralAddressClassifier.loadRoutedFromWeights({ locale: "en-US" })`, `createRuntimePipeline` with `fst: "auto"`, `streetEvidence: "auto"` and `poiQueryKind: "extract"`), parses each input with locale `en-US`, and writes the SHA-256 of the whole result with its timing left out. Both load the same weights from the data root `/mnt/mw`.

The inputs are every distinct `input` under `gauntlet/cases/<cc>/` (1,339) and every distinct `raw` of `heldout-dev-v0.8.18.v2.rows.jsonl` (86,221). Four inputs are in both sets.

| Inputs compared | Identical | Inputs that differ |
| --------------: | --------: | -----------------: |
|          87,556 |    87,556 |                  0 |

No input differs. Model 10.8.0's card declares `shaped`, and the postcode repair pass reads the frozen table, so the parse reads neither the postal finder nor the new boundary. The comparison covers the rebuilt WebAssembly engine and the regenerated postal artifact, which the pipeline loads for its other consumers.

## Size and speed of the serving side (observed)

`packages/postcode/tools/bench.run.ts` times `recognize` with the `postal` family composed, in microseconds per call at a load average near 1. The first figure is `origin/main` and the second this change: `68161` 2.78 and 2.81, `SW1A 1AA` 2.24 and 3.89, the New York address 11.39 and 12.00, the Tokyo address 7.34 and 9.04, the London address 11.75 and 11.70, the 300-unit address 67.95 and 68.00, the 300-digit run 217.59 and 219.75, and the 300 ideographs 30.69 and 30.73. The columns without the `postal` family stayed within noise. The Tokyo address holds 12 recognitions against 3, because a connector may touch a candidate now. The `SW1A 1AA` figure moved with the same two recognitions before and after, and it is probably noise in a short run. It wasn't repeated.

The earth entry chunk, `index-*.js` from `vite build`, is 2,079,563 bytes on both, which is 17,589 bytes under 2 MiB (2,097,152). The engine Worker's `wrangler deploy --dry-run` reports a total upload of 18,185.47 KiB (gzip 4,478.63 KiB) on `origin/main` and 18,191.53 KiB (gzip 4,479.63 KiB) with this change, 6.06 KiB more.

## Speed (observed)

`parity.run.ts profile`, the C6 config, seed 43, 40 batches of 128 rows. The encoder took 9.62 and 9.66 ms per batch on `origin/main` and 6.29 and 5.78 ms with this change, at load averages between 3.4 and 5.2 on the lab host.
