// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Mailwoman's training-row sampler.
//!
//! [`Sampler::open`] lists a corpus split from its manifest, indexes the train split's files by source, and streams
//! rows through the source mixture, a shuffle buffer, augmentation and the affix relabel. The rows are the ones the
//! Python sampler drew for the same configuration and seed, so the sampler's randomness comes from
//! [`pyrandom::PyRandom`], which reproduces CPython 3.12's `random.Random`, and every stage draws where the Python
//! stage drew. [`batch::encode_rows`] encodes a batch through `mtf-channels`, and [`char_path::CharEncoder`] encodes
//! it for the CharCNN front end.

pub mod augment;
pub mod batch;
pub mod char_path;
pub mod columns;
pub mod config;
pub mod corpus_files;
pub mod emit;
mod error;
mod file_rows;
pub mod mixture;
pub mod parquet_file;
pub mod pyrandom;
pub mod relabel;
pub mod row;
pub mod sampler;
pub mod sha256_cache;
pub mod source_reps;
pub mod split_columns;
mod text;

pub use config::{AugmentProbabilities, CharConfig, RunLength, SamplerConfig, Weights};
pub use error::{Error, Result};
pub use row::{Row, SpanTriple};
pub use sampler::{CancelToken, Event, Observer, RawRows, Sampler, SkipReason, TrainingBatches};
