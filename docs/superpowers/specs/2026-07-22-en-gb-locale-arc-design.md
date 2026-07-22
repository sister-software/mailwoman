# en-GB locale arc — design

**Date:** 2026-07-22 · **Driver:** FOSS4G:UK 2026 talk (Leeds, 12–13 Oct) claims the en-GB build end to end. Ship target: model + packaging live well before the talk.

## Decisions (settled in brainstorm, 2026-07-22)

| Decision     | Choice                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus spine | HMLR Price Paid Data (PPD) first; EPC joins as wave 2    | PPD is field-structured (SAON/PAON/street/locality/town/district/county/postcode), ~30M rows, OGL, no registration. EPC bulk (~25M certs, UPRN-joinable) is unblocked via `UK_EPC_TOKEN` but not gating. Overture GB addresses = **0 rows** (verified 2026-07-22 on the 2026-06-17.0 snapshot) — no Overture leg.                                                                               |
| OSM          | Excluded                                                 | ODbL share-alike quarantine (`.notes/data-sources.md`); not needed given PPD volume.                                                                                                                                                                                                                                                                                                            |
| Dead tag     | GB probe carries the `dependent_locality` resurrection   | Mechanisms (a)+(b) from the 2026-07-18 fork: neutral re-init of the `B/I-dependent_locality` output rows AND a dedicated param-group LR (#727 fresh-head precedent: inherited 1e-5 stalled at 0.004, own 1e-3 converged). v382/v383 proved class-weight knobs alone are a no-op against the baked negative prior. PPD's locality field supplies gradient at volume the NZ synth rows never had. |
| Probe base   | v385 step-8000, tokenizer v0.9.0-multisplice             | Shipped line; F1 comparisons across tokenizer versions are invalid, so the unshipped PT/RO splice line is the wrong base. GB is English — no tokenizer work.                                                                                                                                                                                                                                    |
| Sequencing   | Independent of BR (v3.8.6) and PT/RO (v3.9.1) queues     | Neither has run; nothing competes for Modal. Whether 8ks merge into one ship is decided after probe reads, not now.                                                                                                                                                                                                                                                                             |
| Packaging    | `@mailwoman/neural-weights-en-gb`, fr-fr overlay pattern | Data-only package resolving the shared base via `mailwoman.baseWeights`; carries GB binaries. Matches the talk's overlay claim structurally.                                                                                                                                                                                                                                                    |
| Scotland/NI  | E&W-only corpus accepted for v1                          | PPD/EPC are England+Wales; no free record-level bulk for Scotland (RoS) or NI (LPS). FSA food hygiene / GIAS can widen coverage in a later wave.                                                                                                                                                                                                                                                |

## Phases

### Phase 0 — acquisition

- PPD complete CSV (~5 GB, no reg), ONSPD (postcode→coords), Code-Point Open (postcode centroids). EPC bulk in background via `UK_EPC_TOKEN`.
- Snapshot → hash → freeze → provenance manifest (source URL, date, license, md5) per `.notes/data-sources.md` appendix. Data root: `$MAILWOMAN_DATA_ROOT/{ppd,onspd,codepoint,epc}/`.

### Phase 1 — corpus

- GB enters via the locale-recipe pattern verified by the NZ arc: `COUNTRY_SOURCES` (`corpus/src/shard-recipes/locale.ts`) + `LOCALE_TAG` `GB:"en-GB"`.
- New **PPD adapter** (PPD is not OpenAddresses-schema): SAON→unit, PAON→house_number/building, street→street, locality→**dependent_locality**, town→post town (locality), district/county→admin, postcode joined to ONSPD for coords.
- Trap sweep (each has bitten before):
  - `COUNTRY_SURFACE_FORMS` must gain GB/UK forms (BR was missing).
  - `countryAppendFraction` on the adapter — PPD rows are country-less.
  - Formatter must render GB order (number street, locality, POST TOWN, POSTCODE) — verify before sharding, as with NZ.
  - PPD all-caps fields — case-normalize per #690 before the model sees them.

### Phase 2 — training

- 2k probe config (v3.10.x-gb-probe): `init_from` v385 step-8000; `GB:1.0` + `synth-gb` source weight; `B/I-dependent_locality` output rows re-initialized to neutral + own param-group LR (start 1e-3).
- Pre-registered reads:
  - **PRIMARY:** `dependent_locality` emission > 0 and correct on GB fixtures and the NZ fixture set (0/246 today).
  - **GUARDS:** golden us/fr micro within noise of v385; digit board bare-street-hn holds; FR fragment board holds; 6 demo presets byte-identical.
  - **FALLBACK (pre-registered):** if the primary read fails, en-GB v1 ships locality-mapped; resurrection returns as a dedicated arc. No knob-spinning past the probe (treadmill guard).
- Pass → 8k → full absolute-floor gate battery + gauntlet (the v7.1.0 lesson: full gate at ship, not just golden-2pp).

### Phase 3 — resolver/geo (independent of probe outcome)

- `postcode-gb.bin` from Code-Point Open (postcode-us.bin analog). `wof/postalcode-gb.db` already on disk.
- ONSPD → postcode anchor channel.
- Wave 2: EPC×OS Open UPRN join → `address-points-gb.db`.
- **Word-consistency-heal fix:** "dependent locality, post town" must survive as two spans (currently lumped into one locality). Ships regardless — NZ needs it too.
- Kind-classifier/query-shape: confirm GB postcode (outward+inward) recognition.

### Phase 4 — packaging + release

- `@mailwoman/neural-weights-en-gb` data-only workspace, overlay pattern.
- ⚠ Add en-gb to `scripts/copy-weights.ts` and the publish cp fallback **on day one** — the 2026-07-21 postcode-de.bin demo outage came from copy-weights building us/fr only.
- Release via CI per RELEASING.md; version decided at ship time.

### Phase 5 — demo + talk

- GB demo presets; demo redeploy after npm ship; talk numbers pulled from the eval ledger (`mailwoman eval ledger-append` on gate PASS).

## Acceptance criteria

1. GB shard built from PPD with provenance manifest; formatter-verified before training.
2. Probe reads reported against pre-registration; fork outcome (resurrected vs locality-mapped) recorded in the ledger.
3. 8k candidate passes the full gate battery + gauntlet before any promote (promotion is the operator's act).
4. `postcode-gb.bin` + heal fix shipped; GB postcode anchors verified in the pipeline.
5. `@mailwoman/neural-weights-en-gb` publishes from CI with copy-weights coverage; demo parses a GB preset correctly end to end.

## Non-goals (v1)

Scotland/NI coverage · double-dependent-locality (single level only) · BFPO/routing-indicator formats · Eircode/IE (separate locale) · NDR commercial wave.
