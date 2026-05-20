# Phase 1 — Corpus Pipeline

**Goal:** build a reproducible, versioned dataset pipeline. End state is `corpus-v0.1.0` on disk, containing aligned BIO-labeled Parquet shards for US + FR, with a hand-labeled golden eval set.

**Duration estimate:** 2 weeks.

**Branch:** `neural/phase-1-corpus`

**Depends on:** Phase 0 complete and tagged.

## Pre-flight

- [ ] Phase 0 success criteria all green
- [ ] Disk space available at `/data/corpus/` per `reference/OPERATIONS.md` layout
- [ ] You understand BIO labeling and the `LabeledRow` shape

## Tasks

### 1. Package scaffolding

- [ ] Create `packages/corpus/` workspace
- [ ] Create `packages/corpus-python/` (Python, not in workspaces — has its own `pyproject.toml`)
- [ ] `packages/corpus/src/types.ts` — `CanonicalRow`, `LabeledRow`, `CorpusAdapter`, `AdapterOptions` per `reference/INTERFACES.md`
- [ ] Add to root tsconfig references, root package.json scripts

### 2. Adapter framework

- [ ] `packages/corpus/src/adapter.ts` — base `CorpusAdapter` interface, helper utilities (streaming, checksum, dedup)
- [ ] `packages/corpus/src/runner.ts` — drives an adapter, writes intermediate JSONL, reports progress, handles backpressure
- [ ] CLI: `npx mailwoman corpus run <adapter-id> --input <path> --output <dir> [--country XX] [--limit N]`

### 3. Adapters — priority order

Build adapters in this order. Each must have:

- A small fixture in `packages/corpus/fixtures/<adapter-id>/` (license-clean, hand-crafted, < 1MB)
- An integration test that runs the adapter against the fixture
- A README documenting the source, license, download instructions, expected schema, known quirks

#### 3a. `wof-admin` (P1, coarse)

- [ ] Input: WOF SQLite distributions (`whosonfirst-data-admin-us-latest.spatial.db`, `-fr`)
- [ ] Emit one row per WOF record, with synthesized `raw` strings using country-appropriate templates
- [ ] Walk the ancestry chain — emit hierarchical variants (city alone, city+region, city+region+country)
- [ ] License: WOF is CC0
- [ ] Expected output: ~50k US localities, ~36k FR communes, plus regions/countries

#### 3b. `wof-postalcode` (P1, coarse)

- [ ] Input: WOF postalcode SQLite distributions
- [ ] Emit rows pairing postcode with its parent locality/region
- [ ] License: CC0

#### 3c. `osm-places` (P1, coarse corroboration)

- [ ] Input: OSM PBF file, filtered to `place=city|town|village|hamlet|suburb|neighbourhood`
- [ ] Emit rows for each named place, with admin hierarchy from `is_in:*` tags or reverse-geocoded from WOF
- [ ] License: ODbL — tag in `license` field
- [ ] Use `osm-pbf-parser-node` or equivalent (verify maintenance before committing)

#### 3d. `address-formatting` (P1, synthesis support)

- [ ] Vendor or fetch OpenCageData's `address-formatting` repo (MIT). It contains country-keyed templates for rendering component dicts into strings.
- [ ] `packages/corpus/src/format.ts` exposes `formatAddress(components: ComponentDict, country: string): string`
- [ ] This is not an adapter — it's a utility used by adapters and synthesis to render `raw` from component dicts.

#### 3e. `ban` (P2, FR street-level)

- [ ] Input: Base Adresse Nationale dump from `adresse.data.gouv.fr`. Format: CSV, very large (~25M rows).
- [ ] Emit rows with `house_number, street, postcode, locality, region, country='FR'`
- [ ] License: ODbL / Licence Ouverte
- [ ] Note: BAN has authoritative French addresses. This is your highest-quality FR source.

#### 3f. `openaddresses` (P2, US/global street-level)

- [ ] Input: OpenAddresses GeoJSON, country-partitioned downloads
- [ ] License: varies per source — propagate per-row
- [ ] Emit street-level rows

#### 3g. `osm-addr` (P2, US/FR street-level)

- [ ] Same OSM PBF, filtered to `addr:*` tagged ways/nodes
- [ ] Lower quality than OpenAddresses or BAN but broader coverage

#### 3h. US gov registries (P3, US venue-level)

Defer to end of Phase 1 or push to Phase 2 if running long. Each is a small adapter, none individually critical:

- [ ] `usgov/hrsa` — Health Resources & Services Administration facility list
- [ ] `usgov/npi` — National Provider Identifier (medical providers)
- [ ] `usgov/fcc` — FCC licensee addresses

#### 3i. SIRENE (P3, FR venue-level)

- [ ] Input: SIRENE bulk download (FR business registry)
- [ ] License: Licence Ouverte
- [ ] Defer if running long

### 4. Alignment

Given a `CanonicalRow` with `raw` and `components`, produce a `LabeledRow` with token-level BIO labels.

- [ ] `packages/corpus/src/align.ts`
- [ ] Strategy: for each component value, find its character span in `raw` using fuzzy match (`fastest-levenshtein`). Tokenize `raw` with SentencePiece. Assign BIO labels to tokens whose spans overlap component spans.
- [ ] Reject rows where any component cannot be aligned (component text doesn't appear in `raw` within edit distance threshold). Write rejected rows to `/data/corpus/quarantine/` with a reason for human review.
- [ ] Unit tests: alignment correct on hand-crafted examples covering: missing components, reordered components, abbreviated forms, accented vs unaccented text.

⚠ Use the **same SentencePiece model** that training and inference will use. Train it first (next task), then run alignment.

### 5. SentencePiece tokenizer training

The tokenizer is trained on the corpus, not picked off the shelf.

- [ ] `packages/corpus-python/scripts/train_tokenizer.py`
- [ ] Input: a sample (say 5M lines) of `raw` strings from coarse adapters, balanced US/FR
- [ ] Train SentencePiece with: `vocab_size=16000`, `character_coverage=0.9995`, `model_type=unigram`, `byte_fallback=true`
- [ ] Output: `tokenizer.model` and `tokenizer.vocab` written to `/data/models/tokenizer/v0.1.0/`
- [ ] Run alignment using this tokenizer.

⚠ Tokenizer version is locked into corpus version. `corpus-v0.1.0` ships with `tokenizer-v0.1.0`. Don't retrain mid-corpus.

### 6. Synthesis / augmentation

- [ ] `packages/corpus/src/synthesize.ts`
- [ ] Augmentations for both US and FR:
  - Case perturbation (random upper/lower)
  - Punctuation drop/add (commas)
  - Abbreviation swap (`Street` ↔ `St` using Mailwoman's existing dictionaries — reuse from `resources/`)
  - Whitespace normalization variants (single/double space, tab/newline)
  - Typo injection (single-char edits, low rate ~2%)
- [ ] FR-specific augmentations:
  - Accent stripping (`Hôtel` ↔ `Hotel`)
  - Particle variants (`Rue de la République` ↔ `Rue République`)
  - Arrondissement notation (`Paris 8e` ↔ `Paris VIII` ↔ `75008 Paris`)
  - CEDEX variants (with and without)
- [ ] US-specific augmentations:
  - State abbreviation vs full (`OR` ↔ `Oregon`)
  - Directional abbreviation (`SE` ↔ `Southeast`)
  - ZIP+4 with and without dash
- [ ] Each augmented row carries `synth.method` and `synth.base_source_id`.

### 7. Parquet output

- [ ] `packages/corpus/src/parquet.ts` — write labeled rows to Parquet shards, ~1M rows per shard
- [ ] Schema: `raw: string, tokens: list<string>, labels: list<string>, country: string, locale: string, source: string, source_id: string, corpus_version: string, license: string, synth_method: string?, synth_base_id: string?`
- [ ] Use `@dsnp/parquetjs` or, if that proves limiting, write JSONL and convert via a tiny Python script (PyArrow). Either is acceptable.
- [ ] Output path: `/data/corpus/versioned/corpus-v0.1.0/`

### 8. Eval splits

⚠ This is where corpora silently leak. Do it correctly.

- [ ] `packages/corpus/src/split.ts`
- [ ] Split strategy: **hold out by locality**, not random row sampling
  - US: hold out all rows from Vermont, Wyoming, North Dakota (low-density states, ensures generalization)
  - FR: hold out all rows from Corse, Lozère, Creuse (small departments)
- [ ] Output: split manifests as JSON files listing source_ids in each split. Manifests go in git.
- [ ] Splits: 90% train, 5% val, 5% test
- [ ] Document the holdout choices in `DECISIONS.md`

### 9. Golden eval set

- [ ] `/data/eval/golden/v0.1.0/`
- [ ] 500 US addresses, 500 FR addresses, hand-labeled by a human (the maintainer). Use the existing Mailwoman parser as a starting point and hand-correct.
- [ ] Each entry: `{ raw, components: { ... }, source: 'golden', notes: '...' }`
- [ ] Cover: residential, commercial, PO boxes, intersections, venues, edge cases (single-line, multi-line, abbreviations, typos)
- [ ] Check into git. This is the contract for "what good looks like."

▶ Drafting the golden set takes real time. Start it in week 1 of Phase 1 even while building adapters. Don't leave it for the end.

### 10. Corpus build pipeline

- [ ] `npx mailwoman corpus build --version 0.1.0` — single command that runs all adapters, alignment, synthesis, splits, writes Parquet
- [ ] Reproducible — same inputs → same outputs
- [ ] Logs progress, writes a manifest with file checksums to `/data/corpus/versioned/corpus-v0.1.0/MANIFEST.json`

## Success criteria checklist

- [ ] `corpus-v0.1.0/` exists on disk with Parquet shards
- [ ] MANIFEST.json has checksums for every shard
- [ ] At least 5M labeled rows (coarse + street where available)
- [ ] Eval split manifests in git
- [ ] Golden set in git: 1000 hand-labeled entries
- [ ] Tokenizer v0.1.0 saved alongside corpus
- [ ] All adapters have fixtures + integration tests
- [ ] `npm test` green
- [ ] `LOG.md`, `DECISIONS.md` up to date
- [ ] Branch tagged `neural-phase-1-complete`

## Common pitfalls

- ❌ Splitting train/test randomly. Locality holdout or it doesn't count.
- ❌ Retraining the tokenizer after some alignment has been done. Tokens shift, labels become wrong.
- ❌ Skipping the quarantine pile. The alignment failures are where future bugs hide.
- ❌ Forgetting to record the license per source. You'll regret this when someone asks if they can use a derived model commercially.
- ❌ Letting OSM dominate by row count. Stratified sampling at training time, but warn now if one source is > 60% of rows.

## When to call this phase done

When you can run `npx mailwoman corpus build --version 0.1.0` from a clean state, get a complete corpus on disk, and run a small Python script that loads a shard and prints `(tokens, labels)` pairs that look obviously correct.
