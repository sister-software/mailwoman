# Phase 7 — Stage 1 Normalize + QueryShape boundary

**Goal:** ship two new workspaces, `@mailwoman/normalize` and `@mailwoman/query-shape`, that implement runtime-pipeline stages 1 + the QueryShape boundary per [`STAGES.md`](../reference/STAGES.md) and [`QUERY_SHAPE.md`](../reference/QUERY_SHAPE.md). Pure functions, no ML, no new runtime dependencies beyond `@mailwoman/core`.

**Branch:** ad-hoc on `main`; ship via incremental commits.

**Depends on:** [`STAGES.md`](../reference/STAGES.md) (the interface contract) and [`QUERY_SHAPE.md`](../reference/QUERY_SHAPE.md) (the QueryShape sub-system design).

**Why these two together:** QueryShape consumes `NormalizedInput.normalized` and produces structural priors that downstream stages thread through. Building them in the same ship means the boundary between them gets its first real test before it ossifies.

## Order of operations

Per STAGES.md "What's next" suggestion: **QueryShape first**, then Normalize. Reasons:

- QueryShape can run on raw input directly (treating raw as already-normalized) for a v0 — useful for early integration.
- QueryShape's interface is smaller; less to get wrong on the first pass.
- Normalize's offsetMap is load-bearing; building it second lets us see QueryShape's actual access patterns before committing to the offsetMap shape.

## Tasks

### Slice A — `@mailwoman/query-shape`

#### 1. Workspace scaffolding

- [ ] `query-shape/package.json` with name `@mailwoman/query-shape`, version `2.1.0`, license AGPL-3.0-only, exports map pointing at `./out/index.js`
- [ ] `query-shape/tsconfig.json` extending `@sister.software/tsconfig`, outDir `./out`, no references (pure standalone)
- [ ] `query-shape/vitest.config.ts` matching other workspaces' pattern
- [ ] Add `query-shape` to root `package.json` `workspaces`
- [ ] Add `query-shape` to root `tsconfig.json` `references`

#### 2. Core types — `types.ts`

- [ ] `SpanRange` — minimal `{ start, end, body }` interface (no dependency on core's Span class)
- [ ] `TokenClass` — span + class + length
- [ ] `Segment` — span + body + index + separator
- [ ] `KnownFormatHit` — format + span + confidence
- [ ] `QueryShape` — composes all the above
- [ ] `CharacterClass` union — `numeric | alpha | alphanumeric | cjk | cyrillic | arabic | mixed`
- [ ] `TokenCharacterClass` union — per-token classes
- [ ] `KnownFormat` union — `us_zip | us_zip4 | uk_postcode | fr_postcode | ca_postcode | de_postcode | jp_postcode | po_box`

#### 3. Character-class detection — `character-class.ts`

- [ ] `classifyCodepoint(cp: number): TokenCharacterClass | 'whitespace' | 'punct' | 'other'`
- [ ] `classifyToken(text: string): TokenCharacterClass` — folds codepoint classes to dominant class
- [ ] `classifyInput(text: string): CharacterClass` — folds token classes to dominant class
- [ ] Unicode-range detection for CJK, Cyrillic, Arabic (regex `\p{Script=...}` where supported)

#### 4. Tokenization — internal, not exported

- [ ] `tokenize(text: string): SpanRange[]` — whitespace + punctuation split, preserves character offsets
- [ ] Treats consecutive non-whitespace-non-punct as one token
- [ ] Internal helper; downstream sees `TokenClass[]` only

#### 5. Segmentation — `segmentation.ts`

- [ ] `segment(text: string, locale?: LocaleTag): Segment[]` — punctuation-grammar-aware chunking
- [ ] Default rules: commas, newlines, tabs separate segments; consecutive whitespace inside segment preserved
- [ ] Locale-specific overrides reserved for future (JP whitespace, KR honorifics)
- [ ] Each Segment carries its separator and 0-based index

#### 6. Known-format detection — `known-formats.ts`

- [ ] Regex patterns: US ZIP, US ZIP+4, UK postcode, CA postcode, JP postcode, generic 5-digit (FR/DE ambiguous), PO Box
- [ ] `detectKnownFormats(text: string, tokens: TokenClass[]): KnownFormatHit[]`
- [ ] Confidence rules: unambiguous patterns (US ZIP+4, UK, CA, JP) → 0.95; ambiguous 5-digit → 0.6 (caller disambiguates via locale)
- [ ] Reuse `core/data/chromium-i18n/ssl-address/*.json` for additional country regexes if cheap (defer if it adds a core dependency we don't already need)

#### 7. Entry point — `compute.ts`

- [ ] `computeQueryShape(input: string | NormalizedInputLite, opts?: ComputeOpts): QueryShape`
- [ ] `NormalizedInputLite = { normalized: string; appliedLocale?: string }` — minimal structural shape; full `NormalizedInput` from `@mailwoman/normalize` satisfies it without import
- [ ] Composes character classification + tokenization + segmentation + known-format detection
- [ ] Returns frozen `QueryShape` (immutable)

#### 8. Re-exports — `index.ts`

- [ ] Export public types + `computeQueryShape`
- [ ] Do NOT export internal helpers (tokenize, internal regex tables)

#### 9. Tests

- [ ] `compute.test.ts` — end-to-end cases: `"10118"`, `"Paris"`, `"350 5th Ave, New York, NY 10118"`, `"東京駅"`, `"NYC NY"`, `"PO Box 1234"`
- [ ] `character-class.test.ts` — codepoint + token classification
- [ ] `segmentation.test.ts` — comma + newline + tab + whitespace cases
- [ ] `known-formats.test.ts` — each postcode pattern, ambiguity cases, PO Box variants
- [ ] Run `npm test -w @mailwoman/query-shape` clean

#### 10. Build verify

- [ ] `npm run compile` clean
- [ ] `npm run lint` clean
- [ ] No new runtime dependencies in `package.json` beyond peer on `@mailwoman/core` (and only if needed — prefer standalone)

#### Ship

- [ ] One commit, one push. No npm publish — internal use only until Slice B lands.

### Slice B — `@mailwoman/normalize`

#### 1. Workspace scaffolding

- [ ] `normalize/package.json`, `tsconfig.json`, `vitest.config.ts`
- [ ] Add to root workspaces + tsconfig references

#### 2. Core types — `types.ts`

- [ ] `NormalizedInput` — raw, normalized, transforms, offsetMap, appliedLocale
- [ ] `NormalizationTransform` discriminated union (nfc, case_fold, expand_abbreviation, collapse_whitespace, normalize_punctuation)
- [ ] `NormalizeOpts` — locale, skipAbbreviations

#### 3. Per-transform modules

- [ ] `nfc.ts` — Unicode NFC via `string.normalize('NFC')`, returns identity offsetMap (no length change)
- [ ] `case-fold.ts` — locale-aware lowercasing, identity offsetMap
- [ ] `whitespace.ts` — collapse runs of whitespace to single space, recompute offsetMap
- [ ] `punctuation.ts` — normalize quote / dash variants, identity-or-near offsetMap
- [ ] `abbreviation.ts` — locale dictionary lookup + expand (St → Street), offsetMap reflects length change

#### 4. Abbreviation dictionaries

- [ ] Borrow shape from `corpus/synthesize.ts` (synthesis uses the inverse direction)
- [ ] Per-locale dictionaries: `en-US.ts` (Ave → Avenue, St → Street, NW → Northwest, etc.), `fr-FR.ts` (R. → Rue, Bd → Boulevard, etc.)
- [ ] Each entry: short form + canonical form + applicable contexts

#### 5. Entry point — `compute.ts`

- [ ] `normalize(raw: string, opts?: NormalizeOpts): NormalizedInput`
- [ ] Run transforms in fixed order: NFC → punctuation → whitespace → case-fold → abbreviation
- [ ] Compose offsetMaps so the final map traces all the way back to raw
- [ ] Returns frozen `NormalizedInput`

#### 6. Re-exports — `index.ts`

#### 7. Tests

- [ ] `compute.test.ts` — round-trip tests + offsetMap correctness for each transform combination
- [ ] `nfc.test.ts`, `whitespace.test.ts`, `abbreviation.test.ts` — per-transform unit tests
- [ ] **OffsetMap invariant test:** for every `i` in `normalized`, `raw[offsetMap[i]]` is the character `normalized[i]` came from. Run on a corpus of 1000 random addresses from `corpus-v0.3.0` to catch edge cases.

#### 8. Build verify + ship

- [ ] `npm run compile` / `npm test` / `npm run lint` all green
- [ ] One commit, one push

### Slice C — integration

Optional, defer if running long:

- [ ] Update CLI to expose `--show-query-shape` and `--show-normalized` debug flags
- [ ] Wire into `@mailwoman/neural` so the neural classifier optionally consumes `QueryShape.segments` as input feature (encoder feature path from STAGES.md Stage 3 "Future" section)
- [ ] No `runPipeline` coordinator yet — that's a separate phase

## Success criteria

- [ ] Both workspaces build clean.
- [ ] Tests green.
- [ ] No new runtime deps.
- [ ] `LOG.md` has entries for each slice.
- [ ] Branch pushed to main.
- [ ] STAGES.md "Today" lines for Stage 1 + QueryShape updated to reflect shipped state.

## Out of scope

- Stage 2 (locale gate) — separate phase.
- Stage 2.5 (kind classifier) — separate phase.
- `runPipeline` coordinator — Phase 8 or later.
- npm publish of the new packages — internal use only until they have a consumer.
- Replacing the existing word tokenizer in `@mailwoman/core` — QueryShape's tokenization is internal-only.

## When to call this phase done

When you can:

```ts
import { computeQueryShape } from "@mailwoman/query-shape"
import { normalize } from "@mailwoman/normalize"

const n = normalize("350 5th Ave, New York, NY 10118")
const shape = computeQueryShape(n)
// shape.knownFormats.find((f) => f.format === "us_zip") → defined
// shape.segments.length === 4
```

…and the lint/test/compile gates are all green.
