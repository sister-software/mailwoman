# en-GB locale arc — design

**Date:** 2026-07-22 · **Driver:** the FOSS4G:UK 2026 talk (Leeds, 12–13 Oct) presents the en-GB build end to end. Ship target: the model and packaging are live well before the talk.

## Decisions (settled in brainstorm, 2026-07-22)

| Decision     | Choice                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus spine | HMLR Price Paid Data (PPD) first; EPC joins as wave 2    | PPD is field-structured (SAON/PAON/street/locality/town/district/county/postcode), ~30M rows, OGL, and downloadable without registration. EPC bulk (~25M certs, UPRN-joinable) is available through `UK_EPC_TOKEN`, and nothing waits on it. Overture has **0 rows** of GB addresses (verified 2026-07-22 on the 2026-06-17.0 snapshot), so the corpus has no Overture source.                                                         |
| OSM          | Excluded                                                 | ODbL share-alike quarantine (`.notes/data-sources.md`). PPD volume makes OSM unnecessary.                                                                                                                                                                                                                                                                                                                                              |
| Dead tag     | GB probe carries the `dependent_locality` resurrection   | Mechanisms (a)+(b) from the 2026-07-18 fork: neutral re-init of the `B/I-dependent_locality` output rows and a dedicated param-group LR. In the #727 fresh head, the inherited 1e-5 LR stalled at 0.004 and its own 1e-3 LR converged. v382/v383 showed that class-weight changes alone have no effect against the negative prior learned in training. PPD's locality field supplies gradient at a volume the NZ synth rows never had. |
| Probe base   | v385 step-8000, tokenizer v0.9.0-multisplice             | This is the shipped line. F1 comparisons across tokenizer versions are invalid, so the unshipped PT/RO splice line is the wrong base. GB is English, so it needs no tokenizer work.                                                                                                                                                                                                                                                    |
| Sequencing   | Independent of BR (v3.8.6) and PT/RO (v3.9.1) queues     | Neither has run, so nothing competes for Modal. Whether the 8k runs merge into one ship is decided after the probe reads.                                                                                                                                                                                                                                                                                                              |
| Packaging    | `@mailwoman/neural-weights-en-gb`, fr-fr overlay pattern | A data-only package that resolves the shared base through `mailwoman.baseWeights` and carries the GB binaries. Its structure matches the overlay design the talk describes.                                                                                                                                                                                                                                                            |
| Scotland/NI  | E&W-only corpus accepted for v1                          | PPD/EPC cover England and Wales only. Scotland (RoS) and NI (LPS) have no free record-level bulk data. FSA food hygiene / GIAS can widen coverage in a later wave.                                                                                                                                                                                                                                                                     |

## Phases

### Phase 0 — acquisition

- Download the complete PPD CSV (~5 GB, without registration), ONSPD (postcode→coords), and Code-Point Open (postcode centroids). Fetch EPC bulk in the background through `UK_EPC_TOKEN`.
- Snapshot, hash, and freeze each source, then write a provenance manifest (source URL, date, license, md5) as the `.notes/data-sources.md` appendix describes. Data root: `$MAILWOMAN_DATA_ROOT/{ppd,onspd,codepoint,epc}/`.

### Phase 1 — corpus

- GB enters through the locale-recipe pattern that the NZ arc verified: `COUNTRY_SOURCES` (`corpus/src/extract-recipes/locale.ts`) + `LOCALE_TAG` `GB:"en-GB"`.
- A new **PPD adapter** is needed because PPD does not use the OpenAddresses schema. It maps SAON→unit, PAON→house_number/building, street→street, locality→**dependent_locality**, town→post town (locality), and district/county→admin, and it joins the postcode to ONSPD for coords.
- Check these known problems, each of which has caused a failure before:
  - `COUNTRY_SURFACE_FORMS` must gain GB/UK forms (BR was missing them).
  - Set `countryAppendFraction` on the adapter, because PPD rows have no country.
  - The formatter must render GB order (number street, locality, POST TOWN, POSTCODE). Verify this before extract routing, as with NZ.
  - PPD fields are all-caps. Case-normalize them per #690 before the model sees them.

### Phase 2 — training

- 2k probe config (v3.10.x-gb-probe): `init_from` v385 step-8000; `GB:1.0` + `synth-gb` source weight; `B/I-dependent_locality` output rows re-initialized to neutral with their own param-group LR (start 1e-3).
- Pre-registered reads:
  - **Primary:** `dependent_locality` emission is > 0 and correct on GB fixtures and on the NZ fixture set (0/246 today).
  - **Regression checks:** golden us/fr micro stays within noise of v385, the digit board bare-street-hn does not regress, the FR fragment board does not regress, and the 6 demo presets stay byte-identical.
  - **Fallback (pre-registered):** if the primary read fails, en-GB v1 ships with dependent localities mapped to locality, and the resurrection returns as a dedicated arc. Do not keep tuning settings after the probe.
- If the probe passes, run the 8k and then the full absolute-floor check battery + gauntlet. The v7.1.0 release showed that the full check must run at ship time, and golden-2pp alone is insufficient.

### Phase 3 — resolver/geo (independent of probe outcome)

- Build `postcode-gb.bin` from Code-Point Open, as the GB counterpart of postcode-us.bin. `wof/postalcode-gb.db` is already on disk.
- Feed ONSPD into the postcode anchor channel.
- Wave 2: join EPC with OS Open UPRN to build `address-points-gb.db`.
- **Finding (Task 5 diagnostic):** characterization tests confirm that the decode pipeline preserves dependent_locality/locality across commas. The NZ-era "heal lumps" observation came from model-level span emission, which the resurrection addresses.
- Kind-classifier/query-shape: confirm that GB postcodes (outward+inward) are recognized.

### Phase 4 — packaging + release

- Create `@mailwoman/neural-weights-en-gb` as a data-only workspace using the overlay pattern.
- ⚠ Add en-gb to `scripts/copy-weights.ts` and the publish cp fallback **on day one**. The 2026-07-21 postcode-de.bin demo outage happened because copy-weights built us/fr only.
- Release through CI per RELEASING.md. The version is decided at ship time.

### Phase 5 — demo + talk

- Add GB demo presets and redeploy the demo after the npm ship. Take the talk's numbers from the eval ledger (`mailwoman eval ledger-append` on check pass).

## Acceptance criteria

1. The GB extract is built from PPD with a provenance manifest, and the formatter output is verified before training.
2. Probe reads are reported against the pre-registration, and the fork outcome (resurrected vs locality-mapped) is recorded in the ledger.
3. The 8k candidate passes the full check battery + gauntlet before any promote. Only the operator promotes.
4. `postcode-gb.bin` has shipped, and GB postcode anchors are verified in the pipeline.
5. `@mailwoman/neural-weights-en-gb` publishes from CI with copy-weights coverage, and the demo parses a GB preset correctly end to end.

## Non-goals (v1)

Scotland/NI coverage · double-dependent-locality (single level only) · BFPO/routing-indicator formats · Eircode/IE (separate locale) · NDR commercial wave.
