# @mailwoman/mtf

The Multilingual Token Framework is Mailwoman's subword tokenizer. It is a Rust core compiled to WASM,
with a TypeScript loader for Node, browsers and Workers. It will replace `@mailwoman/sentencepiece-wasm`,
which is Google SentencePiece v0.2.2 built with Emscripten. Issue #2843 tracks the work.

The workspace is private. It holds this plan, the stage 1 baseline and the reference fixtures. The Rust
crates and the TypeScript loader come next, and the workspace compiles no TypeScript until the loader
lands.

## Plan

Mailwoman's address parsing quality and operational cost define success. Google's C++ implementation
supplies the reference outputs and algorithmic guidance. Parity with it is required while the shipped
model is in use, and it stops being the acceptance criterion once a redesign ships with matched weights.

The work proceeds in two phases.

1. **Runtime replacement.** A Rust encoder loads the shipped `tokenizer.model` and reproduces Google
   v0.2.2's IDs, pieces, UTF-8 byte offsets and decode output on every row of
   `test/fixtures/board-reference-v0.2.2.json`. An offline converter may compile the protobuf model into
   a compact runtime format, so the shipped runtime need not parse protobuf. This phase changes no model
   behavior and ships on exact fixture equality plus measured load, latency, memory and size.
2. **Mailwoman-specific tokenization.** Vocabulary, normalization, boundary and symbol-handling changes are
   experiments. Each one needs a matched training run, regenerated labels and the release verdict that
   `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` requires. A changed tokenizer is never paired with old
   weights. `docs/records/research/2026-10-09-sentencepiece-vocabulary-audit.md` lists the candidate
   changes: fragmentation of uppercase words and numbers, user-defined symbols that match inside words,
   unused vocabulary rows, and the embedding table's size.

### Layout

```text
packages/mtf/
  Cargo.toml            Cargo workspace for the crates below
  crates/mtf-core/      Model representation, normalization, unigram encode, decode, errors
  crates/mtf-wasm/      Thin wasm-bindgen adapter around mtf-core
  crates/mtf-tools/     Offline model importer and compiler
  lib/                  TypeScript loader and result conversion
  wasm/                 Committed WASM binary and its build metadata
  test/fixtures/        Reference outputs from the deployed runtime
```

The WASM binary is committed, as `sentencepiece-wasm`'s is, so an ordinary install needs no Rust
toolchain. A repository check will rebuild it and compare hashes.

### Runtime interface

- The caller initializes the runtime explicitly, and may supply a compiled `WebAssembly.Module` for
  Workers. The package's import has no side effects; the WASM fetch and instantiation happen in the
  initialization call.
- A loaded model is a `Disposable` processor object. Its encode and decode methods are synchronous.
- Results are ordinary JavaScript values. The caller never handles WASM vectors or pointers.
- A model file records its format version, normalization policy, special IDs and vocabulary hash. The
  loader refuses a model whose semantics it does not implement.

### Risks to test early

- **Normalization and alignment.** The shipped model uses `nmt_nfkc` with a compiled character map.
  Generic Unicode NFKC is a different function. The Rust encoder must reproduce the compiled map and the
  original-input alignment.
- **Segmentation ties.** Scores, floating-point precision, tie-breaking and user-defined symbols can move
  token IDs. The fixtures detect such changes.
- **Byte fallback.** Several byte pieces can represent one character, and only the last owns the
  character's span.
- **Model loading.** The loader validates lengths, counts and versions before allocating, and bounds input
  length and token count.
- **Downstream consumers.** `packages/neural/lib/tokenizer.ts` converts byte offsets to UTF-16 ranges and
  trims leading whitespace. `corpus-python/src/mailwoman_train/tokenizer/` converts them to Python
  character positions for label projection. A change to `▁` or to word boundaries changes both.

## Stage 1 baseline

Measured on 2026-10-24 on an AMD Ryzen 9 8945HS with Node v26.2.0.

### Shipped model

All nine Latin weights packages (`de-de`, `en-au`, `en-gb`, `en-in`, `en-nz`, `en-us`, `es-es`, `fr-fr`,
`it-it`) ship the same `tokenizer.model`.

| Property          | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| SHA-256           | `4e9344a8995972d138ed1e3f90a07b55edf0287611eee1ebc8724b45a1eb4b23` |
| Size              | 1,632,289 bytes                                                    |
| Tokenizer version | `0.9.0-multisplice` (model card `tokenizer_version`)               |
| Algorithm         | unigram, `byte_fallback=true`, vocabulary 73,143                   |

The CJK family uses a character encoder and no SentencePiece model.

### Consumers of sentencepiece-wasm

- `packages/neural/lib/tokenizer.ts` (`MailwomanTokenizer`)
- `packages/neural/lib/native-offsets.integration.test.ts`
- `packages/neural/lib/web/browser-slo.integration.test.ts`
- `packages/mailwoman/tools/dev-tools/man-page.ts`

### Current runtime cost

The input set is the 1,264 distinct `input` strings in the gauntlet board's two-letter country
directories (46,721 UTF-8 bytes). Timings come from one process after three warmup passes.

| Measure                                    | Value                                 |
| ------------------------------------------ | ------------------------------------- |
| `sentencepiece.wasm` / `sentencepiece.mjs` | 625,993 / 57,585 bytes                |
| WASM instantiate                           | 7.4 ms                                |
| Model load (`loadFromSerializedProto`)     | 92.0 ms                               |
| Full pass, median of 10                    | 47.4 ms (26,700 addresses per second) |
| Per-address encode p50 / p95               | 27.1 µs / 67.8 µs                     |
| Tokens                                     | 23,123 (18.3 per address)             |
| Byte-fallback pieces                       | 48                                    |
| Decode differs from input                  | 10 of 1,264 rows, all from `nmt_nfkc` |

Model load costs about twice a full pass over the board. Load time and model size are the first targets for
the compiled model format.

All 10 decode differences come from `nmt_nfkc` normalization: `ª`→`a`, `¾`→`3⁄4`, `½`→`1⁄2`, `№`→`No`,
`´`→` ́`, and runs of spaces collapsed to one space. The Rust decoder must reproduce them.

### Reference fixtures

`test/fixtures/board-reference-v0.2.2.json` holds, for each board input, the IDs, pieces, UTF-8 `begins`
and `ends`, and decode output from the deployed runtime on the shipped model. The deployed WASM is built
from Google's v0.2.2 tag (`e0cce7d37b065b5140349dbe12c6bcf6192fdd78`), so these outputs are the v0.2.2
reference for this model. The file is 545,495 bytes with SHA-256
`440cffd8908a289caebb1df5c36c027a13e54c93002740972cfccd6c8e8fff3e`.

## Status

| Step                                                                             | State                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Workspace registered, plan and baseline recorded                                 | Done                                                            |
| v0.2.2 reference fixtures                                                        | Captured                                                        |
| `cargo` admitted by the Bash hook                                                | Done                                                            |
| `crates/mtf-core`: model loader, normalizer, unigram encode with offsets, decode | All 1,264 fixture rows match in IDs, pieces, offsets and decode |
| WASM adapter and TypeScript loader                                               | Not started                                                     |
| Compiled model format to reduce the 92 ms load                                   | Not started                                                     |

Run the parity test from this directory with
`MTF_REFERENCE_MODEL=<path to the shipped tokenizer.model> cargo test --release`. Without the variable it
reads `../neural-weights-en-us/tokenizer.model` and fails if that file is absent.

## License

`@mailwoman/mtf` is licensed AGPL-3.0-only, with a commercial license available, like the rest of
Mailwoman.

Six modules in `crates/mtf-core/src` port upstream code: five from Google SentencePiece v0.2.2
(Apache-2.0) and `darts.rs` from darts-clone (BSD 2-clause). Each ported file keeps the upstream
copyright notice in its header and states how it was modified. `third-party/` holds both license texts
unchanged, and `THIRD_PARTY_NOTICES.md` maps each ported file to its upstream source. A later port from
either project follows the same three steps: keep the upstream notice in the file header, state the
modification, and add the file to `THIRD_PARTY_NOTICES.md`. Code written here without an upstream
source carries only the AGPL header.
