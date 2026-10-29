// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The settings a sampler opens a corpus with.
//!
//! The Python trainer builds this from its `DataConfig` until the TypeScript config resolver writes the resolved
//! configuration the sampler reads directly. Every path is absolute or relative to the working directory.

use crate::error::{Error, Result};
use serde::de::{Deserializer, MapAccess, Visitor};
use serde::Deserialize;
use std::fmt;
use std::path::PathBuf;

/// A weight per key in the order the configuration lists them.
///
/// The order is kept because a sum over the weights is order-dependent in floating point, and `source_reps` sums
/// the configured weights in their listed order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Weights(pub Vec<(String, f64)>);

impl Weights {
	pub fn get(&self, key: &str) -> Option<f64> {
		self.0.iter().find(|(k, _)| k == key).map(|&(_, w)| w)
	}

	pub fn contains(&self, key: &str) -> bool {
		self.0.iter().any(|(k, _)| k == key)
	}

	pub fn keys(&self) -> impl Iterator<Item = &str> {
		self.0.iter().map(|(k, _)| k.as_str())
	}

	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}
}

impl<'de> Deserialize<'de> for Weights {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
		struct OrderedVisitor;
		impl<'de> Visitor<'de> for OrderedVisitor {
			type Value = Weights;
			fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
				f.write_str("an object of numeric weights")
			}
			fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Weights, A::Error> {
				let mut out = Vec::new();
				while let Some((key, value)) = map.next_entry::<String, f64>()? {
					if out.iter().any(|(k, _): &(String, f64)| *k == key) {
						return Err(serde::de::Error::custom(format!("weight {key:?} is listed twice")));
					}
					out.push((key, value));
				}
				Ok(Weights(out))
			}
		}
		deserializer.deserialize_map(OrderedVisitor)
	}
}

/// The probability of each augmentation, in `augment_row`'s draw order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AugmentProbabilities {
	#[serde(default)]
	pub directional: f64,
	#[serde(default)]
	pub region: f64,
	#[serde(default)]
	pub glue: f64,
	#[serde(default)]
	pub case: f64,
	#[serde(default)]
	pub punct_drop: f64,
	#[serde(default)]
	pub upper_case: f64,
	#[serde(default)]
	pub ordinal: f64,
	#[serde(default)]
	pub postcode_move: f64,
	#[serde(default)]
	pub grouping: f64,
}

impl AugmentProbabilities {
	/// Whether any augmentation can fire. All zero means every row passes through and draws nothing.
	pub fn any(&self) -> bool {
		[
			self.directional,
			self.region,
			self.glue,
			self.case,
			self.punct_drop,
			self.upper_case,
			self.ordinal,
			self.postcode_move,
			self.grouping,
		]
		.iter()
		.any(|&p| p > 0.0)
	}
}

/// How many rows the run reads, which `source_reps` divides by to turn a reps target into a weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunLength {
	pub max_steps: u64,
	pub batch_size: u64,
	#[serde(default = "one")]
	pub grad_accum_steps: u64,
}

fn one() -> u64 {
	1
}

/// The character path's settings. `mode` is `word` (a unit per whitespace token) or `char` (a unit per character).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharConfig {
	pub mode: String,
	pub vocab_path: PathBuf,
	pub max_units: usize,
	pub max_unit_width: usize,
	#[serde(default)]
	pub char_ctx: usize,
	pub label_set: String,
}

fn default_true() -> bool {
	true
}

fn default_shuffle_buffer() -> usize {
	131_072
}

fn default_volume_mount() -> PathBuf {
	PathBuf::from("/data")
}

/// Everything that decides the rows a split yields.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SamplerConfig {
	pub corpus_dir: PathBuf,
	pub country_weights: Weights,
	/// The train mixture's weight per source. `None` gives every source weight 1.
	#[serde(default)]
	pub source_weights: Option<Weights>,
	/// A reps-per-row target per source, turned into a weight once the corpus's row counts are read.
	#[serde(default)]
	pub source_reps: Option<Weights>,
	/// The run length `source_reps` needs; required when `source_reps` is set.
	#[serde(default)]
	pub run_length: Option<RunLength>,
	#[serde(default = "default_true")]
	pub coarse_filter: bool,
	/// The tags the coarse filter accepts: a row is kept when one of its labels names one of them.
	pub active_tags: Vec<String>,
	#[serde(default)]
	pub augment: AugmentProbabilities,
	#[serde(default)]
	pub augment_exclude_sources: Vec<String>,
	#[serde(default)]
	pub affix_relabel_lexicon_path: Option<PathBuf>,
	/// `postcode-layouts.json`, which the postcode move reads.
	#[serde(default)]
	pub postcode_layouts_path: Option<PathBuf>,
	#[serde(default = "default_shuffle_buffer")]
	pub shuffle_buffer: usize,
	/// Remove each row's span triple before the astral check, so the encoder takes the token-label path. The
	/// encoder-parity token arm sets it.
	#[serde(default)]
	pub drop_spans: bool,
	/// The host directory that mirrors the volume mount, `MAILWOMAN_DATA_ROOT`.
	#[serde(default)]
	pub data_root: Option<PathBuf>,
	/// The mount a manifest built on Modal lists its paths under, `MAILWOMAN_VOLUME_MOUNT`.
	#[serde(default = "default_volume_mount")]
	pub volume_mount: PathBuf,
	/// `MAILWOMAN_SHA256_CACHE`: the sidecar that remembers each file's measured sha256 across processes.
	#[serde(default)]
	pub sha256_cache_path: Option<PathBuf>,
	/// The character path. `None` is the SentencePiece path.
	#[serde(default)]
	pub char: Option<CharConfig>,
}

impl SamplerConfig {
	pub fn from_json(text: &str) -> Result<Self> {
		let config: Self = serde_json::from_str(text).map_err(|e| Error::Input(format!("sampler config: {e}")))?;
		if config.country_weights.is_empty() {
			return Err(Error::Input("country_weights must be non-empty".into()));
		}
		Ok(config)
	}

	/// The host copy of a path under the volume mount, when a data root is configured.
	pub fn volume_path_on_host(&self, path: &std::path::Path) -> Option<PathBuf> {
		let root = self.data_root.as_ref()?;
		path.strip_prefix(&self.volume_mount).ok().map(|rest| root.join(rest))
	}
}
