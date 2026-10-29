//! The checkpoint's `config.json`, as `mailwoman_train/nn/serialization.py::to_config_dict` writes it.
//!
//! A key the file omits takes the default `serialization._constructor_kwargs` gives it, so a config written by an
//! older trainer reads the way `MailwomanCoarseEncoder.from_pretrained` reads it. Keys the export does not use are
//! ignored.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use crate::{fail, Result};

fn yes() -> bool {
	true
}

fn two() -> usize {
	2
}

fn one() -> usize {
	1
}

fn five() -> usize {
	5
}

fn unit() -> f32 {
	1.0
}

fn sixty_four() -> usize {
	64
}

/// `CharCNNEmbedding`'s default `kernel_sizes`.
fn char_kernel_sizes() -> Vec<usize> {
	vec![3, 4, 5]
}

/// The fields of `config.json` the export reads.
#[derive(Clone, Debug, Deserialize)]
pub struct ModelConfig {
	pub vocab_size: usize,
	pub hidden_size: usize,
	pub num_hidden_layers: usize,
	pub num_attention_heads: usize,
	pub intermediate_size: usize,
	pub max_position_embeddings: usize,
	pub num_labels: usize,
	pub pad_token_id: i64,
	#[serde(default)]
	pub use_phrase_priors: bool,
	#[serde(default)]
	pub use_locale_conditioning: bool,
	#[serde(default)]
	pub num_locales: Option<usize>,
	#[serde(default)]
	pub use_postcode_anchor: bool,
	#[serde(default)]
	pub inject_first_token: bool,
	#[serde(default)]
	pub use_gazetteer_anchor: bool,
	#[serde(default = "five")]
	pub gazetteer_feature_dim: usize,
	#[serde(default)]
	pub use_country_anchor: bool,
	#[serde(default = "two")]
	pub country_feature_dim: usize,
	#[serde(default = "unit")]
	pub country_ambiguous_scale: f32,
	#[serde(default)]
	pub use_street_type_anchor: bool,
	#[serde(default = "one")]
	pub street_type_feature_dim: usize,
	#[serde(default)]
	pub use_locality_surface_anchor: bool,
	#[serde(default = "two")]
	pub locality_surface_feature_dim: usize,
	#[serde(default)]
	pub use_code_unit_anchor: bool,
	#[serde(default)]
	pub use_affix_head: bool,
	#[serde(default)]
	pub use_deploc_head: bool,
	#[serde(default)]
	pub use_span_scorer: bool,
	#[serde(default)]
	pub use_char_embed: bool,
	#[serde(default)]
	pub char_vocab_size: usize,
	#[serde(default = "sixty_four")]
	pub char_embed_dim: usize,
	#[serde(default = "char_kernel_sizes")]
	pub char_kernel_sizes: Vec<usize>,
	#[serde(default)]
	pub use_address_system_head: bool,
	#[serde(default)]
	pub num_address_systems: usize,
	#[serde(default)]
	pub use_locale_hint: bool,
	#[serde(default = "yes")]
	pub use_crf: bool,
	#[serde(default)]
	pub id2label: BTreeMap<String, String>,
}

impl ModelConfig {
	pub fn read(path: &Path) -> Result<ModelConfig> {
		let text = std::fs::read_to_string(path).map_err(|error| fail!("{}: {error}", path.display()))?;
		serde_json::from_str(&text).map_err(|error| fail!("{}: {error}", path.display()))
	}

	/// The label order the classifier head emits, read from `id2label`.
	pub fn labels(&self) -> Result<Vec<String>> {
		if self.id2label.is_empty() {
			return Ok(Vec::new());
		}
		let mut labels = vec![None; self.num_labels];
		for (id, label) in &self.id2label {
			let index: usize = id
				.parse()
				.map_err(|_| fail!("config id2label key {id:?} is not an index"))?;
			let slot = labels
				.get_mut(index)
				.ok_or_else(|| fail!("config id2label index {index} >= num_labels"))?;
			*slot = Some(label.clone());
		}
		labels
			.into_iter()
			.enumerate()
			.map(|(i, label)| label.ok_or_else(|| fail!("config id2label has no label {i}")))
			.collect()
	}
}
