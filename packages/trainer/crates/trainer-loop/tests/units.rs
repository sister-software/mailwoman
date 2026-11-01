//! The loop's pieces that need no corpus: schedules, checkpoint discovery, the CSV row, the metrics, and the model's
//! construction and save/restore on a small spec.

use std::path::Path;
use tch::{Device, Kind, Tensor};
use trainer_loop::checkpoint::{checkpoint_dir_name, find_latest_checkpoint, restore_generators, save_checkpoint};
use trainer_loop::metrics::{eval_csv_row, token_f1, Metrics};
use trainer_loop::optim::{build_groups, AdamW};
use trainer_loop::schedules::{LambdaLr, Schedule};
use trainer_loop::supervised::LossWindow;
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
	let model = serde_json::json!({
		"hidden_size": 16, "num_hidden_layers": 2, "num_attention_heads": 2, "intermediate_size": 32,
		"max_position_embeddings": 12, "hidden_dropout_prob": 0.1, "use_crf": true, "crf_loss_weight": 0.1,
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

/// Locale 1 forbids `street_suffix`, as the schema's FR row does; the other eight forbid nothing.
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
	let meta = stream.finish(dir.path(), "/corpus", "stage3", 9).unwrap();
	assert_eq!(meta, meta_path);
	let text = String::from_utf8(zstd::decode_all(std::fs::File::open(&rows_path).unwrap()).unwrap()).unwrap();
	let lines: Vec<serde_json::Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
	assert_eq!(lines[0]["span_tags"], serde_json::json!(["street"]));
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
	optim.step();
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
