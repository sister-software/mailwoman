//! The export's check against the model: the Rust forward pass on recorded batches, written as ONNX feeds with
//! their expected outputs.
//!
//! `corpus-python`'s `verify_parity` runs the torch model and the exported graph on the same inputs. Here the Rust
//! encoder computes the expected outputs, one row per probe in eval mode, and
//! `packages/neural/tools/onnx-model-check.run.ts` runs the feeds through the graph `trainer-export` wrote and compares
//! every element. Every other probe passes the row's own address system as `locale_hint`, the rest the "no hint" id.
//! A char-path checkpoint's probes feed the record's `char_ids` in place of `input_ids`. A span-scorer checkpoint's
//! probes also expect its `span_scores`.

use crate::batch::TensorBatch;
use crate::compare::Record;
use crate::{fail, Result};
use serde_json::{json, Map, Value};
use std::path::Path;
use tch::{Kind, Tensor};
use trainer_model::encoder::IGNORE_INDEX;
use trainer_model::layers::Mode;
use trainer_model::{CoarseEncoder, SchemaDefaults};

fn values_f32(t: &Tensor) -> Result<Vec<f32>> {
	Ok(Vec::<f32>::try_from(t.to_kind(Kind::Float).contiguous().view([-1]))?)
}

fn values_i64(t: &Tensor) -> Result<Vec<i64>> {
	Ok(Vec::<i64>::try_from(t.to_kind(Kind::Int64).contiguous().view([-1]))?)
}

fn feed(name: &str, t: &Tensor) -> Result<(String, Value)> {
	let dims = t.size();
	let value = if t.kind() == Kind::Int64 {
		json!({"type": "int64", "dims": dims, "data": values_i64(t)?})
	} else {
		json!({"type": "float32", "dims": dims, "data": values_f32(t)?})
	};
	Ok((name.to_owned(), value))
}

/// Writes up to `rows` probes from the record's batches to `out`.
pub fn write_feeds(
	checkpoint: &Path,
	record: &Path,
	out: &Path,
	rows: usize,
	defaults: SchemaDefaults,
) -> Result<usize> {
	let mut model = CoarseEncoder::from_pretrained(checkpoint, defaults)?;
	model.mode = Mode::Eval;
	let record = Record::read(record)?;
	let systems = model.spec.num_address_systems;
	let mut probes = Vec::new();
	let mut b = 0;
	while probes.len() < rows {
		let prefix = format!("batch{b}.");
		if !record.has(&format!("{prefix}input_ids")) {
			break;
		}
		let batch = TensorBatch::from_named(|k| {
			let key = format!("{prefix}{k}");
			record
				.has(&key)
				.then(|| record.get(&key).expect("checked").shallow_clone())
		})?;
		for r in 0..batch.rows() {
			if probes.len() >= rows {
				break;
			}
			let one = |t: &Tensor| t.narrow(0, r, 1).copy();
			let row = TensorBatch {
				input_ids: one(&batch.input_ids),
				attention_mask: one(&batch.attention_mask),
				labels: one(&batch.labels),
				locale_ids: one(&batch.locale_ids),
				address_system_ids: one(&batch.address_system_ids),
				channels: batch
					.channels
					.iter()
					.map(|(n, f, c)| (n.clone(), one(f), one(c)))
					.collect(),
				char_ids: batch.char_ids.as_ref().map(one),
			};
			if model.spec.use_char_embed && row.char_ids.is_none() {
				return Err(fail!(
					"the record's batches hold no char_ids for a char-path checkpoint"
				));
			}
			let own = row.address_system_ids.int64_value(&[0]);
			let hint = if probes.len() % 2 == 1 && own != IGNORE_INDEX {
				own
			} else {
				systems
			};
			let hint = Tensor::from_slice(&[hint]);
			let mut inputs = row.inputs();
			inputs.labels = None;
			inputs.locale_ids = None;
			inputs.address_system_ids = None;
			if model.spec.use_locale_hint {
				inputs.locale_hint_ids = Some(hint.shallow_clone());
			}
			let output = tch::no_grad(|| model.forward(&inputs))?;
			let mut feeds = Map::new();
			// The char graph declares `char_ids` in place of `input_ids`.
			let units = match (&row.char_ids, model.spec.use_char_embed) {
				(Some(chars), true) => feed("char_ids", chars)?,
				_ => feed("input_ids", &row.input_ids)?,
			};
			for (k, v) in [units, feed("attention_mask", &row.attention_mask)?] {
				feeds.insert(k, v);
			}
			for (name, f, c) in &row.channels {
				let (k, v) = feed(&format!("{name}_features"), f)?;
				feeds.insert(k, v);
				let (k, v) = feed(&format!("{name}_confidence"), c)?;
				feeds.insert(k, v);
			}
			if model.spec.use_locale_hint {
				let (k, v) = feed("locale_hint", &hint)?;
				feeds.insert(k, v);
			}
			let mut expected = Map::new();
			let (k, v) = feed("logits", &output.logits)?;
			expected.insert(k, v);
			if let Some(l) = &output.locale_logits {
				let (k, v) = feed("locale_logits", l)?;
				expected.insert(k, v);
			}
			if let Some(l) = &output.address_system_logits {
				let (k, v) = feed("address_system_logits", l)?;
				expected.insert(k, v);
			}
			if let Some(s) = &output.span_scores {
				let (k, v) = feed("span_scores", s)?;
				expected.insert(k, v);
			}
			probes.push(json!({"feeds": feeds, "expected": expected}));
		}
		b += 1;
	}
	if probes.is_empty() {
		return Err(fail!("the record holds no batches"));
	}
	let n = probes.len();
	std::fs::write(
		out,
		serde_json::to_string(&json!({"checkpoint": checkpoint.display().to_string(), "probes": probes}))?,
	)?;
	Ok(n)
}
