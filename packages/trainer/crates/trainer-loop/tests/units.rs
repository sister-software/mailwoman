//! The loop's pieces that need no corpus: schedules, `.npy` round trips, checkpoint discovery, the CSV row, the
//! metrics, and the model's construction and save/restore on a small spec.

use std::path::Path;
use tch::{Kind, Tensor};
use trainer_loop::checkpoint::{checkpoint_dir_name, find_latest_checkpoint, save_checkpoint};
use trainer_loop::fisher::{npy_bytes, parse_npy};
use trainer_loop::metrics::{eval_csv_row, token_f1, Metrics};
use trainer_loop::optim::{build_groups, AdamW};
use trainer_loop::schedules::{LambdaLr, Schedule};
use trainer_model::layers::Mode;
use trainer_model::{CoarseEncoder, EncoderInputs, EncoderSpec};

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
		"use_span_boundary_head": true, "span_boundary_loss_weight": 0.5, "use_affix_head": true,
		"use_address_system_head": true, "address_system_loss_weight": 0.3, "use_locale_hint": true,
		"class_weights": {"O": 0.5}
	});
	EncoderSpec::from_model_section(model.as_object().unwrap(), 50, 0, 0, &labels(), "stage3", 9, 4).unwrap()
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
fn npy_round_trips_and_matches_numpys_header() {
	let bytes = npy_bytes(&[2, 3], &[1.0, 2.0, 3.0, 4.0, 5.0, 6.5]);
	assert_eq!((bytes.len() - 6 * 4) % 64, 0);
	let header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 3), }";
	assert_eq!(std::str::from_utf8(&bytes[10..10 + header.len()]).unwrap(), header);
	assert_eq!(bytes.len(), 128 + 6 * 4, "the header pads to a multiple of 64 bytes");
	assert_eq!(bytes[127], b'\n', "the header ends in a newline");
	let (shape, data) = parse_npy(&bytes).unwrap();
	assert_eq!(shape, vec![2, 3]);
	assert_eq!(data[5], 6.5);
	let (shape, _) = parse_npy(&npy_bytes(&[4], &[0.0; 4])).unwrap();
	assert_eq!(shape, vec![4]);
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
fn construction_is_deterministic_and_named_as_in_python() {
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
fn every_loss_term_fires_and_backward_reaches_the_heads() {
	let _guard = seeded(0);
	let mut model = CoarseEncoder::new(spec()).unwrap();
	model.mode = Mode::Eval;
	let out = model.forward(&inputs()).unwrap();
	let names: Vec<&str> = out.terms.iter().map(|(n, _)| *n).collect();
	assert_eq!(
		names,
		vec!["ce", "affix", "crf", "locale", "span_boundary", "address_system"]
	);
	out.loss.unwrap().backward();
	for name in [
		"span_boundary_head.weight",
		"affix_head.0.weight",
		"address_system_head.weight",
		"crf.transitions",
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
	)
	.unwrap();
	assert_eq!(saved.file_name().unwrap().to_str().unwrap(), checkpoint_dir_name(1));
	std::fs::create_dir_all(dir.path().join("step-000009")).unwrap();
	assert_eq!(
		find_latest_checkpoint(dir.path()).unwrap().as_deref(),
		Some(saved.as_path())
	);
	let restored = CoarseEncoder::from_pretrained(&saved, &labels()).unwrap();
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
}
