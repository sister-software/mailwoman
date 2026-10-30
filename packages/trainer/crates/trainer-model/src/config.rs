//! The encoder's constructor arguments, from a checkpoint's `config.json` or from a training config.
//!
//! [`EncoderSpec::from_checkpoint_config`] applies the defaults of `nn/serialization.py`'s `_constructor_kwargs`,
//! and [`EncoderSpec::from_model_section`] those of `nn/encoder/build.py`'s `build_model`. The two default sets
//! differ (a checkpoint without `use_crf` has no CRF; a training config without it has one), so each is kept.
//! [`EncoderSpec::to_config_json`] writes `to_config_dict`'s fields, which `trainer-export` and the Python
//! `from_pretrained` read.

use crate::{fail, Result};
use serde_json::{json, Map, Value};

/// The phrase-prior feature width, `features.phrase_priors.PHRASE_FEATURE_DIM`.
pub const PHRASE_FEATURE_DIM: i64 = 10;

/// Every `MailwomanCoarseEncoder` constructor argument.
#[derive(Clone, Debug, PartialEq)]
pub struct EncoderSpec {
	pub vocab_size: i64,
	pub hidden_size: i64,
	pub num_hidden_layers: i64,
	pub num_attention_heads: i64,
	pub intermediate_size: i64,
	pub max_position_embeddings: i64,
	pub hidden_dropout_prob: f64,
	pub pad_token_id: i64,
	/// The BIO labels in output order; `num_labels` is their count.
	pub id_to_label: Vec<String>,
	pub use_crf: bool,
	pub label_smoothing: f64,
	pub crf_loss_weight: f64,
	pub crf_normalization: String,
	pub crf_fp32: bool,
	/// Per-label cross-entropy weights in output order.
	pub class_weights: Option<Vec<f32>>,
	pub use_phrase_priors: bool,
	pub phrase_feature_dim: i64,
	pub use_locale_conditioning: bool,
	pub num_locales: i64,
	pub locale_loss_weight: f64,
	pub use_postcode_anchor: bool,
	pub anchor_feature_dim: i64,
	pub use_gazetteer_anchor: bool,
	pub gazetteer_feature_dim: i64,
	pub use_country_anchor: bool,
	pub country_feature_dim: i64,
	pub country_ambiguous_scale: f64,
	pub use_street_type_anchor: bool,
	pub street_type_feature_dim: i64,
	pub use_locality_surface_anchor: bool,
	pub locality_surface_feature_dim: i64,
	pub use_code_unit_anchor: bool,
	pub code_unit_feature_dim: i64,
	pub use_conventions_loss_mask: bool,
	pub use_span_boundary_head: bool,
	pub span_boundary_loss_weight: f64,
	pub use_span_scorer: bool,
	pub span_loss_weight: f64,
	pub span_dim: i64,
	pub max_span: i64,
	pub use_char_embed: bool,
	pub char_vocab_size: i64,
	pub char_embed_dim: i64,
	pub char_kernel_sizes: Vec<i64>,
	pub use_address_system_head: bool,
	pub num_address_systems: i64,
	pub address_system_loss_weight: f64,
	pub use_locale_hint: bool,
	pub locale_hint_drop_prob: f64,
	pub locale_hint_noise_prob: f64,
	/// The conventions loss mask's table: for each locale-head class in order, the tags its address system forbids.
	/// The label schema's `conventions_forbidden_tags` supplies it, and `config.json` does not record it, as
	/// `to_config_dict` does not.
	pub conventions: Vec<Vec<String>>,
}

/// What a spec reads from the label schema rather than from a config: the `stage3` labels a checkpoint without
/// `id2label` takes, and the conventions table in locale-head order.
#[derive(Clone, Copy, Debug)]
pub struct SchemaDefaults<'a> {
	pub labels: &'a [String],
	pub conventions: &'a [Vec<String>],
}

fn get<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
	obj.get(key).filter(|v| !v.is_null())
}

/// The model keys of retired features: the affix and dependent-locality heads and the first-token anchor injection.
/// No trained model sets one. A checkpoint config that records one as `false` reads as before, and `true` is refused.
const RETIRED_KEYS: [&str; 3] = ["use_affix_head", "use_deploc_head", "inject_first_token"];

/// Refuses a model section that enables a retired feature.
fn refuse_retired(obj: &Map<String, Value>) -> Result<()> {
	for key in RETIRED_KEYS {
		if bool_or(obj, key, false)? {
			return Err(fail!("model.{key} is a retired feature; no trained model uses it"));
		}
	}
	Ok(())
}

fn bool_or(obj: &Map<String, Value>, key: &str, default: bool) -> Result<bool> {
	match get(obj, key) {
		None => Ok(default),
		Some(v) => v.as_bool().ok_or_else(|| fail!("config {key} is not a boolean: {v}")),
	}
}

fn f64_or(obj: &Map<String, Value>, key: &str, default: f64) -> Result<f64> {
	match get(obj, key) {
		None => Ok(default),
		Some(v) => v.as_f64().ok_or_else(|| fail!("config {key} is not a number: {v}")),
	}
}

fn i64_or(obj: &Map<String, Value>, key: &str, default: i64) -> Result<i64> {
	match get(obj, key) {
		None => Ok(default),
		Some(v) => v.as_i64().ok_or_else(|| fail!("config {key} is not an integer: {v}")),
	}
}

fn i64_req(obj: &Map<String, Value>, key: &str) -> Result<i64> {
	get(obj, key)
		.and_then(Value::as_i64)
		.ok_or_else(|| fail!("config has no integer {key}"))
}

fn str_or(obj: &Map<String, Value>, key: &str, default: &str) -> Result<String> {
	match get(obj, key) {
		None => Ok(default.to_owned()),
		Some(v) => v
			.as_str()
			.map(str::to_owned)
			.ok_or_else(|| fail!("config {key} is not a string: {v}")),
	}
}

fn kernel_sizes(obj: &Map<String, Value>) -> Result<Vec<i64>> {
	match get(obj, "char_kernel_sizes") {
		None => Ok(vec![3, 4, 5]),
		Some(v) => v
			.as_array()
			.ok_or_else(|| fail!("config char_kernel_sizes is not a list"))?
			.iter()
			.map(|k| k.as_i64().ok_or_else(|| fail!("config char_kernel_sizes holds {k}")))
			.collect(),
	}
}

/// `class_weights` as a label → weight map, read in output order with weight 1.0 for an absent label.
fn class_weights(obj: &Map<String, Value>, labels: &[String]) -> Result<Option<Vec<f32>>> {
	let Some(v) = get(obj, "class_weights") else {
		return Ok(None);
	};
	let map = v
		.as_object()
		.ok_or_else(|| fail!("config class_weights is not a mapping"))?;
	if map.is_empty() {
		return Ok(None);
	}
	labels
		.iter()
		.map(|label| match map.get(label) {
			None => Ok(1.0f32),
			Some(w) => w
				.as_f64()
				.map(|w| w as f32)
				.ok_or_else(|| fail!("class weight {label} is not a number")),
		})
		.collect::<Result<Vec<f32>>>()
		.map(Some)
}

impl EncoderSpec {
	/// Reads a checkpoint's `config.json`, with `_constructor_kwargs`' defaults. A checkpoint without `id2label`
	/// takes the `stage3` labels of `defaults`.
	pub fn from_checkpoint_config(text: &str, defaults: SchemaDefaults) -> Result<Self> {
		let default_labels = defaults.labels;
		let doc: Value = serde_json::from_str(text)?;
		let obj = doc.as_object().ok_or_else(|| fail!("config.json is not an object"))?;
		refuse_retired(obj)?;
		let num_labels = i64_req(obj, "num_labels")?;
		let id_to_label: Vec<String> = match get(obj, "id2label").and_then(Value::as_object) {
			Some(map) if !map.is_empty() => (0..num_labels)
				.map(|i| {
					map.get(&i.to_string())
						.and_then(Value::as_str)
						.map(str::to_owned)
						.ok_or_else(|| fail!("config id2label has no label {i}"))
				})
				.collect::<Result<_>>()?,
			_ => default_labels.iter().take(num_labels as usize).cloned().collect(),
		};
		if id_to_label.len() as i64 != num_labels {
			return Err(fail!(
				"id_to_label carries {} labels but num_labels={num_labels}",
				id_to_label.len()
			));
		}
		let class_weights = class_weights(obj, &id_to_label)?;
		Ok(Self {
			vocab_size: i64_req(obj, "vocab_size")?,
			hidden_size: i64_req(obj, "hidden_size")?,
			num_hidden_layers: i64_req(obj, "num_hidden_layers")?,
			num_attention_heads: i64_req(obj, "num_attention_heads")?,
			intermediate_size: i64_req(obj, "intermediate_size")?,
			max_position_embeddings: i64_req(obj, "max_position_embeddings")?,
			hidden_dropout_prob: f64_or(obj, "hidden_dropout_prob", f64::NAN)?,
			pad_token_id: i64_req(obj, "pad_token_id")?,
			use_crf: bool_or(obj, "use_crf", false)?,
			label_smoothing: f64_or(obj, "label_smoothing", 0.0)?,
			crf_loss_weight: f64_or(obj, "crf_loss_weight", 0.1)?,
			crf_normalization: str_or(obj, "crf_normalization", "per_sequence")?,
			crf_fp32: bool_or(obj, "crf_fp32", false)?,
			class_weights,
			use_phrase_priors: bool_or(obj, "use_phrase_priors", false)?,
			phrase_feature_dim: i64_or(obj, "phrase_feature_dim", PHRASE_FEATURE_DIM)?,
			use_locale_conditioning: bool_or(obj, "use_locale_conditioning", false)?,
			num_locales: i64_or(obj, "num_locales", 9)?,
			locale_loss_weight: f64_or(obj, "locale_loss_weight", 0.0)?,
			use_postcode_anchor: bool_or(obj, "use_postcode_anchor", false)?,
			anchor_feature_dim: i64_or(obj, "anchor_feature_dim", 9 + 2)?,
			use_gazetteer_anchor: bool_or(obj, "use_gazetteer_anchor", false)?,
			gazetteer_feature_dim: i64_or(obj, "gazetteer_feature_dim", 5)?,
			use_country_anchor: bool_or(obj, "use_country_anchor", false)?,
			country_feature_dim: i64_or(obj, "country_feature_dim", 2)?,
			country_ambiguous_scale: f64_or(obj, "country_ambiguous_scale", 1.0)?,
			use_street_type_anchor: bool_or(obj, "use_street_type_anchor", false)?,
			street_type_feature_dim: i64_or(obj, "street_type_feature_dim", 1)?,
			use_locality_surface_anchor: bool_or(obj, "use_locality_surface_anchor", false)?,
			locality_surface_feature_dim: i64_or(obj, "locality_surface_feature_dim", 2)?,
			use_code_unit_anchor: bool_or(obj, "use_code_unit_anchor", false)?,
			code_unit_feature_dim: i64_or(obj, "code_unit_feature_dim", 5)?,
			use_conventions_loss_mask: bool_or(obj, "use_conventions_loss_mask", false)?,
			use_span_boundary_head: bool_or(obj, "use_span_boundary_head", false)?,
			span_boundary_loss_weight: f64_or(obj, "span_boundary_loss_weight", 0.0)?,
			use_span_scorer: bool_or(obj, "use_span_scorer", false)?,
			span_loss_weight: f64_or(obj, "span_loss_weight", 0.0)?,
			span_dim: i64_or(obj, "span_dim", 128)?,
			max_span: i64_or(obj, "max_span", 8)?,
			use_char_embed: bool_or(obj, "use_char_embed", false)?,
			char_vocab_size: i64_or(obj, "char_vocab_size", 0)?,
			char_embed_dim: i64_or(obj, "char_embed_dim", 64)?,
			char_kernel_sizes: kernel_sizes(obj)?,
			use_address_system_head: bool_or(obj, "use_address_system_head", false)?,
			num_address_systems: i64_or(obj, "num_address_systems", 0)?,
			address_system_loss_weight: f64_or(obj, "address_system_loss_weight", 0.0)?,
			use_locale_hint: bool_or(obj, "use_locale_hint", false)?,
			locale_hint_drop_prob: f64_or(obj, "locale_hint_drop_prob", 0.5)?,
			locale_hint_noise_prob: f64_or(obj, "locale_hint_noise_prob", 0.05)?,
			conventions: defaults.conventions.to_vec(),
			id_to_label,
		})
		.and_then(Self::checked)
	}

	/// Builds the spec `build_model` builds from a training config's `model` section, with its defaults.
	///
	/// `labels` is the config's label set, `num_locales` the locale-head width, `num_address_systems` the
	/// registry's id count, which `build_model` reads from the registry rather than the config, and `conventions` the
	/// label schema's conventions table in locale-head order.
	#[allow(clippy::too_many_arguments)]
	pub fn from_model_section(
		model: &Map<String, Value>,
		vocab_size: i64,
		pad_token_id: i64,
		char_vocab_size: i64,
		labels: &[String],
		label_set: &str,
		num_locales: i64,
		num_address_systems: i64,
		conventions: &[Vec<String>],
	) -> Result<Self> {
		refuse_retired(model)?;
		if label_set != "stage3" {
			for flag in ["use_conventions_loss_mask", "use_span_boundary_head", "use_span_scorer"] {
				if bool_or(model, flag, false)? {
					return Err(fail!("model.{flag} is not supported with data.label_set={label_set:?}"));
				}
			}
		}
		let req = |key: &str| i64_req(model, key);
		let address_head = bool_or(model, "use_address_system_head", false)?;
		let locale_hint = bool_or(model, "use_locale_hint", false)?;
		Ok(Self {
			vocab_size,
			hidden_size: req("hidden_size")?,
			num_hidden_layers: req("num_hidden_layers")?,
			num_attention_heads: req("num_attention_heads")?,
			intermediate_size: req("intermediate_size")?,
			max_position_embeddings: req("max_position_embeddings")?,
			hidden_dropout_prob: get(model, "hidden_dropout_prob")
				.and_then(Value::as_f64)
				.ok_or_else(|| fail!("config has no model.hidden_dropout_prob"))?,
			pad_token_id,
			id_to_label: labels.to_vec(),
			use_crf: bool_or(model, "use_crf", true)?,
			label_smoothing: f64_or(model, "label_smoothing", 0.1)?,
			crf_loss_weight: f64_or(model, "crf_loss_weight", 0.1)?,
			crf_normalization: str_or(model, "crf_normalization", "per_sequence")?,
			crf_fp32: bool_or(model, "crf_fp32", false)?,
			class_weights: class_weights(model, labels)?,
			use_phrase_priors: bool_or(model, "use_phrase_priors", false)?,
			phrase_feature_dim: i64_or(model, "phrase_feature_dim", PHRASE_FEATURE_DIM)?,
			use_locale_conditioning: bool_or(model, "use_locale_conditioning", false)?,
			num_locales,
			locale_loss_weight: f64_or(model, "locale_loss_weight", 0.0)?,
			use_postcode_anchor: bool_or(model, "use_postcode_anchor", false)?,
			anchor_feature_dim: num_locales + 2,
			use_gazetteer_anchor: bool_or(model, "use_gazetteer_anchor", false)?,
			gazetteer_feature_dim: i64_or(model, "gazetteer_feature_dim", 5)?,
			use_country_anchor: bool_or(model, "use_country_anchor", false)?,
			country_feature_dim: i64_or(model, "country_feature_dim", 2)?,
			country_ambiguous_scale: f64_or(model, "country_ambiguous_scale", 1.0)?,
			use_street_type_anchor: bool_or(model, "use_street_type_anchor", false)?,
			street_type_feature_dim: i64_or(model, "street_type_feature_dim", 1)?,
			use_locality_surface_anchor: bool_or(model, "use_locality_surface_anchor", false)?,
			locality_surface_feature_dim: i64_or(model, "locality_surface_feature_dim", 2)?,
			use_code_unit_anchor: bool_or(model, "use_code_unit_anchor", false)?,
			code_unit_feature_dim: i64_or(model, "code_unit_feature_dim", 5)?,
			use_conventions_loss_mask: bool_or(model, "use_conventions_loss_mask", false)?,
			use_span_boundary_head: bool_or(model, "use_span_boundary_head", false)?,
			span_boundary_loss_weight: f64_or(model, "span_boundary_loss_weight", 0.0)?,
			use_span_scorer: bool_or(model, "use_span_scorer", false)?,
			span_loss_weight: f64_or(model, "span_loss_weight", 0.0)?,
			span_dim: i64_or(model, "span_dim", 128)?,
			max_span: i64_or(model, "max_span", 8)?,
			use_char_embed: bool_or(model, "use_char_embed", false)?,
			char_vocab_size,
			char_embed_dim: i64_or(model, "char_embed_dim", 64)?,
			char_kernel_sizes: kernel_sizes(model)?,
			use_address_system_head: address_head,
			num_address_systems: if address_head || locale_hint {
				num_address_systems
			} else {
				0
			},
			address_system_loss_weight: f64_or(model, "address_system_loss_weight", 0.0)?,
			use_locale_hint: locale_hint,
			locale_hint_drop_prob: f64_or(model, "locale_hint_drop_prob", 0.5)?,
			locale_hint_noise_prob: f64_or(model, "locale_hint_noise_prob", 0.05)?,
			conventions: conventions.to_vec(),
		})
		.and_then(Self::checked)
	}

	fn checked(self) -> Result<Self> {
		if self.crf_normalization != "per_sequence" && self.crf_normalization != "per_token" {
			return Err(fail!(
				"crf_normalization must be 'per_sequence' or 'per_token', got {:?}",
				self.crf_normalization
			));
		}
		if self.use_span_scorer && (self.max_span < 1 || self.span_dim < 1) {
			return Err(fail!(
				"the span scorer needs max_span >= 1 and span_dim >= 1, got {} and {}",
				self.max_span,
				self.span_dim
			));
		}
		if self.use_char_embed && self.char_vocab_size <= 0 {
			return Err(fail!("use_char_embed=True requires char_vocab_size > 0"));
		}
		if (self.use_address_system_head || self.use_locale_hint) && self.num_address_systems < 1 {
			return Err(fail!(
				"the address-system head and the locale hint need a registry with at least one system"
			));
		}
		if let Some(w) = &self.class_weights {
			if w.len() != self.id_to_label.len() {
				return Err(fail!(
					"class_weights has {} entries for {} labels",
					w.len(),
					self.id_to_label.len()
				));
			}
		}
		Ok(self)
	}

	pub fn num_labels(&self) -> i64 {
		self.id_to_label.len() as i64
	}

	/// The width each channel reads, `0` when it is off: what the constructor records.
	pub fn channel_dims(&self) -> [i64; 6] {
		let dim = |on: bool, d: i64| if on { d } else { 0 };
		[
			dim(self.use_postcode_anchor, self.anchor_feature_dim),
			dim(self.use_gazetteer_anchor, self.gazetteer_feature_dim),
			dim(self.use_country_anchor, self.country_feature_dim),
			dim(self.use_street_type_anchor, self.street_type_feature_dim),
			dim(self.use_locality_surface_anchor, self.locality_surface_feature_dim),
			dim(self.use_code_unit_anchor, self.code_unit_feature_dim),
		]
	}

	/// `to_config_dict`: the `config.json` a checkpoint carries.
	pub fn to_config_json(&self) -> Value {
		let dims = self.channel_dims();
		let phrase_dim = if self.use_phrase_priors {
			self.phrase_feature_dim
		} else {
			0
		};
		let class_weights = self.class_weights.as_ref().map(|w| {
			Value::Object(
				self.id_to_label
					.iter()
					.zip(w)
					.map(|(label, &w)| (label.clone(), json!(f64::from(w))))
					.collect(),
			)
		});
		let id2label: Map<String, Value> = self
			.id_to_label
			.iter()
			.enumerate()
			.map(|(i, l)| (i.to_string(), json!(l)))
			.collect();
		let label2id: Map<String, Value> = self
			.id_to_label
			.iter()
			.enumerate()
			.map(|(i, l)| (l.clone(), json!(i)))
			.collect();
		json!({
			"model_type": "mailwoman-coarse-encoder",
			"vocab_size": self.vocab_size,
			"hidden_size": self.hidden_size,
			"num_hidden_layers": self.num_hidden_layers,
			"num_attention_heads": self.num_attention_heads,
			"intermediate_size": self.intermediate_size,
			"max_position_embeddings": self.max_position_embeddings,
			"hidden_dropout_prob": self.hidden_dropout_prob,
			"num_labels": self.num_labels(),
			"pad_token_id": self.pad_token_id,
			"use_crf": self.use_crf,
			"label_smoothing": self.label_smoothing,
			"crf_loss_weight": self.crf_loss_weight,
			"crf_normalization": self.crf_normalization,
			"class_weights": class_weights,
			"use_phrase_priors": self.use_phrase_priors,
			"phrase_feature_dim": phrase_dim,
			"use_locale_conditioning": self.use_locale_conditioning,
			"num_locales": self.num_locales,
			"locale_loss_weight": self.locale_loss_weight,
			"use_postcode_anchor": self.use_postcode_anchor,
			"anchor_feature_dim": dims[0],
			"use_gazetteer_anchor": self.use_gazetteer_anchor,
			"gazetteer_feature_dim": dims[1],
			"use_country_anchor": self.use_country_anchor,
			"country_feature_dim": dims[2],
			"use_street_type_anchor": self.use_street_type_anchor,
			"street_type_feature_dim": dims[3],
			"use_locality_surface_anchor": self.use_locality_surface_anchor,
			"locality_surface_feature_dim": dims[4],
			"use_code_unit_anchor": self.use_code_unit_anchor,
			"code_unit_feature_dim": dims[5],
			"country_ambiguous_scale": self.country_ambiguous_scale,
			"use_conventions_loss_mask": self.use_conventions_loss_mask,
			"use_span_boundary_head": self.use_span_boundary_head,
			"span_boundary_loss_weight": self.span_boundary_loss_weight,
			"use_span_scorer": self.use_span_scorer,
			"span_loss_weight": self.span_loss_weight,
			"span_dim": if self.use_span_scorer { self.span_dim } else { 128 },
			"max_span": if self.use_span_scorer { self.max_span } else { 8 },
			"use_char_embed": self.use_char_embed,
			"char_vocab_size": self.char_vocab_size,
			"char_embed_dim": self.char_embed_dim,
			"char_kernel_sizes": self.char_kernel_sizes,
			"use_address_system_head": self.use_address_system_head,
			"num_address_systems": self.num_address_systems,
			"address_system_loss_weight": self.address_system_loss_weight,
			"use_locale_hint": self.use_locale_hint,
			"locale_hint_drop_prob": self.locale_hint_drop_prob,
			"locale_hint_noise_prob": self.locale_hint_noise_prob,
			"id2label": id2label,
			"label2id": label2id,
		})
	}
}
