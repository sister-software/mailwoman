// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The character path (#825): rows encoded as per-unit character windows for the CharCNN front end.
//!
//! A unit is anything that carries one BIO label: a whitespace token in `word` mode, or one character in `char`
//! mode. Slot `j` of unit `(b, e)` holds `raw[b - ctx + j]`, PAD outside the text or at and past `e + ctx`, and UNK
//! for a character the vocabulary lacks. A row is truncated to `max_units` units and padded with all-PAD units whose
//! attention is 0 and label is the ignore index. Each unit takes the label of its first non-space character, built
//! from the span triple and collapsed to the label set; a span-schema row is required, because a token-only row's
//! labels are quantized to whitespace tokens.

use crate::augment::splice::token_spans;
use crate::config::CharConfig;
use crate::error::{quote, Error, Result};
use crate::row::Row;
use mtf_channels::label_schema::{LabelSchema, LabelSet};
use mtf_channels::labels::Spans;
use mtf_channels::python_text::is_space;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

pub const PAD_CHAR_ID: i64 = 0;
pub const UNK_CHAR_ID: i64 = 1;

/// The character vocabulary: each single character's id. The `<pad>` and `<unk>` entries name no character.
pub fn load_char_vocab(path: &Path) -> Result<HashMap<char, i64>> {
	let text =
		std::fs::read_to_string(path).map_err(|e| Error::Input(format!("char vocab {}: {e}", path.display())))?;
	let doc: Value =
		serde_json::from_str(&text).map_err(|e| Error::Input(format!("char vocab {}: {e}", path.display())))?;
	let map = doc
		.as_object()
		.ok_or_else(|| Error::Input(format!("char vocab {} is not a dict[str, int]", path.display())))?;
	let mut out = HashMap::with_capacity(map.len());
	for (key, value) in map {
		let id = value
			.as_i64()
			.ok_or_else(|| Error::Input(format!("char vocab {} is not a dict[str, int]", path.display())))?;
		let mut chars = key.chars();
		if let (Some(c), None) = (chars.next(), chars.next()) {
			out.insert(c, id);
		}
	}
	Ok(out)
}

/// The character path's encoder for one run.
pub struct CharEncoder {
	pub mode: CharMode,
	pub vocab: HashMap<char, i64>,
	pub max_units: usize,
	pub max_unit_width: usize,
	pub ctx: usize,
	/// `(B id, I id)` per tag of the label set.
	tag_ids: HashMap<String, (i64, i64)>,
	outside: i64,
	ignore_index: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharMode {
	Word,
	Char,
}

/// One batch on the character path, row-major: `char_ids` is `[rows, max_units, max_unit_width]`, and
/// `attention_mask` and `labels` are `[rows, max_units]`.
pub struct CharBatch {
	pub rows: usize,
	pub max_units: usize,
	pub max_unit_width: usize,
	pub char_ids: Vec<i64>,
	pub attention_mask: Vec<i64>,
	pub labels: Vec<i64>,
}

impl CharEncoder {
	/// Builds the encoder over `config.label_set` of `schema`, refusing a window narrower than `char` mode's context
	/// needs.
	pub fn new(config: &CharConfig, schema: &LabelSchema) -> Result<Self> {
		Self::with_label_set(config, schema.set(&config.label_set)?, schema.ignore_index)
	}

	/// Builds the encoder over a label set given directly.
	pub fn with_label_set(config: &CharConfig, set: &LabelSet, ignore_index: i64) -> Result<Self> {
		let mode = match config.mode.as_str() {
			"word" => CharMode::Word,
			"char" => CharMode::Char,
			other => {
				return Err(Error::Input(format!(
					"unknown data.char_mode {other:?} (expected off | word | char)"
				)))
			}
		};
		if mode == CharMode::Char && config.max_unit_width < 2 * config.char_ctx + 1 {
			return Err(Error::Input(format!(
				"data.max_unit_width={} truncates the char window: char_mode=char with char_ctx={} needs W >= {}",
				config.max_unit_width,
				config.char_ctx,
				2 * config.char_ctx + 1
			)));
		}
		let id = |label: &str| set.bio_labels.iter().position(|l| l == label).map(|i| i as i64);
		let tag_ids = set
			.tags
			.iter()
			.map(|tag| {
				let ids = (id(&format!("B-{tag}")), id(&format!("I-{tag}")));
				match ids {
					(Some(b), Some(i)) => Ok((tag.clone(), (b, i))),
					_ => Err(Error::Input(format!(
						"label set {:?} lacks the labels of {tag:?}",
						config.label_set
					))),
				}
			})
			.collect::<Result<HashMap<_, _>>>()?;
		Ok(Self {
			mode,
			vocab: load_char_vocab(&config.vocab_path)?,
			max_units: config.max_units,
			max_unit_width: config.max_unit_width,
			ctx: config.char_ctx,
			tag_ids,
			outside: id("O").ok_or_else(|| Error::Input("the label set has no O label".into()))?,
			ignore_index,
		})
	}

	/// One row's `(char_ids, attention, labels)`, each fitted to `max_units`.
	pub fn encode_row(&self, row: &Row) -> Result<(Vec<i64>, Vec<i64>, Vec<i64>)> {
		let Some(spans) = row.encoder_spans() else {
			return Err(Error::Row(format!(
				"data.char_mode={} requires span-schema parquet files (v0.5.0 #519); got a token-only row: {}",
				if self.mode == CharMode::Char { "char" } else { "word" },
				quote(&row.raw.chars().take(60).collect::<String>())
			)));
		};
		let raw = row.chars();
		let char_labels = self.char_labels(&raw, &spans)?;
		let units: Vec<(usize, usize)> = match self.mode {
			CharMode::Char => (0..raw.len()).map(|i| (i, i + 1)).collect(),
			CharMode::Word => token_spans(&raw, &row.tokens)?,
		};
		let w = self.max_unit_width;
		let mut char_ids = Vec::with_capacity(self.max_units * w);
		let mut labels = Vec::with_capacity(self.max_units);
		for &(begin, end) in units.iter().take(self.max_units) {
			for j in 0..w {
				let p = begin as i64 - self.ctx as i64 + j as i64;
				let id = if p >= 0 && (p as usize) < raw.len() && (p as usize) < end + self.ctx {
					self.vocab.get(&raw[p as usize]).copied().unwrap_or(UNK_CHAR_ID)
				} else {
					PAD_CHAR_ID
				};
				char_ids.push(id);
			}
			let first = (begin..end.min(raw.len())).find(|&p| !is_space(raw[p]));
			labels.push(match first.and_then(|p| char_labels.get(p).copied().flatten()) {
				Some((tag, begins)) => {
					let (b, i) = self.tag_ids[tag];
					if begins {
						b
					} else {
						i
					}
				}
				None => self.outside,
			});
		}
		let used = labels.len();
		let mut attention = vec![1i64; used];
		char_ids.resize(self.max_units * w, PAD_CHAR_ID);
		attention.resize(self.max_units, 0);
		labels.resize(self.max_units, self.ignore_index);
		Ok((char_ids, attention, labels))
	}

	/// Each character's `(tag, is B-)` from the validated span triple, `None` for `O` or a tag outside the set.
	fn char_labels<'a>(&'a self, raw: &[char], spans: &'a Spans) -> Result<Vec<Option<(&'a str, bool)>>> {
		let ranges = spans.validated(raw)?;
		let mut out = vec![None; raw.len()];
		for (&(start, end), tag) in ranges.iter().zip(spans.tags) {
			let known = self.tag_ids.get_key_value(tag.as_str()).map(|(k, _)| k.as_str());
			for (offset, slot) in out[start..end].iter_mut().enumerate() {
				*slot = known.map(|k| (k, offset == 0));
			}
		}
		Ok(out)
	}

	/// A batch of rows; an error names the row's batch index.
	pub fn encode_batch(&self, rows: &[Row]) -> Result<CharBatch> {
		let mut batch = CharBatch {
			rows: rows.len(),
			max_units: self.max_units,
			max_unit_width: self.max_unit_width,
			char_ids: Vec::with_capacity(rows.len() * self.max_units * self.max_unit_width),
			attention_mask: Vec::with_capacity(rows.len() * self.max_units),
			labels: Vec::with_capacity(rows.len() * self.max_units),
		};
		for (index, row) in rows.iter().enumerate() {
			let (ids, attention, labels) = self.encode_row(row).map_err(|e| match e {
				Error::Row(m) => Error::Row(format!("row {index}: {m}")),
				other => other,
			})?;
			batch.char_ids.extend(ids);
			batch.attention_mask.extend(attention);
			batch.labels.extend(labels);
		}
		Ok(batch)
	}
}
