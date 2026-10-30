//! The Mailwoman coarse encoder over libtorch, through `tch`.
//!
//! The model is `corpus-python/src/mailwoman_train/nn/`'s `MailwomanCoarseEncoder`, with the same parameter and
//! buffer names, the same registration order, and the same libtorch operations in the same order. Three things
//! follow from issuing the same operations to the same libtorch:
//!
//! - A checkpoint loads into either model and the forward passes agree to the rounding of the kernels.
//! - Construction draws from the global generator exactly as the Python constructors do, so the same
//!   `manual_seed` gives the same initial weights.
//! - Dropout, the locale-hint draws and every curriculum draw consume the generator in the same order, so a
//!   training step in train mode draws the same masks.
//!
//! The semi-Markov span scorer (`span`) and the conventions loss mask read the label schema's segment types and
//! conventions table, as `nn/span_scorer.py` and `features/conventions.py` read theirs.

#![recursion_limit = "256"]
// A tensor's `+=` is an in-place `add_`, which autograd refuses on a tensor the backward pass saved; the
// out-of-place `x = x + y` is also the operation the Python code issues.
#![allow(clippy::assign_op_pattern)]

pub mod autocast;
pub mod checkpoint;
pub mod config;
pub mod crf;
pub mod encoder;
pub mod init;
pub mod layers;
pub mod runtime;
pub mod span;
pub mod store;

pub use config::{EncoderSpec, SchemaDefaults};
pub use encoder::{CoarseEncoder, EncoderInputs, EncoderOutput};
pub use store::Store;

/// A model failure, with the message that names what could not be built, read or computed.
#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl std::error::Error for Error {}

impl From<tch::TchError> for Error {
	fn from(error: tch::TchError) -> Self {
		Error(format!("libtorch: {error}"))
	}
}

impl From<std::io::Error> for Error {
	fn from(error: std::io::Error) -> Self {
		Error(error.to_string())
	}
}

impl From<serde_json::Error> for Error {
	fn from(error: serde_json::Error) -> Self {
		Error(format!("JSON: {error}"))
	}
}

impl From<trainer_export::Error> for Error {
	fn from(error: trainer_export::Error) -> Self {
		Error(error.0)
	}
}

pub type Result<T> = std::result::Result<T, Error>;

/// Builds an [`Error`] from a format string.
#[macro_export]
macro_rules! fail {
	($($arg:tt)*) => {
		$crate::Error(format!($($arg)*))
	};
}
