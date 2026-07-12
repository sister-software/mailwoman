# Legacy rules-parser excision (v7.0.0) — design

**Date:** 2026-07-12
**Status:** Approved sections (operator, 2026-07-12); spec pending operator review
**Excises:** the Mailwoman v1 rules-based parser — `@mailwoman/classifiers`, `core/solver`, `core/solvers`, the `core/parser` machinery, the `core/classification` classifier machinery — and every runtime path into it.
**Consult record:** 3-round DeepSeek pro session (2026-07-12); structural adds folded in §Evidence capture, §Projection layer, §Order; rejections recorded in §Consult notes.

## Problem

The v1 rules parser (pelias-parser lineage) was kept through the neural transition as a reference implementation and baseline ("guiding light"). The neural pipeline has since won every eval gate, and the rules stack is now vestigial — but not inert:

1. **Three production surfaces still run it** (survey 2026-07-12, verified):
   - Native API `/v1/parse` (`mailwoman/api-engine.ts:224`) — **rules-only**; `/v1/geocode`, `/v1/batch`, `/v1/resolve` went neural, `/v1/parse` never got the swap.
   - libpostal drop-in `/parse` (`libpostal/cli.ts:40`) — rules-only, sole engine. Its docstring falsely claims "neural BIO tagger".
   - Nominatim drop-in `/search` (`nominatim/cli.ts:248`) — neural is primary, but every hit runs a second, rules parse (`streetParts`) to recover `house_number`/`road` the resolver drops.
2. **Two module-graph entanglements** block a clean cut:
   - `core/classification/Classification.ts` (the `Classification` string-set) is a shared contract: `core/types/mapping.ts`, `tokenization/Span.ts`, `formatter/format.ts` (type-only).
   - `core/tokenization/context.ts` imports runtime values from `core/solver`, and the neural pipeline imports `Span` from the tokenization barrel — the v0 solver sits in the neural module graph today (loaded, never invoked).
3. **~6.8k LOC of legacy tests** run in CI on every PR, including 27 integration files (2.7k LOC) of hand-curated country-parity assertions driven by test-kit's global `createAddressParser()`.

Non-production paths (all die with the parser): CLI no-weights fallback, `parse --isolated`, `mailwoman debug`, the default-OFF arbitration bridge (`ruleProposer`, research-only, promotion killed by the coordinate gate #685), and the eval-harness v0 baseline legs.

## Decisions (settled 2026-07-12)

| Question            | Decision                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version             | **v7.0.0 major.** Rides along: #875 `Us` casing batch (`isUsStateAbbreviation` → `isUSStateAbbreviation`, codex `us/*`) + the `writeJsonl` straggler in `corpus/src/build.test.ts`.                                                                                                                                                                               |
| Sealing             | **Tag + delete** (option A). Annotated tag `legacy-rules-final` on the last pre-excision commit; npm registry is the immutable archive; `npm deprecate @mailwoman/classifiers` with a pointer to the migration guide. Split-repo and frozen-workspace options rejected (recreate what the registry gives for free / don't meet the "vestigial code removed" bar). |
| `/v1/parse` format  | **Native neural output** (`AnnotationSet`/`ComponentTag` tree — the same language the rest of `/v1` speaks). Breaking, documented in the migration guide. No permanent projection into the dead `SerializedSolution` shape.                                                                                                                                       |
| CLI no-weights UX   | **Interactive weights guard** (see §Weights guard). Prompt to download a weights package; decline ⇒ degraded pipeline parse with a banner. Non-TTY ⇒ hard error with install hint.                                                                                                                                                                                |
| Utilities to retain | Already current-gen: `codex/us/*` (USPS directionals/suffixes), `normalize/abbreviations`. The legacy classifiers are the duplicate copies and die. `core/data/libpostal/` dictionary **data stays** — live dep of corpus tiger/ban decompose + the street-morphology FST builder (raw `.txt` reads, verified).                                                   |
| Parity corpus       | **Rescued, not sealed.** Convert to neural eval fixtures before deletion (§Parity-corpus rescue).                                                                                                                                                                                                                                                                 |

## Evidence capture (phase 0 — while everything still runs)

The rules parser is the reference for every non-regression gate below and is about to be deleted. Captured **before any swap lands**, committed as fixtures:

| Artifact                                  | Feed                                                                                           | Debugs                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/parse` golden responses              | the 2.7k parity addresses + rare-label synthetics (`po_box`, `level`, `staircase`, `entrance`) | did the neural swap regress a component the old endpoint extracted — compared at component level via the taxonomy bridge (the wire shape changes by design, so this gate is semantic, not byte-exact) |
| libpostal `/parse` golden responses       | same set                                                                                       | exact-label fidelity of the `toLibpostal()` projection                                                                                                                                                |
| nominatim `/search` full golden responses | ~200 queries incl. known resolver-drop cases                                                   | semantic drift in `streetParts` after deriving from the neural parse                                                                                                                                  |
| raw rules output per parity assertion     | each `mailwoman/test/` assertion input                                                         | fixture failure triage: "neural changed" vs "assertion was idiosyncratic"                                                                                                                             |

Plus one probe before trusting the archive: `npm i @mailwoman/classifiers@6.0.0 mailwoman@6.0.0` in a clean tmp dir (cold, outside the workspace), construct the parser, parse one address. If the published tarballs don't stand alone, the sealing story is hollow and we fix that **in a 6.x patch** before v7.

## Projection layer

`toLibpostal()` joins `toOpenCage()`/`toNative()` in `@mailwoman/annotations` — the annotation contract is already where output-format projections live, so libpostal's label taxonomy becomes one more projection, not a private map inside the drop-in server.

**Plan-1 discovery (2026-07-12):** `libpostal/engine.ts` already carries `COMPONENT_TO_LIBPOSTAL` + `toLibpostalComponents()` serving the current wire (v1 classification names overlap `ComponentTag` names for the mapped set, so the same map covers both eras). Plan 2 hoists or extends that map rather than writing one from scratch; the open choice there is hoist-into-`annotations` vs extend-in-place.

**Plan-2 amendments (2026-07-12, scout-verified against source):**

1. **The projection stays in `libpostal/engine.ts` (extend-in-place).** `@mailwoman/annotations` is the coordinate-keyed _enrichment_ contract (`AnnotationSet` = dms/mgrs/timezone/currency/…, projected by `toOpenCage()`/`toNative()`); it has no component/tag vocabulary and is the wrong home for a parse-component projection. The paragraph above stands corrected.
2. **"Native neural output" for `/v1/parse` means the decoder serializers, not `AnnotationSet`:** ordered `[ComponentTag, value]` components (`decodeAsTuples`) plus the loose `AddressTree` shape `/v1/resolve` already speaks (`{ roots }`). Same correction as (1): `AnnotationSet` was the wrong term in §Decisions.
3. **The drop-in gates are structured comparisons, not byte-equality.** The neural tag vocabulary differs from the rules parser's by design (street splits into `street_prefix`/`street`/`street_suffix`; no `unit_designator`; values are case-normalized). Byte-identity with the rules-era goldens is unattainable for any engine swap. Gates become: (a) wire-shape validity (labels within the libpostal vocabulary post-projection, reading order preserved), (b) pre-registered per-label agreement floors vs the goldens after case-folding + street assembly (house_number ≥ 0.97, postcode ≥ 0.97, road ≥ 0.90 — pre-registered before any gate run), (c) a committed diff report classing every divergence (known-vocab / improvement / regression) for review. The nominatim `road` field additionally gets _richer_ by design (full assembled prefix+base+suffix vs the bare rules `street` value) — an adjudicated-improvement class, not a regression.
4. **`streetParts` needs no replacement parse at all:** `GeocodeResult.house_number`/`.street` already carry the spans (#1041), populated from the same neural parse the geocode runs. The nominatim swap is a deletion.

- Direction: `ComponentTag` → libpostal labels (`street → road`, `locality → city`, `region → state`, …). `core/types/mapping.ts` is retained as the taxonomy bridge (it survives the excision precisely because the projections and the parity conversion need it).
- Labels the neural taxonomy can't distinguish (`house`, `near`, `category`): omit, log-once. They are near-absent in the golden corpus; if the gate shows otherwise, that's a board issue, not a blocker.
- Nominatim's `streetParts` recovery uses the same projection helper against the neural parse **already computed for the query** — the second parse per `/search` hit disappears (perf win, gated by the golden set).

## Weights guard (CLI)

`npx mailwoman parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"` must keep feeling good with zero setup. A guard component in `mailwoman/cli-kit` (Ink/Pastel — the AuthGuard-wrapper pattern) wraps model-requiring commands:

1. Weights resolve (installed package, `$MAILWOMAN_DATA_ROOT`, or cache) ⇒ pass through.
2. Missing + TTY ⇒ prompt: download a weights package (per-locale list with sizes) into the user cache; verified fetch of the published tarball; proceed neural.
3. Declined ⇒ **degraded pipeline parse** (normalize → query-shape → locale-gate → kind-classifier → phrase-grouper structural output) with an explicit banner naming what's degraded and how to upgrade.
4. Missing + non-TTY (CI, pipes) ⇒ hard error with install hint. `--degraded` opts into 3 without a prompt; `--download-weights` opts into 2 without a prompt. Scripts stay deterministic.

The degraded path is the current-gen preprocessing stack, **not** a retained rules parser.

## Contract rehoming (before deletion)

1. `Classification.ts` string-set → `core/types/` (it's a taxonomy the mapper and formatter consume; the classifier machinery around it dies).
2. Break `tokenization/context.ts → core/solver` edge. Keep `Span`, `normalizer`, `split` (current-gen consumers: neural, phrase-grouper, decoder, policy). Delete `context`, `Graph`, `permutate` with the solver.
3. `core/parser/proposal-pipeline.ts` (generic `ProposalClassifier` orchestrator, rule-or-neural) moves out of `core/parser/` before the directory dies.

## Parity-corpus rescue

The 27 country files are hand-written multilingual gold (ported addressit/pelias parity cases) — human expectations, not captured rules output. Triage per assertion:

- **Convert straight:** labels identical across taxonomies (`house_number`, `postcode`, `unit`, …).
- **Translate then convert:** via `legacyClassificationToComponentTag`; mapping recorded in the fixture.
- **Drop as rules-idiosyncratic:** person-name labels the ComponentTag taxonomy deliberately removed (`given_name`, `surname`, `personal_title`), and pure tokenization-quirk assertions where span boundaries are the only signal. Dropped cases keep a tombstone comment naming the original file and reason.

Every converted fixture carries provenance: `v1-parity:<country>: "<address>" mapped: <old→new,…>` — a future failure is distinguishable from organic eval data at a glance.

## Deletion inventory

| Delete                                                                                      | Notes                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `classifiers/` workspace (2.8k LOC + 29 test files)                                         | npm package deprecated, not unpublished                           |
| `core/solvers/`, `core/solver/`                                                             | after the tokenization edge is broken                             |
| `core/parser/AddressParser.ts`, `solution-to-proposals.ts`                                  | `proposal-pipeline.ts` rehomed first                              |
| `core/classification/` machinery (Base/Word/Phrase/Section/Composite, scheme)               | `Classification.ts` rehomed first                                 |
| arbitration bridge: `arbitrate` flag, `ruleProposer`, `applyRuleArbitration`, policy routes | research-only, default-OFF, killed by #685                        |
| eval-harness v0 legs (`harness-v0-neural` rules leg, `per-type-report`, resolver-eval legs) | v0-vs-neural history lives in the dated eval reports              |
| test-kit `createAddressParser` + the 27 `mailwoman/test/` parity files                      | after conversion                                                  |
| umbrella `export * from "@mailwoman/classifiers"` + `utils/parser.ts`                       | breaking API removal → migration guide                            |
| `mailwoman debug`, `parse --isolated`, no-weights rules fallback                            | fallback replaced by the weights guard                            |
| `prepareLocaleIndex()` + libpostal loader machinery in `core/resources`                     | loses all callers with the classifiers; the `.txt` **data** stays |

Stays, explicitly: `core/data/libpostal/` + `core/data/internal/` dictionaries (corpus + FST builders read them raw), `whosonfirst/` + `chromium-i18n/` data, `Span`/`normalizer`/`split`, `types/mapping.ts`, `normalize/`, `codex/`, THIRD_PARTY_NOTICES entries for retained data (verify coverage).

## Execution order (CI green at every step)

1. **Phase 0:** archive probe + golden capture (all four artifacts).
2. **Projection:** build `toLibpostal()` in `annotations/` with unit tests against the libpostal golden.
3. **Swaps, one PR each, eval-gated:** `/v1/parse` → native neural (gate: semantic component-level comparison vs golden + emitted OpenAPI update) → libpostal `/parse` (gate: byte-level non-regression vs golden; fix the docstring) → nominatim `streetParts` from the neural parse (gate: `/search` golden, byte-level).
4. **Weights guard** lands with the `/v1/parse`-era CLI work (it must exist before the fallback dies).
5. **Rehoming:** `Classification.ts` → `core/types/`; break `context → solver` edge; move `proposal-pipeline.ts`.
6. **Umbrella surface:** remove the classifiers re-export + `utils/parser.ts` consumers (keeps CI green through deletion).
7. **Parity conversion** (after 5 — fixtures import the cleaned graph), then delete the old parity files.
8. **Deletion PR(s):** inventory above, including eval v0 legs and remaining tests.
9. **Casing batch:** #875 `Us` renames + `writeJsonl` straggler (after moves so the sweep hits final paths; skip SQL column strings per the batch-B scar).
10. **Seal + ship:** migration guide, docs scrub (references to the rules baseline in runbooks/README), `legacy-rules-final` tag, `npm deprecate`, v7.0.0 via CI publish.

## Testing

- Every swap PR carries its golden-set gate; the goldens are committed fixtures, so gates outlive the parser.
- Converted parity fixtures join the neural eval suite in the same PR that deletes their source files — coverage never dips between PRs.
- CI sheds ~6.8k LOC of legacy tests at step 8; `ci:test` keeps running the full remaining suite.
- Standing eval gates (`mailwoman eval gate`, demo presets) run per swap; ledger append on PASS as usual.

## Migration guide (outline, ships in docs)

- `@mailwoman/classifiers` deprecated: pin `@6.x` (works standalone, verified) or move to `mailwoman@7` neural parsing.
- `mailwoman` umbrella no longer re-exports classifiers; `createAddressParser()` removed.
- `/v1/parse` response format changed to the native annotation tree (examples: before/after).
- `mailwoman parse` without weights now prompts/downloads instead of silently degrading to rules.
- Casing renames table (#875 batch).

## Board issues to file

1. Parity-corpus conversion tracking issue (per-country checklist, provenance convention).
2. `house`/`near`/`category` libpostal labels — revisit if the golden gate shows real traffic.
3. Multilingual (non-US) directional/suffix **helper** coverage: the legacy multilingual classifier dies; the data stays. If a consumer needs a multilingual lookup helper later, build it over the `.txt` data in `codex/` style.
4. `variant-aliases/` remains consumer-less (#166) — unaffected by this arc, noted while surveying.

## Consult notes (DeepSeek pro, 3 rounds, 2026-07-12)

Folded in: pre-deletion golden capture; projection lives in `annotations/`; registry cold-install probe; migration guide + docs scrub + re-export removal sequenced before deletion. Rejected: in-repo source tarball archive (tag + registry already archive it); gating against upstream libpostal's own outputs (different parser, unattainable exact-match — gates are non-regression vs our own endpoints); "rules baseline is an irreplaceable oracle" (it stays installable; parity assertions are human gold, not rules output). Session made no quantitative predictions; structural contributions 4/6 adopted.
