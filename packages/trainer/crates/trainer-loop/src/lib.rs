//! The Mailwoman training loops over `trainer-model`.
//!
//! The supervised loop ports the Python trainer's `train/loop.py` and the MLM loop its `train/pretrain.py`.
//! Both read batches from `mtf-sampler`'s `TrainingBatches`, encode them through `mtf-channels` (or the character
//! encoder), and step `optim::AdamW` under `schedules::LambdaLr`. Each draw from the global generator (dropout, the
//! locale hint, the curricula, the MLM mask) happens where the Python loop makes it.

// A tensor's `+=` is an in-place `add_`, which autograd refuses on a tensor the backward pass saved; the
// out-of-place `x = x + y` is also the operation the Python code issues.
#![allow(clippy::assign_op_pattern)]

pub mod address_systems;
pub mod alignment;
pub mod batch;
pub mod callbacks;
pub mod checkpoint;
pub mod compare;
pub mod config;
pub mod export_check;
pub mod fisher;
#[allow(dead_code)]
mod latin_letters;
pub mod masking;
pub mod metrics;
pub mod noise;
pub mod optim;
pub mod parity;
pub mod pretrain;
pub mod realized;
pub mod schedules;
pub mod supervised;

/// A training failure, with the message that names what could not be read, built or written.
#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl std::error::Error for Error {}

macro_rules! from_error {
	($($t:ty => $prefix:literal),* $(,)?) => {
		$(impl From<$t> for Error {
			fn from(error: $t) -> Self {
				Error(format!(concat!($prefix, "{}"), error))
			}
		})*
	};
}

from_error! {
	tch::TchError => "libtorch: ",
	std::io::Error => "",
	serde_json::Error => "JSON: ",
	trainer_model::Error => "",
	mtf_sampler::Error => "sampler: ",
	mtf_channels::Error => "encoder: ",
	zip::result::ZipError => "zip: ",
}

pub type Result<T> = std::result::Result<T, Error>;

/// Builds an [`Error`] from a format string.
#[macro_export]
macro_rules! fail {
	($($arg:tt)*) => {
		$crate::Error(format!($($arg)*))
	};
}
