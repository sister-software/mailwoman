//! Mailwoman's subword tokenizer core.
//!
//! The first supported model format is a SentencePiece `ModelProto` with a unigram model. Loading,
//! normalization, encoding and decoding reproduce Google SentencePiece v0.2.2, including its UTF-8
//! byte offsets into the original input. Code in this crate that follows SentencePiece's algorithms
//! is adapted from Google's Apache-2.0 sources; each such module names its upstream file.

mod darts;
mod error;
mod normalizer;
mod processor;
mod proto;
mod unigram;
mod utf8;

pub use error::Error;
pub use processor::{EncodedPiece, Processor};
