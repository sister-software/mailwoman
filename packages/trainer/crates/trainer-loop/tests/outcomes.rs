// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The outcome hint and head (`docs/engineering/reference/outcome-kinds.mdx`) on a small spec: the training term,
//! the "no hint" row, and the export's required `outcome_hint` input and `outcome_logits` output.
//!
//! With `MAILWOMAN_WRITE_OUTCOME_FIXTURE` set to a directory, the export test also writes the graph and the Rust
//! forward's logits there. `packages/neural/lib/onnx/outcome-hint.test.ts` reads that fixture, committed under
//! `packages/neural/test/fixtures/outcome-hint/`.

use prost::Message;
use serde_json::json;
use tch::{Kind, Tensor};
use trainer_export::export::{export_checkpoint, ExportOptions};
use trainer_model::layers::Mode;
use trainer_model::{CoarseEncoder, EncoderInputs, EncoderSpec};

static GENERATOR: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn seeded(seed: i64) -> std::sync::MutexGuard<'static, ()> {
	let guard = GENERATOR.lock().unwrap_or_else(|e| e.into_inner());
	tch::manual_seed(seed);
	guard
}

fn strings(values: &[&str]) -> Vec<String> {
	values.iter().map(|s| (*s).to_owned()).collect()
}

fn spec() -> EncoderSpec {
	let model = json!({
		"hidden_size": 16, "num_hidden_layers": 1, "num_attention_heads": 2, "intermediate_size": 32,
		"max_position_embeddings": 8, "hidden_dropout_prob": 0.0, "use_crf": false,
		"use_outcome_hint": true, "outcome_hint_prob": 0.5, "use_outcome_head": true, "outcome_loss_weight": 0.2
	});
	EncoderSpec::from_model_section(
		model.as_object().unwrap(),
		20,
		0,
		0,
		&strings(&["O", "B-locality", "I-locality"]),
		"stage3",
		9,
		0,
		&vec![Vec::new(); 9],
	)
	.unwrap()
	.with_outcome_classes(
		&strings(&[
			"address",
			"address.street",
			"place",
			"postal",
			"natural",
			"venue",
			"transit",
		]),
		&strings(&["address", "place", "postal", "natural", "venue", "transit"]),
		&json!({"revision": null, "sha256": null}),
	)
	.unwrap()
}

fn inputs() -> EncoderInputs {
	EncoderInputs {
		input_ids: Some(Tensor::from_slice(&[3i64, 4, 5, 0, 7, 8, 9, 10]).view([2, 4])),
		attention_mask: Some(Tensor::from_slice(&[1i64, 1, 1, 0, 1, 1, 1, 1]).view([2, 4])),
		..EncoderInputs::default()
	}
}

/// A model whose hint table and head are drawn at random, so "no hint" and a hint give different outputs.
fn randomized() -> CoarseEncoder {
	let mut model = CoarseEncoder::new(spec()).unwrap();
	tch::no_grad(|| {
		for (name, mut p) in model.store.parameters() {
			if name.starts_with("outcome_hint_embedding") {
				let _ = p.copy_(&Tensor::randn_like(&p));
			}
		}
	});
	model.mode = Mode::Eval;
	model
}

#[test]
fn a_row_with_a_reading_adds_the_weighted_intent_term() {
	let _guard = seeded(1);
	let model = CoarseEncoder::new(spec()).unwrap();
	let mut inputs = inputs();
	inputs.labels = Some(Tensor::from_slice(&[0i64, 1, 2, -100, 0, 0, 1, 2]).view([2, 4]));
	inputs.outcome_ids = Some(Tensor::from_slice(&[1i64, -100]));
	let output = model.forward(&inputs).unwrap();
	let term = output
		.terms
		.iter()
		.find(|(n, _)| *n == "outcome")
		.expect("the outcome term");
	let logits = output.outcome_logits.as_ref().unwrap();
	assert_eq!(logits.size(), [2, 6]);
	// The masked row gives zero signal: the term is the first row's cross-entropy alone.
	let expected = -logits.get(0).log_softmax(-1, Kind::Float).double_value(&[1]);
	assert!((term.1.double_value(&[]) - expected).abs() < 1e-6);

	inputs.outcome_ids = Some(Tensor::from_slice(&[-100i64, -100]));
	let output = model.forward(&inputs).unwrap();
	assert!(
		output.terms.iter().all(|(n, _)| *n != "outcome"),
		"an all-masked batch adds no term"
	);
}

#[test]
fn minus_one_reads_the_no_hint_row() {
	let _guard = seeded(2);
	let model = randomized();
	let run = |hint: Option<i64>| {
		let mut inputs = inputs();
		inputs.outcome_hint_ids = hint.map(|h| Tensor::from_slice(&[h, h]));
		tch::no_grad(|| model.forward(&inputs)).unwrap()
	};
	let (absent, minus_one, no_hint, place) = (run(None), run(Some(-1)), run(Some(7)), run(Some(2)));
	assert!(absent.logits.equal(&minus_one.logits));
	assert!(absent.logits.equal(&no_hint.logits));
	assert!(!absent.logits.allclose(&place.logits, 1e-6, 1e-6, false));
}

#[test]
fn the_export_declares_a_required_hint_and_the_head_as_the_last_output() {
	let _guard = seeded(3);
	let model = randomized();
	let dir = tempfile::tempdir().unwrap();
	trainer_model::checkpoint::write_model(dir.path(), &model.store, &model.spec).unwrap();
	let onnx = export_checkpoint(dir.path(), &ExportOptions::default()).unwrap();
	let graph = onnx.graph.as_ref().unwrap();
	assert!(graph.input.iter().any(|i| i.name.as_deref() == Some("outcome_hint")));
	// The input is required: no initializer stands in for it, so a runtime that feeds none fails loudly.
	assert!(graph
		.initializer
		.iter()
		.all(|t| t.name.as_deref() != Some("outcome_hint")));
	assert_eq!(graph.output.last().unwrap().name.as_deref(), Some("outcome_logits"));

	let Some(out) = std::env::var_os("MAILWOMAN_WRITE_OUTCOME_FIXTURE") else {
		return;
	};
	let out = std::path::PathBuf::from(out);
	std::fs::create_dir_all(&out).unwrap();
	std::fs::write(out.join("model.onnx"), onnx.encode_to_vec()).unwrap();
	let values = |t: &Tensor| Vec::<f32>::try_from(t.to_kind(Kind::Float).contiguous().view([-1])).unwrap();
	let mut cases = Vec::new();
	for hint in [-1i64, 2] {
		let mut inputs = inputs();
		inputs.input_ids = Some(inputs.input_ids.unwrap().narrow(0, 0, 1));
		inputs.attention_mask = Some(inputs.attention_mask.unwrap().narrow(0, 0, 1));
		inputs.outcome_hint_ids = Some(Tensor::from_slice(&[hint]));
		let output = tch::no_grad(|| model.forward(&inputs)).unwrap();
		cases.push(json!({
			"outcome_hint": hint,
			"logits": values(&output.logits),
			"outcome_logits": values(output.outcome_logits.as_ref().unwrap()),
		}));
	}
	let fixture = json!({
		"input_ids": [3, 4, 5, 0],
		"attention_mask": [1, 1, 1, 0],
		"hint_classes": model.spec.outcome_hint_classes,
		"head_classes": model.spec.outcome_head_classes,
		"cases": cases,
	});
	std::fs::write(
		out.join("expected.json"),
		serde_json::to_string_pretty(&fixture).unwrap() + "\n",
	)
	.unwrap();
}
