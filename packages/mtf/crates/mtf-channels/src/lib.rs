// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Mailwoman's training-row encoder.
//!
//! A sampled corpus row becomes the tensors one training step reads: piece ids, an attention mask, label ids
//! and the soft-feed channels (postcode anchor, gazetteer, country, street type, locality surface and code
//! unit). The encoding reproduces the Python loader it replaced byte for byte, including Python 3.12's
//! character predicates and case mappings (`python_text`) and its `f64` arithmetic before the one `f32`
//! conversion.
//!
//! The painters and the label projection need no search engine, so the serving side can share them through
//! WebAssembly. The `finders` feature adds the postcode finders the postal anchor and the code-unit channel read,
//! which run the `postal` family's artifact through `recognizer-core`.

pub mod anchor;
pub mod channel;
pub mod code_units;
pub mod encoder;
mod error;
#[cfg(feature = "finders")]
pub mod finders;
pub mod gazetteer;
pub mod label_schema;
pub mod labels;
pub mod python_text;
#[cfg(feature = "finders")]
pub mod resources;

pub use channel::{Channel, Piece};
pub use encoder::{AnchorMode, EncodedBatch, Encoder, EncoderConfig, Finders, Lexicons, RowInput};
pub use error::Error;

#[cfg(feature = "finders")]
pub use finders::PostalFinders;
#[cfg(feature = "finders")]
pub use resources::{EncoderResources, ResourcePaths};
