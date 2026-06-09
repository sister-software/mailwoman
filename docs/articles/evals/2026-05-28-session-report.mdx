---
sidebar_position: 32
title: "2026-05-28 session report"
---

# Session Report — 2026-05-28

## Summary

Two major infrastructure shifts: (1) migrated from self-hosted docs to GitHub Pages + HF Bucket for model assets, and (2) expanded WOF data from US-only to 7-country global coverage with a multi-script tokenizer retrain.

## WebGPU debugging arc

### The bug

The demo's ONNX model produced correct results via WASM but garbage via WebGPU on Safari/iOS. All-locality output with 0.2-0.4 confidence. Playwright tests (headless, no GPU) always passed — masking the bug entirely.

### Root cause

onnxruntime-web ships two WebGPU execution providers in the same package:

- `import "onnxruntime-web"` → JSEP (old, broken slice kernel on Metal)
- `import "onnxruntime-web/webgpu"` → Native EP (correct on all backends)

The default import uses JSEP. Chrome's Dawn/Vulkan masked the bug; Safari's Metal exposed it.

### Fix

One import path change: `onnxruntime-web` → `onnxruntime-web/webgpu`. WebGPU now works on Chrome, Safari macOS, and iOS Safari — verified on real devices.

### Takeaway

Headless CI cannot catch GPU-specific bugs. The `verify` skill's Playwright tests were passing while every real user saw garbage. Added diagnostics (backend indicator, force-WASM toggle, build stamp) to make this class of issue visible.

Reference: [Technical doc](/docs/understanding/onnxruntime-web-webgpu-gotcha). Blog post: "Our model worked in CI but broke on every real device".

## Infrastructure migration

### GitHub Pages + HF Bucket

Replaced the playpen nginx + rsync deployment with:

- **GitHub Pages**: Docusaurus builds and deploys via Actions on push to main
- **HF Bucket**: model.onnx, tokenizer.model, fst-en-US.bin, wof-hot.db served from CDN
- **Version selector**: demo page fetches `releases.json` manifest, lets users switch between v0.5.3, v0.5.2, v0.4.0, v0.1.0
- **Cache-busting**: `stale-while-revalidate` on HTML, version-qualified asset URLs

### Demo improvements

- Build stamp footer (commit hash + timestamp)
- Backend indicator (webgpu/wasm + model size)
- Force WASM toggle
- CodeBlock for XML output (syntax highlighting + copy)
- Example buttons clear stale results
- FST provenance metadata (expandable details)

## Global WOF expansion

### Data pipeline

Built a unified SQLite from 7 priority countries (US, FR, JP, CN, KR, DE, GB):

| Metric        | Value        |
| ------------- | ------------ |
| GeoJSON files | 1.74M        |
| Admin places  | 1,288,749    |
| Name variants | 10,233,886   |
| Languages     | 20+          |
| Build time    | 185s (3 min) |
| Frozen DB     | 1.09 GB      |

Pipeline implements the WAL + Freeze design brief: WAL during ingest, checkpoint + journal_mode=DELETE + indexes + ANALYZE + VACUUM INTO for the frozen artifact.

### Tokenizer retrain

v0.6.0-a0 tokenizer trained on 2.19M multi-script WOF names:

| Script    | v0.5.0-a1 (old)      | v0.6.0-a0 (new) |
| --------- | -------------------- | --------------- |
| Chinese   | 50-75% byte-fallback | **0%**          |
| Japanese  | 58-60%               | **0%**          |
| Korean    | 41%                  | **0%**          |
| Thai      | 30%                  | **0%**          |
| Aggregate | 36.6%                | **0.0%**        |

Issue #120 target was less than 5%. Hit 0%. Same 48K vocab, 28 seconds to train.

### Global FST

Multi-language FST with Unicode-aware normalization:

| Metric          | US-only (old) | Global (new) |
| --------------- | ------------- | ------------ |
| States          | 60K           | 2.08M        |
| Places          | 94K           | 1.25M        |
| Name insertions | 128K          | 4.16M        |
| Binary size     | 9 MB          | 302 MB       |
| CJK queries     | Impossible    | Working      |

"東京" → Tokyo, "北京" → Beijing, "서울" → Seoul, "大阪" → Osaka.

### CJK normalization fixes

Three files needed Unicode-aware regexes:

1. `fst-matcher.ts`: `normalizeTokens()` — `[^a-z0-9\s]` → `[\p{P}\p{S}]`
2. `fst-builder.ts`: `languages: ["*"]` support for all-language indexing
3. `fst-prior.ts`: `hasAlnum` check and `normalizeFstToken()` — ASCII → Unicode property escapes

### Piscina lock fix

The `wof/prepare` CLI command's Piscina workers were opening concurrent SQLite connections, causing `SQLITE_BUSY`. Fixed per the design brief: workers return `ParsedPlace[]` to the main thread, main thread handles all DB writes in batched transactions.

### FST V4 format

The global FST's root state has 488K edges — overflowed the u16 `edgeCount` field. Bumped to V4 with u32 edge/place counts per state (STATE_ENTRY_SIZE 12 → 16). Backwards compatible.

## v0.5.4 training

Running on Modal A100 with:

- v0.6.0-a0 tokenizer (multi-script, 0% CJK byte-fallback)
- v0.5.1 recipe (wof-admin: 2.0, constant LR, no label smoothing, 100K steps)
- Per-tag F1 logging
- Step 48000/100000 at time of writing

## HF Bucket inventory

| Path                                    | Size    | Description                                  |
| --------------------------------------- | ------- | -------------------------------------------- |
| `en-us/v0.5.3/*`                        | ~75 MB  | Current model release (4 versions available) |
| `tokenizer/v0.6.0-a0/*`                 | 1.9 MB  | Multi-script tokenizer                       |
| `wof/admin-global-priority-7country.db` | 1.09 GB | Global admin DB                              |
| `wof/fst-global-7country-all-langs.bin` | 302 MB  | Global multi-language FST                    |

## Issues closed

- **#120**: Tokenizer retrain (0% byte-fallback achieved)
- **#98**: Phase B browser demo (closed previous session)
- **#47**: Phase 3.x browser demo (closed previous session)

## Night shift addendum (02:00–02:40 UTC)

### v0.5.4 shipped

- Training completed (100K steps, A100, ~2.5h)
- Export → fp32 117 MB → int8 28.1 MB
- Demo presets: 6/6 correct on int8
- Error analysis: 17.0% exact match on 4535 golden entries (cross-tokenizer comparison invalid per eval protocol — schema mismatch dominates; Stage 3 will close most boundary errors)
- Uploaded to HF `en-us/v0.5.4/` with model.onnx, tokenizer.model, fst-en-US.bin, model-card.json
- `en-us/releases.json` updated, `defaultVersion: v0.5.4`
- `neural-weights-en-us` package version bumped to 0.5.4

### Stage 3 corpus adapters shipped

All three priority adapters now emit `street_prefix`, `street_suffix`, `unit` from existing structured input — no rescraping needed.

- **TIGER**: `decomposeStreet()` parses FULLNAME using libpostal/en directionals + street_types. 8 unit tests pass.
- **NAD**: Uses NAD's structured `St_PreDir`/`St_PreTyp`/`St_PosTyp`/`St_PosDir` fields directly. `Unit`/`Building`/`Floor`/`Room` chain into `unit` tag.
- **BAN**: French street types are leading words (`Rue`, `Avenue`, `Boulevard`). `decomposeFrStreet()` uses libpostal/fr/street_types. 6 unit tests pass.

`ACTIVE_TAGS` remains STAGE2 — bump to STAGE3 when v0.6.0 training is ready.

### Japanese WOF adapter prototype

`wof-admin-jp` walks the global SQLite parent chain for every 丁目 (chome) in the JP repo. Produces **6,373 synthetic JP training rows** across 47 prefectures, 269 localities. Top: 東京 (Tokyo) 2,251 rows. See the blog post "Why Japanese addresses break Western parsers".

### Per-locale FSTs on HF

Seven locale FSTs uploaded to `hf://buckets/sister-software/mailwoman/fst/`:

| Locale | Size    | States |
| ------ | ------- | ------ |
| en-US  | 20.9 MB | 160K   |
| en-GB  | 3.7 MB  | 33K    |
| fr-FR  | 10.2 MB | 72K    |
| ja-JP  | 13.0 MB | 116K   |
| ko-KR  | 7.1 MB  | 55K    |
| zh-CN  | 92.5 MB | 589K   |
| de-DE  | 8.1 MB  | 70K    |

CJK queries (東京, 北京, 서울) now resolve correctly. Deep demo wiring (locale detection → dynamic FST swap) deferred — out of scope for tonight.
