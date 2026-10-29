// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Mailwoman's subword tokenizer core.
//!
//! The first supported model format is a SentencePiece `ModelProto` with a unigram model. Loading,
//! normalization, encoding and decoding reproduce Google SentencePiece v0.2.2, including its UTF-8
//! byte offsets into the original input.
//!
//! The crate is AGPL-3.0. Modules ported from SentencePiece (Apache-2.0) and darts-clone
//! (BSD 2-clause) keep those projects' copyright notices in their headers, and the workspace's
//! `THIRD_PARTY_NOTICES.md` lists each one.

mod darts;
mod error;
#[cfg(feature = "edit")]
pub mod model_edit;
mod normalizer;
mod processor;
mod proto;
mod unigram;
mod utf8;

pub use error::Error;
pub use processor::{EncodedPiece, Processor, SpecialIDs};
pub use proto::PieceType;
