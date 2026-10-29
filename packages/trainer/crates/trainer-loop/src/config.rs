//! The resolved training config `mailwoman train config resolve` writes, and what the trainer builds from it.
//!
//! The TypeScript resolver applies every default the Python loader applies, so the trainer reads each field as
//! present and refuses a missing one rather than supplying a second default. The paths the resolver keeps are the
//! config's own. A volume path (`/data/...`) is read through `MAILWOMAN_DATA_ROOT` by the sampler, as the Python
//! loader reads it.

use crate::{fail, Result};
use mtf_sampler::{AugmentProbabilities, CharConfig, RunLength, SamplerConfig, Weights};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// The resolved-config layout version this reader reads.
pub const RESOLVED_CONFIG_VERSION: u64 = 1;

/// The augmentations, by the name `DataConfig` gives each `augment_<name>_prob`.
const AUGMENTATIONS: [&str; 9] = [
	"directional",
	"region",
	"glue",
	"case",
	"punct_drop",
	"upper_case",
	"ordinal",
	"postcode_move",
	"grouping",
];

/// The resolved document's sections.
#[derive(Clone, Debug)]
pub struct RunConfig {
	pub path: PathBuf,
	pub config_path: String,
	pub config_sha256: String,
	pub data: Map<String, Value>,
	pub model: Map<String, Value>,
	pub train: Map<String, Value>,
	/// The whole `config` object, which a checkpoint stamps into `training_state.json`.
	pub config: Value,
	pub csv_log_path: PathBuf,
}

fn section(config: &Value, name: &str) -> Result<Map<String, Value>> {
	config
		.get(name)
		.and_then(Value::as_object)
		.cloned()
		.ok_or_else(|| fail!("the resolved config has no {name} section"))
}

fn field<'a>(map: &'a Map<String, Value>, section: &str, key: &str) -> Result<&'a Value> {
	map.get(key)
		.ok_or_else(|| fail!("the resolved config has no {section}.{key}; re-resolve it with the current resolver"))
}

impl RunConfig {
	pub fn read(path: &Path) -> Result<Self> {
		let text = std::fs::read_to_string(path).map_err(|e| fail!("{}: {e}", path.display()))?;
		let doc: Value = serde_json::from_str(&text)?;
		let version = doc.get("schema_version").and_then(Value::as_u64);
		if version != Some(RESOLVED_CONFIG_VERSION) {
			return Err(fail!(
				"{}: schema_version {version:?}, this trainer reads {RESOLVED_CONFIG_VERSION}",
				path.display()
			));
		}
		let config = doc
			.get("config")
			.cloned()
			.ok_or_else(|| fail!("{}: no config", path.display()))?;
		let csv = doc
			.pointer("/derived/csv_log_path")
			.and_then(Value::as_str)
			.ok_or_else(|| fail!("{}: no derived.csv_log_path", path.display()))?;
		Ok(Self {
			path: path.to_path_buf(),
			config_path: doc["config_path"].as_str().unwrap_or_default().to_owned(),
			config_sha256: doc["config_sha256"].as_str().unwrap_or_default().to_owned(),
			data: section(&config, "data")?,
			model: section(&config, "model")?,
			train: section(&config, "train")?,
			config,
			csv_log_path: PathBuf::from(csv),
		})
	}

	pub fn data_str(&self, key: &str) -> Result<Option<String>> {
		Ok(field(&self.data, "data", key)?
			.as_str()
			.filter(|s| !s.is_empty())
			.map(str::to_owned))
	}

	pub fn data_f64(&self, key: &str) -> Result<f64> {
		field(&self.data, "data", key)?
			.as_f64()
			.ok_or_else(|| fail!("data.{key} is not a number"))
	}

	pub fn data_bool(&self, key: &str) -> Result<bool> {
		field(&self.data, "data", key)?
			.as_bool()
			.ok_or_else(|| fail!("data.{key} is not a boolean"))
	}

	pub fn data_i64(&self, key: &str) -> Result<Option<i64>> {
		let v = field(&self.data, "data", key)?;
		if v.is_null() {
			return Ok(None);
		}
		v.as_i64().map(Some).ok_or_else(|| fail!("data.{key} is not an integer"))
	}

	pub fn train_f64(&self, key: &str) -> Result<f64> {
		field(&self.train, "train", key)?
			.as_f64()
			.ok_or_else(|| fail!("train.{key} is not a number"))
	}

	pub fn train_opt_f64(&self, key: &str) -> Result<Option<f64>> {
		let v = field(&self.train, "train", key)?;
		if v.is_null() {
			return Ok(None);
		}
		v.as_f64().map(Some).ok_or_else(|| fail!("train.{key} is not a number"))
	}

	pub fn train_i64(&self, key: &str) -> Result<i64> {
		field(&self.train, "train", key)?
			.as_i64()
			.ok_or_else(|| fail!("train.{key} is not an integer"))
	}

	pub fn train_opt_i64(&self, key: &str) -> Result<Option<i64>> {
		let v = field(&self.train, "train", key)?;
		if v.is_null() {
			return Ok(None);
		}
		v.as_i64().map(Some).ok_or_else(|| fail!("train.{key} is not an integer"))
	}

	pub fn train_bool(&self, key: &str) -> Result<bool> {
		field(&self.train, "train", key)?
			.as_bool()
			.ok_or_else(|| fail!("train.{key} is not a boolean"))
	}

	pub fn train_str(&self, key: &str) -> Result<String> {
		Ok(field(&self.train, "train", key)?.as_str().unwrap_or_default().to_owned())
	}

	pub fn train_strings(&self, key: &str) -> Result<Vec<String>> {
		field(&self.train, "train", key)?
			.as_array()
			.ok_or_else(|| fail!("train.{key} is not a list"))?
			.iter()
			.map(|v| v.as_str().map(str::to_owned).ok_or_else(|| fail!("train.{key} holds {v}")))
			.collect()
	}

	pub fn output_dir(&self) -> Result<PathBuf> {
		Ok(PathBuf::from(self.train_str("output_dir")?))
	}

	pub fn label_set(&self) -> Result<String> {
		Ok(self.data_str("label_set")?.unwrap_or_else(|| "stage3".to_owned()))
	}

	pub fn char_mode(&self) -> Result<String> {
		Ok(self.data_str("char_mode")?.unwrap_or_else(|| "off".to_owned()))
	}

	/// Overrides one field, `section.key=value` with `value` parsed as JSON (or taken as a string).
	pub fn set(&mut self, assignment: &str) -> Result<()> {
		let (key, value) = assignment
			.split_once('=')
			.ok_or_else(|| fail!("--set expects section.key=value, got {assignment:?}"))?;
		let (name, attr) = key
			.split_once('.')
			.ok_or_else(|| fail!("--set expects section.key=value, got {assignment:?}"))?;
		let parsed: Value = serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned()));
		let target = match name {
			"data" => &mut self.data,
			"model" => &mut self.model,
			"train" => &mut self.train,
			other => return Err(fail!("--set names an unknown section {other:?}")),
		};
		if !target.contains_key(attr) {
			return Err(fail!("--set names {name}.{attr}, which the resolved config does not hold"));
		}
		target.insert(attr.to_owned(), parsed.clone());
		if let Some(section) = self.config.get_mut(name).and_then(Value::as_object_mut) {
			section.insert(attr.to_owned(), parsed);
		}
		if name == "train" && (attr == "output_dir" || attr == "csv_log_path") {
			let template = self.train_str("csv_log_path")?;
			let out = self.train_str("output_dir")?;
			self.csv_log_path = PathBuf::from(template.replace("{output_dir}", &out));
		}
		Ok(())
	}
}

fn weights(value: &Value, what: &str) -> Result<Option<Weights>> {
	if value.is_null() {
		return Ok(None);
	}
	let map = value.as_object().ok_or_else(|| fail!("{what} is not a mapping"))?;
	map.iter()
		.map(|(k, v)| {
			v.as_f64()
				.map(|w| (k.clone(), w))
				.ok_or_else(|| fail!("{what}[{k:?}] is not a number"))
		})
		.collect::<Result<Vec<_>>>()
		.map(|w| Some(Weights(w)))
}

fn env_path(name: &str) -> Option<PathBuf> {
	std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Where the trainer finds its repository data files: the postcode layouts, shapes and syntax, and the
/// address-system registry, which today live in `corpus-python`'s package data.
#[derive(Clone, Debug)]
pub struct DataFiles {
	pub postcode_layouts: PathBuf,
	pub postcode_shapes: PathBuf,
	pub postcode_syntax: PathBuf,
	pub address_systems: PathBuf,
	pub label_schema: PathBuf,
}

impl DataFiles {
	/// The files under a repository checkout at `root`.
	pub fn in_repository(root: &Path) -> Self {
		let package = root.join("corpus-python/src/mailwoman_train");
		Self {
			postcode_layouts: package.join("data/augment/postcode-layouts.json"),
			postcode_shapes: package.join("features/postcode-shapes.json"),
			postcode_syntax: package.join("data/postcode-syntax.json"),
			address_systems: package.join("address_systems.json"),
			label_schema: root.join("packages/neural/data/label-schema.v1.json"),
		}
	}

	/// The repository root: `MAILWOMAN_REPO_ROOT`, or the checkout this crate was built from.
	pub fn discover() -> Self {
		let root = env_path("MAILWOMAN_REPO_ROOT")
			.unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../..")));
		Self::in_repository(&root)
	}
}

/// `encode.sampler_config`: the sampler settings of a run.
pub fn sampler_config(run: &RunConfig, files: &DataFiles, active_tags: &[String]) -> Result<SamplerConfig> {
	let d = &run.data;
	let mut augment = AugmentProbabilities::default();
	for name in AUGMENTATIONS {
		let p = run.data_f64(&format!("augment_{name}_prob"))?;
		match name {
			"directional" => augment.directional = p,
			"region" => augment.region = p,
			"glue" => augment.glue = p,
			"case" => augment.case = p,
			"punct_drop" => augment.punct_drop = p,
			"upper_case" => augment.upper_case = p,
			"ordinal" => augment.ordinal = p,
			"postcode_move" => augment.postcode_move = p,
			_ => augment.grouping = p,
		}
	}
	let char_mode = run.char_mode()?;
	let char = if char_mode == "off" {
		None
	} else {
		if !["word", "char"].contains(&char_mode.as_str()) {
			return Err(fail!("unknown data.char_mode {char_mode:?} (expected off | word | char)"));
		}
		Some(CharConfig {
			mode: char_mode,
			vocab_path: PathBuf::from(
				run.data_str("char_vocab_path")?
					.ok_or_else(|| fail!("data.char_mode requires data.char_vocab_path"))?,
			),
			max_units: run
				.data_i64("max_units")?
				.unwrap_or(run.data_i64("max_length")?.unwrap_or(128)) as usize,
			max_unit_width: run.data_i64("max_unit_width")?.unwrap_or(16) as usize,
			char_ctx: run.data_i64("char_ctx")?.unwrap_or(0) as usize,
			label_set: run.label_set()?,
		})
	};
	let source_reps = weights(field(d, "data", "source_reps")?, "data.source_reps")?;
	let run_length = source_reps.as_ref().map(|_| -> Result<RunLength> {
		Ok(RunLength {
			max_steps: run.train_i64("max_steps")? as u64,
			batch_size: run.train_i64("batch_size")? as u64,
			grad_accum_steps: run.train_i64("grad_accum_steps")?.max(1) as u64,
		})
	});
	Ok(SamplerConfig {
		corpus_dir: PathBuf::from(run.data_str("corpus_dir")?.ok_or_else(|| fail!("data.corpus_dir is empty"))?),
		country_weights: weights(field(d, "data", "country_weights")?, "data.country_weights")?
			.ok_or_else(|| fail!("data.country_weights is null"))?,
		source_weights: weights(field(d, "data", "source_weights")?, "data.source_weights")?,
		source_reps,
		run_length: run_length.transpose()?,
		coarse_filter: run.data_bool("coarse_filter")?,
		active_tags: active_tags.to_vec(),
		augment,
		augment_exclude_sources: field(d, "data", "augment_exclude_sources")?
			.as_array()
			.map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
			.unwrap_or_default(),
		affix_relabel_lexicon_path: run.data_str("affix_relabel_lexicon_path")?.map(PathBuf::from),
		postcode_layouts_path: Some(files.postcode_layouts.clone()),
		shuffle_buffer: 131_072,
		drop_spans: false,
		data_root: env_path("MAILWOMAN_DATA_ROOT"),
		volume_mount: env_path("MAILWOMAN_VOLUME_MOUNT").unwrap_or_else(|| PathBuf::from("/data")),
		sha256_cache_path: env_path("MAILWOMAN_SHA256_CACHE"),
		char,
	})
}
