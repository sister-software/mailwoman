// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The loop's pieces that need no corpus: schedules, checkpoint discovery, the CSV row, the metrics, and the model's
//! construction and save/restore on a small spec.

use std::path::Path;
use tch::{Device, Kind, Tensor};
use trainer_loop::batch::TensorBatch;
use trainer_loop::captured::{bucket_for, length_buckets, write_padded};
use trainer_loop::checkpoint::{checkpoint_dir_name, find_latest_checkpoint, restore_generators, save_checkpoint};
use trainer_loop::metrics::{eval_csv_row, token_f1, Metrics};
use trainer_loop::optim::{build_groups, AdamW};
use trainer_loop::schedules::{LambdaLr, Schedule};
use trainer_loop::supervised::{init_from_checkpoint, LossWindow};
use trainer_model::autocast::Generator;
use trainer_model::layers::Mode;
use trainer_model::{CoarseEncoder, EncoderInputs, EncoderSpec, SchemaDefaults};

/// libtorch's global generator is shared by the test threads, so a test that seeds it holds this lock.
static GENERATOR: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn seeded(seed: i64) -> std::sync::MutexGuard<'static, ()> {
	let guard = GENERATOR.lock().unwrap_or_else(|e| e.into_inner());
	tch::manual_seed(seed);
	guard
}

fn labels() -> Vec<String> {
	let mut out = vec!["O".to_owned()];
	for tag in ["locality", "postcode", "street", "street_prefix", "street_suffix"] {
		out.push(format!("B-{tag}"));
		out.push(format!("I-{tag}"));
	}
	out
}

fn spec() -> EncoderSpec {
	spec_with(12, 0.1)
}

/// The test spec, every head on, with `max_position_embeddings` and `hidden_dropout_prob` given.
fn spec_with(max_position_embeddings: i64, dropout: f64) -> EncoderSpec {
	let model = serde_json::json!({
		"hidden_size": 16, "num_hidden_layers": 2, "num_attention_heads": 2, "intermediate_size": 32,
		"max_position_embeddings": max_position_embeddings, "hidden_dropout_prob": dropout, "use_crf": true,
		"crf_loss_weight": 0.1,
		"use_locale_conditioning": true, "locale_loss_weight": 0.3, "use_postcode_anchor": true,
		"use_span_boundary_head": true, "span_boundary_loss_weight": 0.5,
		"use_address_system_head": true, "address_system_loss_weight": 0.3, "use_locale_hint": true,
		"use_span_scorer": true, "span_loss_weight": 0.5, "span_dim": 8, "max_span": 3,
		"use_conventions_loss_mask": true, "class_weights": {"O": 0.5}
	});
	EncoderSpec::from_model_section(
		model.as_object().unwrap(),
		50,
		0,
		0,
		&labels(),
		"stage3",
		9,
		4,
		&conventions(),
	)
	.unwrap()
}

#[test]
fn a_model_section_enabling_a_retired_head_is_refused() {
	for key in ["use_affix_head", "use_deploc_head", "inject_first_token"] {
		let model = serde_json::json!({
			"hidden_size": 16, "num_hidden_layers": 2, "num_attention_heads": 2, "intermediate_size": 32,
			"max_position_embeddings": 12, "hidden_dropout_prob": 0.1, key: true
		});
		let Err(error) = EncoderSpec::from_model_section(
			model.as_object().unwrap(),
			50,
			0,
			0,
			&labels(),
			"stage3",
			9,
			4,
			&conventions(),
		) else {
			panic!("model.{key} set true was accepted");
		};
		assert!(error.to_string().contains(key), "{error}");
	}
}

/// Locale 1 forbids `street_suffix`, a synthetic row that exercises the mask; the other eight forbid nothing.
fn conventions() -> Vec<Vec<String>> {
	let mut out = vec![Vec::new(); 9];
	out[1] = vec!["street_suffix".to_owned()];
	out
}

fn defaults<'a>(labels: &'a [String], conventions: &'a [Vec<String>]) -> SchemaDefaults<'a> {
	SchemaDefaults { labels, conventions }
}

fn inputs() -> EncoderInputs {
	let ids = Tensor::from_slice(&[3i64, 7, 9, 11, 0, 0, 4, 5, 6, 8, 2, 0]).view([2, 6]);
	let mask = ids.ne(0).to_kind(Kind::Int64);
	let labels = Tensor::from_slice(&[1i64, 2, 3, 0, -100, -100, 5, 6, 7, 8, 0, -100]).view([2, 6]);
	let mut inputs = EncoderInputs {
		input_ids: Some(ids),
		attention_mask: Some(mask),
		labels: Some(labels),
		locale_ids: Some(Tensor::from_slice(&[0i64, -100])),
		address_system_ids: Some(Tensor::from_slice(&[1i64, 3])),
		..EncoderInputs::default()
	};
	inputs.channels[0].features = Some(Tensor::ones([2, 6, 11], (Kind::Float, tch::Device::Cpu)) * 0.1);
	inputs.channels[0].confidence = Some(Tensor::ones([2, 6], (Kind::Float, tch::Device::Cpu)));
	inputs
}

#[test]
fn schedules_follow_the_python_lambdas() {
	let cosine = Schedule::Cosine {
		warmup_steps: 10,
		max_steps: 110,
	};
	assert_eq!(cosine.multiplier(0), 0.0);
	assert_eq!(cosine.multiplier(5), 0.5);
	assert_eq!(cosine.multiplier(10), 1.0);
	assert_eq!(cosine.multiplier(60), 0.5 * (1.0 + (std::f64::consts::PI * 0.5).cos()));
	assert_eq!(cosine.multiplier(500), 0.0);
	let cooldown = Schedule::LinearCooldown {
		cooldown_start: 10,
		max_steps: 20,
	};
	assert_eq!(cooldown.multiplier(10), 1.0);
	assert_eq!(cooldown.multiplier(15), 0.5);
	assert_eq!(Schedule::Constant { warmup_steps: 4 }.multiplier(2), 0.5);
	assert!(Schedule::from_config("linear_cooldown", 1, 2, None).is_err());
}

#[test]
fn metrics_skip_unsupported_tags_and_write_gaps() {
	let bio = labels();
	let m = token_f1(&[1, 2, 0, 3], &[1, 2, 0, -100], &bio);
	assert!((m["f1_tag.locality"] - 1.0).abs() < 1e-6);
	assert_eq!(m["support_tag.street"], 0.0);
	assert!((m["macro_f1"] - 1.0).abs() < 1e-6);
	let mut val = Metrics::new();
	val.insert("val_loss".into(), 1.5);
	val.insert("support_tag.street".into(), 0.0);
	let row = eval_csv_row(7, 1.25, &val, &["street".to_owned()]);
	assert_eq!(row, vec!["7", "1.2", "", "", "1.500000", "0.000000", "", "0"]);
}

#[test]
fn construction_is_deterministic_and_named_as_the_checkpoint_format() {
	let guard = seeded(3);
	let a = CoarseEncoder::new(spec()).unwrap();
	tch::manual_seed(3);
	let b = CoarseEncoder::new(spec()).unwrap();
	drop(guard);
	for ((n, x), (_, y)) in a.store.state_dict().iter().zip(b.store.state_dict()) {
		assert!(x.equal(&y), "{n} differs between two builds from one seed");
	}
	let names: Vec<String> = a.store.parameters().into_iter().map(|(n, _)| n).collect();
	assert_eq!(
		names[0], "anchor_token_embedding",
		"root parameters come before child modules"
	);
	assert!(names.contains(&"blocks.1.attn.out_proj.weight".to_owned()));
	assert_eq!(names.last().unwrap(), "locale_hint_embedding.weight");
	let state: Vec<String> = a.store.state_dict().into_iter().map(|(n, _)| n).collect();
	assert_eq!(state[0], "anchor_token_embedding");
	assert!(state.contains(&"class_weights".to_owned()));
	assert!(state.contains(&"crf.transition_mask".to_owned()));
	assert!(
		!state.contains(&"bio_is_begin".to_owned()),
		"a transient buffer is not checkpointed"
	);
}

#[test]
fn the_realized_stream_holds_every_row_and_is_described_last() {
	use trainer_loop::realized::{realized_paths, RealizedRows};
	let dir = tempfile::tempdir().unwrap();
	let row = |raw: &str, country: Option<&str>, spans: bool| mtf_sampler::Row {
		raw: raw.into(),
		tokens: vec![],
		labels: vec![],
		country: country.map(str::to_owned),
		source: "s".into(),
		source_id: spans.then(|| format!("s-{raw}")),
		spans: spans.then(|| mtf_sampler::SpanTriple {
			starts: vec![0],
			ends: vec![2],
			tags: vec!["street".into()],
		}),
	};
	let mut stream = RealizedRows::create(dir.path(), 7).unwrap();
	stream
		.add(&[row("Rue", Some("FR"), true), row("é", None, false)])
		.unwrap();
	let (rows_path, meta_path) = realized_paths(dir.path(), 7);
	assert!(!meta_path.exists(), "the description is written when the stream closes");
	// A checkpoint writes the consumed count of each retention-table key, `<country>|<tag> -> …`.
	let shapes_path = stream.write_shape_counts(dir.path(), 8).unwrap();
	let shapes: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&shapes_path).unwrap()).unwrap();
	assert_eq!(shapes["shapes"], serde_json::json!({"FR|street": 1}));
	assert_eq!(shapes["counted_to_step"], 8);
	let meta = stream.finish(dir.path(), "/corpus", "stage3", 9).unwrap();
	assert_eq!(meta, meta_path);
	let text = String::from_utf8(zstd::decode_all(std::fs::File::open(&rows_path).unwrap()).unwrap()).unwrap();
	let lines: Vec<serde_json::Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
	assert_eq!(lines[0]["span_tags"], serde_json::json!(["street"]));
	assert_eq!(lines[0]["source"], "s");
	assert_eq!(lines[0]["source_id"], "s-Rue");
	assert_eq!(lines[1]["source_id"], serde_json::Value::Null);
	assert_eq!(lines[1]["country"], serde_json::Value::Null);
	assert_eq!(lines[1]["span_starts"], serde_json::Value::Null);
	let described: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
	assert_eq!(described["row_count"], 2);
	assert_eq!(described["inputs"]["counted_from_step"], "7");
	assert_eq!(described["inputs"]["counted_to_step"], "9");
}

fn run_config(train: serde_json::Value) -> trainer_loop::config::RunConfig {
	let config = serde_json::json!({"data": {}, "model": {}, "train": train});
	trainer_loop::config::RunConfig {
		path: "test.json".into(),
		config_path: String::new(),
		config_sha256: String::new(),
		data: config["data"].as_object().unwrap().clone(),
		model: config["model"].as_object().unwrap().clone(),
		train: config["train"].as_object().unwrap().clone(),
		config,
		csv_log_path: "train_log.csv".into(),
	}
}

#[test]
fn the_retired_parameter_casts_and_trackio_are_refused_by_name() {
	use trainer_loop::supervised::resolve_precision;
	let fp16 = run_config(serde_json::json!({"precision": "fp16", "grad_accum_steps": 1}));
	let error = resolve_precision(&fp16, tch::Device::Cuda(0), false)
		.unwrap_err()
		.to_string();
	assert!(error.contains("retires that cast"), "{error}");
	// The CPU runs fp32 whatever the precision, as the Python trainer does.
	let cpu = resolve_precision(&fp16, tch::Device::Cpu, false).unwrap();
	assert!(cpu.autocast.is_none());
	let bf16 = run_config(serde_json::json!({"precision": "bf16", "grad_accum_steps": 2}));
	let cuda = resolve_precision(&bf16, tch::Device::Cuda(0), false).unwrap();
	assert_eq!((cuda.autocast, cuda.accum), (Some(Kind::BFloat16), 2));
	let trackio = run_config(serde_json::json!({"trackio_enabled": true}));
	let error = trainer_loop::callbacks::refuse_trackio(&trackio)
		.unwrap_err()
		.to_string();
	assert!(error.contains("trackio_enabled"), "{error}");
	assert!(
		trainer_loop::callbacks::refuse_trackio(&run_config(serde_json::json!({"trackio_enabled": false}))).is_ok()
	);
}

#[test]
fn the_conventions_mask_reaches_the_cross_entropy_only() {
	let _guard = seeded(0);
	let mut model = CoarseEncoder::new(spec()).unwrap();
	model.mode = Mode::Eval;
	let ce_of = |logits: &Tensor, labels: &Tensor| {
		let weights = model.store.get("class_weights").unwrap();
		logits
			.view([-1, 11])
			.cross_entropy_loss(&labels.view([-1]), Some(&weights), tch::Reduction::Mean, -100, 0.1)
			.double_value(&[])
	};
	for (locales, forbidden) in [([0i64, -100], false), ([1, 1], true)] {
		let mut inputs = inputs();
		inputs.locale_ids = Some(Tensor::from_slice(&locales));
		let labels = inputs.labels.as_ref().unwrap().shallow_clone();
		let out = tch::no_grad(|| model.forward(&inputs).unwrap());
		let ce = out.terms.iter().find(|(n, _)| *n == "ce").unwrap().1.double_value(&[]);
		let expected = if forbidden {
			// B- and I-street_suffix, ids 9 and 10, are masked on both rows.
			let mut mask = vec![false; 11];
			mask[9] = true;
			mask[10] = true;
			let mask = Tensor::from_slice(&mask).view([1, 1, 11]);
			ce_of(&out.logits.masked_fill(&mask, -1e9), &labels)
		} else {
			ce_of(&out.logits, &labels)
		};
		assert_eq!(ce, expected, "locales {locales:?}");
		assert!(
			out.logits.double_value(&[0, 0, 9]).abs() < 1e8,
			"the returned logits are unmasked"
		);
	}
}

#[test]
fn the_loss_window_logs_the_host_sum_of_each_window() {
	let (accum, log_every) = (2i64, 3i64);
	let weight = Tensor::from_slice(&[0.37f32, -1.9, 2.25]).set_requires_grad(true);
	let scales = [0.731f32, 1.0e-3, 4.5, 0.29, 7.0, 0.013];
	let mut window = LossWindow::new(Device::Cpu, accum, log_every);
	let mut host = 0.0f64;
	let mut logged = Vec::new();

	for (step, scale) in (1..).zip(scales) {
		// A float loss that carries a graph, divided by `accum` as the training step divides it.
		let loss = (&weight * f64::from(scale)).square().sum(Kind::Float) / accum as f64;
		window.add(&loss);
		host += loss.double_value(&[]) * accum as f64;
		if step % log_every == 0 {
			logged.push((window.take(), host / log_every as f64));
			host = 0.0;
		}
	}

	assert_eq!(logged.len(), 2);
	for (device, expected) in logged {
		assert_eq!(device.to_bits(), expected.to_bits(), "{device} against {expected}");
	}
}

#[test]
fn every_loss_term_fires_and_backward_reaches_the_heads() {
	let _guard = seeded(0);
	let mut model = CoarseEncoder::new(spec()).unwrap();
	model.mode = Mode::Eval;
	let out = model.forward(&inputs()).unwrap();
	let names: Vec<&str> = out.terms.iter().map(|(n, _)| *n).collect();
	assert_eq!(
		names,
		vec!["ce", "crf", "locale", "span_boundary", "span", "address_system"]
	);
	assert_eq!(out.span_scores.as_ref().unwrap().size(), vec![2, 6, 3, 6]);
	out.loss.unwrap().backward();
	for name in [
		"span_boundary_head.weight",
		"address_system_head.weight",
		"crf.transitions",
		"span_scorer.start_proj.weight",
		"semi_crf.transitions",
	] {
		assert!(
			model.store.get(name).unwrap().grad().defined(),
			"{name} has no gradient"
		);
	}
}

#[test]
fn the_latest_checkpoint_is_the_highest_step_past_the_name_padding() {
	let dir = tempfile::tempdir().unwrap();
	for step in [999_999, 1_000_000, 42] {
		let checkpoint = dir.path().join(checkpoint_dir_name(step));
		std::fs::create_dir_all(&checkpoint).unwrap();
		std::fs::write(checkpoint.join("training_state.json"), "{}").unwrap();
	}
	assert_eq!(
		find_latest_checkpoint(dir.path()).unwrap(),
		Some(dir.path().join(checkpoint_dir_name(1_000_000)))
	);

	let stray = dir.path().join("step-old");
	std::fs::create_dir_all(&stray).unwrap();
	std::fs::write(stray.join("training_state.json"), "{}").unwrap();
	let refusal = find_latest_checkpoint(dir.path()).unwrap_err().to_string();
	assert!(refusal.contains("step-old"), "{refusal}");
}

/// The total loss and each term of an eval-mode forward.
fn losses(model: &CoarseEncoder, inputs: &EncoderInputs) -> (f64, Vec<(&'static str, f64)>) {
	let out = tch::no_grad(|| model.forward(inputs).unwrap());
	let terms = out.terms.iter().map(|(n, t)| (*n, t.double_value(&[]))).collect();
	(out.loss.unwrap().double_value(&[]), terms)
}

#[test]
fn the_graph_safe_losses_match_the_branches_and_add_zero_for_a_batch_without_ids() {
	let _guard = seeded(0);
	let mut model = CoarseEncoder::new(spec()).unwrap();
	model.mode = Mode::Eval;
	let (branch, branch_terms) = losses(&model, &inputs());
	model.graph_safe_losses = true;
	let (masked, masked_terms) = losses(&model, &inputs());
	assert!((branch - masked).abs() < 1e-6, "{branch} against {masked}");
	for ((name, a), (_, b)) in branch_terms.iter().zip(&masked_terms) {
		assert!((a - b).abs() < 1e-6, "{name}: {a} against {b}");
	}

	// No row carries a locale or an address system: the branches leave both terms out, and the masked sums add 0.
	let mut without_ids = inputs();
	without_ids.locale_ids = Some(Tensor::from_slice(&[-100i64, -100]));
	without_ids.address_system_ids = Some(Tensor::from_slice(&[-100i64, -100]));
	let (masked, masked_terms) = losses(&model, &without_ids);
	model.graph_safe_losses = false;
	let (branch, branch_terms) = losses(&model, &without_ids);
	assert!((branch - masked).abs() < 1e-6, "{branch} against {masked}");
	assert!(!branch_terms
		.iter()
		.any(|(n, _)| *n == "locale" || *n == "address_system"));
	for name in ["locale", "address_system"] {
		let term = masked_terms.iter().find(|(n, _)| *n == name).unwrap().1;
		assert_eq!(term, 0.0, "{name}");
	}
}

#[test]
fn a_batch_padded_to_its_length_bucket_scores_the_loss_of_the_unpadded_batch() {
	let _guard = seeded(0);
	let mut model = CoarseEncoder::new(spec()).unwrap();
	model.mode = Mode::Eval;
	model.graph_safe_losses = true;
	let inputs = inputs();
	let channel = mtf_channels::encoder::CHANNEL_NAMES[0].to_owned();
	let batch = TensorBatch {
		input_ids: inputs.input_ids.as_ref().unwrap().shallow_clone(),
		attention_mask: inputs.attention_mask.as_ref().unwrap().shallow_clone(),
		labels: inputs.labels.as_ref().unwrap().shallow_clone(),
		locale_ids: inputs.locale_ids.as_ref().unwrap().shallow_clone(),
		address_system_ids: inputs.address_system_ids.as_ref().unwrap().shallow_clone(),
		channels: vec![(
			channel,
			inputs.channels[0].features.as_ref().unwrap().shallow_clone(),
			inputs.channels[0].confidence.as_ref().unwrap().shallow_clone(),
		)],
		char_ids: None,
	};
	let buckets = length_buckets(&[4, 10], 10).unwrap();
	let index = bucket_for(&buckets, batch.input_ids.size()[1]).unwrap();
	assert_eq!(buckets[index], 10);
	// A bucket's tensors hold the previous batch's values until the next write, so the write must overwrite them.
	let padded = TensorBatch {
		input_ids: Tensor::full([2, 10], 41, (Kind::Int64, Device::Cpu)),
		attention_mask: Tensor::ones([2, 10], (Kind::Int64, Device::Cpu)),
		labels: Tensor::full([2, 10], 3, (Kind::Int64, Device::Cpu)),
		locale_ids: Tensor::zeros([2], (Kind::Int64, Device::Cpu)),
		address_system_ids: Tensor::zeros([2], (Kind::Int64, Device::Cpu)),
		channels: vec![(
			batch.channels[0].0.clone(),
			Tensor::ones([2, 10, 11], (Kind::Float, Device::Cpu)),
			Tensor::ones([2, 10], (Kind::Float, Device::Cpu)),
		)],
		char_ids: None,
	};
	write_padded(&padded, &batch, 0).unwrap();
	assert_eq!(
		padded.attention_mask.narrow(1, 6, 4).sum(Kind::Int64).int64_value(&[]),
		0
	);
	assert_eq!(padded.labels.narrow(1, 6, 4).eq(-100).all().int64_value(&[]), 1);
	let (unpadded, unpadded_terms) = losses(&model, &batch.inputs());
	let (padded_loss, padded_terms) = losses(&model, &padded.inputs());
	assert!(
		(unpadded - padded_loss).abs() < 1e-5,
		"{unpadded} against {padded_loss}"
	);
	for ((name, a), (_, b)) in unpadded_terms.iter().zip(&padded_terms) {
		assert!((a - b).abs() < 1e-5, "{name}: {a} against {b}");
	}

	assert!(length_buckets(&[16, 8], 8).is_err(), "a bucket list out of order");
	assert!(
		length_buckets(&[16, 32], 64).is_err(),
		"a largest bucket below max_length"
	);
}

/// A batch of three rows, 5, 11 and 3 pieces long, padded to `width` as the encoder pads it: pad id 0, mask 0 and
/// the ignore index past each row's end. The anchor channel holds values in the padding too, where the evidence
/// curriculum's roll can move a row's evidence.
fn padded_batch(width: i64) -> TensorBatch {
	// A valid BIO sequence, so the CRF scores a finite path: locality, O, postcode, street, O, street_prefix.
	const SEQUENCE: [i64; 11] = [1, 2, 2, 0, 3, 4, 5, 6, 0, 7, 8];
	let lengths = [5i64, 11, 3];
	let rows = lengths.len() as i64;
	let (mut ids, mut labels) = (Vec::new(), Vec::new());
	for (r, &n) in lengths.iter().enumerate() {
		for p in 0..width {
			let k = r as i64 * width + p;
			ids.push(if p < n { 1 + (k * 7) % 49 } else { 0 });
			// The second row's fourth piece is ignored inside the row, as a piece the labels skip.
			labels.push(if p < n && !(r == 1 && p == 3) {
				SEQUENCE[p as usize]
			} else {
				-100
			});
		}
	}
	let input_ids = Tensor::from_slice(&ids).view([rows, width]);
	let attention_mask = input_ids.ne(0).to_kind(Kind::Int64);
	let features = Tensor::rand([rows, width, 11], (Kind::Float, Device::Cpu));
	let confidence = Tensor::rand([rows, width], (Kind::Float, Device::Cpu));
	TensorBatch {
		input_ids,
		attention_mask,
		labels: Tensor::from_slice(&labels).view([rows, width]),
		// Locale 1 would forbid a tag, and the spec's label smoothing spreads target mass onto the forbidden labels'
		// -1e9 logits, a loss of order 1e7 that no rounding gap would show in.
		locale_ids: Tensor::from_slice(&[0i64, 2, -100]),
		address_system_ids: Tensor::from_slice(&[1i64, -100, 3]),
		channels: vec![(mtf_channels::encoder::CHANNEL_NAMES[0].to_owned(), features, confidence)],
		char_ids: None,
	}
}

/// The training forward's loss and every parameter's gradient, from a generator seeded the same for each call.
fn loss_and_gradients(model: &CoarseEncoder, batch: &TensorBatch) -> (f64, Vec<(String, Tensor)>) {
	for (_, mut p) in model.store.parameters() {
		trainer_model::autocast::clear_grad(&mut p);
	}
	tch::manual_seed(11);
	let loss = model.forward(&batch.inputs()).unwrap().loss.unwrap();
	loss.backward();
	let grads = model
		.store
		.parameters()
		.into_iter()
		.map(|(n, p)| (n, p.grad().copy()))
		.collect();
	(loss.double_value(&[]), grads)
}

#[test]
fn a_batch_trimmed_to_its_longest_row_has_the_full_batchs_loss_and_gradients() {
	let _guard = seeded(0);
	let mut model = CoarseEncoder::new(spec_with(24, 0.0)).unwrap();
	let full = padded_batch(24);
	let width = full.longest_width();
	assert_eq!(width, 16, "the longest row, 11 pieces, rounded up to 8");
	let trimmed = full.trimmed(width);
	// Eval mode takes the fused attention; train mode, with dropout off so both draw alike, takes the unfused one and
	// draws the locale hints.
	for mode in [Mode::Eval, Mode::Train] {
		model.mode = mode;
		let (full_loss, full_grads) = loss_and_gradients(&model, &full);
		let (trimmed_loss, trimmed_grads) = loss_and_gradients(&model, &trimmed);
		assert!(
			(full_loss - trimmed_loss).abs() < 1e-6,
			"{mode:?}: {full_loss} against {trimmed_loss}"
		);
		for ((name, a), (_, b)) in full_grads.iter().zip(&trimmed_grads) {
			assert_eq!(a.defined(), b.defined(), "{mode:?}: {name}");
			if a.defined() {
				let gap = (a - b).abs().max().double_value(&[]);
				assert!(gap < 1e-6, "{mode:?}: {name} gradients differ by {gap}");
			}
		}
	}
}

#[test]
fn a_trimmed_batch_is_the_full_batchs_first_columns() {
	let _guard = seeded(1);
	let full = padded_batch(24);
	let trimmed = full.trimmed(full.longest_width());
	for ((name, a), (_, b)) in full.named().iter().zip(trimmed.named()) {
		if a.dim() < 2 {
			assert!(a.equal(&b), "{name}: a per-row tensor is kept");
			continue;
		}
		assert_eq!(b.size()[1], 16, "{name}");
		assert!(a.narrow(1, 0, 16).equal(&b), "{name}: the first 16 columns");
	}
	// The columns dropped are padding in every tensor the loss reads.
	assert_eq!(full.input_ids.narrow(1, 16, 8).ne(0).any().int64_value(&[]), 0);
	assert_eq!(full.attention_mask.narrow(1, 16, 8).ne(0).any().int64_value(&[]), 0);
	assert_eq!(full.labels.narrow(1, 16, 8).ne(-100).any().int64_value(&[]), 0);

	// A label scored past every row's attended positions widens the batch to hold it.
	let labelled = padded_batch(24);
	let _ = labelled.labels.get(2).get(17).fill_(1);
	assert_eq!(labelled.longest_width(), 24);
	// The width never exceeds the batch's, and a batch already that wide is returned as is.
	let narrow = padded_batch(12);
	assert_eq!(narrow.longest_width(), 12);
	assert!(narrow.trimmed(12).input_ids.equal(&narrow.input_ids));
	// The char path's `(B, S, W)` units narrow along the units, each unit's characters kept.
	let mut chars = padded_batch(24);
	chars.char_ids = Some(Tensor::arange(3 * 24 * 5, (Kind::Int64, Device::Cpu)).view([3, 24, 5]));
	let char_ids = chars.trimmed(16).char_ids.unwrap();
	assert_eq!(char_ids.size(), vec![3, 16, 5]);
	assert!(chars.char_ids.unwrap().narrow(1, 0, 16).equal(&char_ids));
}

#[test]
fn init_from_refuses_a_checkpoint_missing_a_tensor_or_holding_an_extra_one() {
	let _guard = seeded(3);
	let source = CoarseEncoder::new(spec()).unwrap();
	let target = CoarseEncoder::new(spec()).unwrap();
	let dir = tempfile::tempdir().unwrap();
	let full: Vec<(String, Tensor)> = source
		.store
		.state_dict()
		.into_iter()
		.map(|(n, t)| (n, t.detach().contiguous()))
		.collect();
	let write = |name: &str, tensors: &[(String, Tensor)]| {
		let checkpoint = dir.path().join(name);
		std::fs::create_dir_all(&checkpoint).unwrap();
		Tensor::write_safetensors(tensors, checkpoint.join(trainer_model::checkpoint::MODEL_FILE)).unwrap();
		checkpoint
	};
	init_from_checkpoint(&target, &write("whole", &full)).unwrap();
	let classifier = "classifier.weight";
	assert!(target
		.store
		.get(classifier)
		.unwrap()
		.equal(&source.store.get(classifier).unwrap()));

	let missing: Vec<(String, Tensor)> = full
		.iter()
		.filter(|(n, _)| n != classifier)
		.map(|(n, t)| (n.clone(), t.shallow_clone()))
		.collect();
	let refusal = init_from_checkpoint(&target, &write("missing", &missing))
		.unwrap_err()
		.to_string();
	assert!(
		refusal.contains("1 tensors missing") && refusal.contains(classifier),
		"{refusal}"
	);

	let mut extra: Vec<(String, Tensor)> = full.iter().map(|(n, t)| (n.clone(), t.shallow_clone())).collect();
	extra.push((
		"retired_head.weight".to_owned(),
		Tensor::zeros([2], (Kind::Float, Device::Cpu)),
	));
	let refusal = init_from_checkpoint(&target, &write("extra", &extra))
		.unwrap_err()
		.to_string();
	assert!(
		refusal.contains("1 unexpected") && refusal.contains("retired_head.weight"),
		"{refusal}"
	);
}

#[test]
fn a_checkpoint_restores_the_model_optimizer_and_schedule() {
	let _guard = seeded(1);
	let mut model = CoarseEncoder::new(spec()).unwrap();
	model.mode = Mode::Train;
	let groups = build_groups(model.store.parameters(), 1e-3, 0.01, None, Some(1e-2)).unwrap();
	assert_eq!(
		groups.iter().map(|g| g.label.as_str()).collect::<Vec<_>>(),
		vec!["base", "classifier_learning_rate"]
	);
	let mut optim = AdamW::new(groups);
	let mut sched = LambdaLr::new(
		&mut optim,
		Schedule::Cosine {
			warmup_steps: 2,
			max_steps: 10,
		},
	);
	model.forward(&inputs()).unwrap().loss.unwrap().backward();
	optim.step().unwrap();
	sched.step(&mut optim);
	let dir = tempfile::tempdir().unwrap();
	let saved = save_checkpoint(
		&model,
		dir.path(),
		1,
		&serde_json::json!({"step": 1}),
		Some(&optim),
		Some(&sched),
		&[],
	)
	.unwrap();
	assert_eq!(saved.file_name().unwrap().to_str().unwrap(), checkpoint_dir_name(1));
	std::fs::create_dir_all(dir.path().join("step-000009")).unwrap();
	assert_eq!(
		find_latest_checkpoint(dir.path()).unwrap().as_deref(),
		Some(saved.as_path())
	);
	let (bio, table) = (labels(), conventions());
	let restored = CoarseEncoder::from_pretrained(&saved, defaults(&bio, &table)).unwrap();
	// `config.json` records a disabled channel's width as 0, so the specs agree as the file states them.
	assert_eq!(restored.spec.to_config_json(), model.spec.to_config_json());
	model.mode = Mode::Eval;
	let mut restored = restored;
	restored.mode = Mode::Eval;
	let a = tch::no_grad(|| model.forward(&inputs()).unwrap().logits);
	let b = tch::no_grad(|| restored.forward(&inputs()).unwrap().logits);
	assert!(a.equal(&b));
	let groups = build_groups(restored.store.parameters(), 1e-3, 0.01, None, Some(1e-2)).unwrap();
	let mut optim2 = AdamW::new(groups);
	let mut sched2 = LambdaLr::new(&mut optim2, sched.schedule.clone());
	optim2.load(&saved).unwrap();
	sched2.load(&saved).unwrap();
	assert_eq!(sched2.last_epoch, 1);
	assert_eq!(optim2.state.len(), optim.state.len());
	assert!(Path::new(&saved.join("training_state.json")).is_file());

	// A resume under another schedule keeps the restored step and follows the live config, as torch's
	// `load_state_dict` does: the saved run was cosine to step 10, and the live config cools down linearly to 40.
	let live = Schedule::LinearCooldown {
		cooldown_start: 20,
		max_steps: 40,
	};
	let groups = build_groups(restored.store.parameters(), 1e-3, 0.01, None, Some(1e-2)).unwrap();
	let mut optim3 = AdamW::new(groups);
	let mut sched3 = LambdaLr::new(&mut optim3, live.clone());
	sched3.load(&saved).unwrap();
	assert_eq!(sched3.last_epoch, 1);
	assert_eq!(sched3.schedule, live);
	// The rate the restored scheduler sets is the live schedule's at the restored step plus the steps taken: at
	// step 25 the cooldown gives 0.75 of the restored base rate, where the saved cosine run would give 0.
	for _ in 0..24 {
		sched3.step(&mut optim3);
	}
	assert_eq!(sched3.last_epoch, 25);
	let expected = sched3.base_lrs[0] * live.multiplier(25);
	assert!(
		(sched3.get_last_lr()[0] - expected).abs() < 1e-15,
		"{:?}",
		sched3.get_last_lr()
	);
	assert!((live.multiplier(25) - 0.75).abs() < 1e-12);
	assert_ne!(live.multiplier(25), sched.schedule.multiplier(25));

	// A resume refuses a directory that is not a run to resume, rather than restarting it from step 0.
	use trainer_loop::supervised::restore_training_state;
	let run = run_config(serde_json::json!({}));
	let lrs = vec![1e-3; optim3.groups.len()];
	let weights_only = dir.path().join("weights-only");
	std::fs::create_dir_all(&weights_only).unwrap();
	let error = restore_training_state(&run, &weights_only, &mut optim3, &mut sched3, &lrs)
		.unwrap_err()
		.to_string();
	assert!(error.contains("holds no optimizer.json"), "{error}");
	let no_step = dir.path().join("no-step");
	std::fs::create_dir_all(&no_step).unwrap();
	for entry in std::fs::read_dir(&saved).unwrap() {
		let entry = entry.unwrap();
		std::fs::copy(entry.path(), no_step.join(entry.file_name())).unwrap();
	}
	std::fs::write(
		no_step.join("training_state.json"),
		r#"{"step": "seven", "config": {}}"#,
	)
	.unwrap();
	let states_before = optim3.state.len();
	let error = restore_training_state(&run, &no_step, &mut optim3, &mut sched3, &lrs)
		.unwrap_err()
		.to_string();
	assert!(error.contains("`step` is not an integer"), "{error}");
	// The checkpoint's step is checked before its optimizer state is loaded, so a refused resume changes no state.
	assert!(saved.join("optimizer.json").is_file());
	assert_eq!(optim3.state.len(), states_before);
}

#[test]
fn a_checkpoint_restores_the_generators_a_resume_draws_from() {
	let _guard = seeded(3);
	let model = CoarseEncoder::new(spec()).unwrap();
	let mut owned = Generator::new(11).unwrap();
	let _ = Tensor::rand([4], (Kind::Float, Device::Cpu));
	let _ = owned.randint(0, 1000, &[4]).unwrap();
	let dir = tempfile::tempdir().unwrap();
	let saved = save_checkpoint(
		&model,
		dir.path(),
		1,
		&serde_json::json!({"step": 1}),
		None,
		None,
		&[("owned", &owned)],
	)
	.unwrap();
	// The draws an uninterrupted run makes after the save.
	let default_next = Tensor::rand([4], (Kind::Float, Device::Cpu));
	let owned_next = owned.randint(0, 1000, &[4]).unwrap();

	// A resumed process reseeds, then restores.
	tch::manual_seed(3);
	let mut resumed = Generator::new(11).unwrap();
	assert!(restore_generators(&saved, Device::Cpu, &mut [("owned", &mut resumed)]).unwrap());
	assert!(Tensor::rand([4], (Kind::Float, Device::Cpu)).equal(&default_next));
	assert!(resumed.randint(0, 1000, &[4]).unwrap().equal(&owned_next));

	// A checkpoint without the file leaves the generators as they are, and one missing an owned state is refused.
	let older = tempfile::tempdir().unwrap();
	assert!(!restore_generators(older.path(), Device::Cpu, &mut []).unwrap());
	let mut other = Generator::new(5).unwrap();
	assert!(restore_generators(&saved, Device::Cpu, &mut [("missing", &mut other)]).is_err());
}
