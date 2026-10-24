# Third-Party Notices

`@mailwoman/mtf` is distributed under AGPL-3.0-only, with a commercial license available from Sister
Software. Its Rust core ports code from the two projects below. Each ported file keeps the upstream
copyright notice in its header and states that it was modified.

## Google SentencePiece — Apache-2.0

Source: [google/sentencepiece](https://github.com/google/sentencepiece) v0.2.2, commit
`e0cce7d37b065b5140349dbe12c6bcf6192fdd78`. Copyright 2016 Google Inc. The full license text is
`third-party/sentencepiece/LICENSE`. SentencePiece ships no `NOTICE` file.

| Ported file                         | Upstream source                                            |
| ----------------------------------- | ---------------------------------------------------------- |
| `crates/mtf-core/src/normalizer.rs` | `src/normalizer.cc`                                        |
| `crates/mtf-core/src/unigram.rs`    | `src/unigram_model.cc`                                     |
| `crates/mtf-core/src/processor.rs`  | `src/sentencepiece_processor.cc`, `src/model_interface.cc` |
| `crates/mtf-core/src/proto.rs`      | `src/sentencepiece_model.proto`                            |
| `crates/mtf-core/src/utf8.rs`       | `src/util.h`, `src/util.cc`                                |

The name SentencePiece identifies the upstream project. Apache-2.0 §6 grants no right to use it as
this package's name, and this package does not.

## darts-clone — BSD 2-clause

Source: darts-clone as vendored in SentencePiece v0.2.2 at `third_party/darts_clone/`. Copyright (c)
2008-2011, Susumu Yata. The full license text is `third-party/darts-clone/LICENSE`.

| Ported file                    | Upstream source |
| ------------------------------ | --------------- |
| `crates/mtf-core/src/darts.rs` | `darts.h`       |
