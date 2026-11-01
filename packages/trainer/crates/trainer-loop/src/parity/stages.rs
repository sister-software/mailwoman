//! Stages 0 to 6 of plan §3.3 for one matrix cell, against `trainer_parity capture`'s record.
//!
//! - Stage 0: the batches the Rust sampler and encoder build equal the recorded Python batches, tensor for tensor.
//! - Construction: the model built from the record's seed equals the Python model's initial state dict.
//! - Stage 1: the checkpoint's parameters load into the Rust model byte for byte.
//! - Stages 2 to 4: the forward outputs, each loss term and every gradient, in eval mode and in train mode from
//!   the same generator state, which also compares the curricula's draws.
//! - Stage 5: the loop's optimizer steps (accumulation, clipping, AdamW, the schedule) over the saved batches.
//! - Stage 6: a save and restore in the Rust format, with the forward and the next step unchanged, and
//!   `find_latest_checkpoint` passing over a directory without `training_state.json`.

use crate::batch::{RunEncoder, TensorBatch};
use crate::checkpoint::{checkpoint_extras, find_latest_checkpoint, save_checkpoint};
use crate::compare::{diff, Record, StageResult, Tolerance};
use crate::config::{sampler_config, DataFiles, RunConfig};
use crate::noise::{apply_curricula, Curricula};
use crate::optim::{clip_grad_norm, AdamW, Group};
use crate::schedules::{LambdaLr, Schedule};
use crate::supervised::{apply_freezes, build_model, build_optimization};
use crate::{fail, Result};
use mtf_sampler::{CancelToken, TrainingBatches};
use serde_json::Value;
use std::path::Path;
use tch::{Kind, Tensor};
use trainer_model::autocast::{clear_grad, Autocast};
use trainer_model::layers::Mode;
use trainer_model::{CoarseEncoder, EncoderOutput};

const EXACT: Tolerance = Tolerance::Exact;
const FORWARD: Tolerance = Tolerance::Relative { rel: 1e-5, floor: 1e-3 };
const GRADIENT: Tolerance = Tolerance::Relative { rel: 1e-4, floor: 1e-3 };
const UPDATE: Tolerance = Tolerance::Absolute { abs: 1e-6 };

fn zero_grads(model: &CoarseEncoder) {
	for (_, mut p) in model.store.parameters() {
		clear_grad(&mut p);
	}
}

fn batch(record: &Record, i: usize) -> Result<TensorBatch> {
	TensorBatch::from_named(|k| {
		let name = format!("batch{i}.{k}");
		record
			.has(&name)
			.then(|| record.get(&name).expect("checked").shallow_clone())
	})
}

fn mlm_inputs(record: &Record, i: usize) -> Result<(Tensor, Tensor)> {
	Ok((
		record.get(&format!("batch{i}.mlm_input_ids"))?.shallow_clone(),
		record.get(&format!("batch{i}.mlm_labels"))?.shallow_clone(),
	))
}

fn forward(
	model: &CoarseEncoder,
	b: &TensorBatch,
	mlm: Option<&(Tensor, Tensor)>,
	autocast: bool,
) -> Result<EncoderOutput> {
	let _guard = autocast
		.then(|| Autocast::enter(model.device(), Kind::BFloat16))
		.transpose()?;
	Ok(match mlm {
		Some((ids, labels)) => model.forward_mlm(ids, Some(&b.attention_mask), Some(labels)),
		None => model.forward(&b.inputs())?,
	})
}

fn compare_outputs(stage: &mut StageResult, prefix: &str, out: &EncoderOutput, record: &Record) -> Result<()> {
	stage.push(diff(
		"logits",
		&out.logits,
		record.get(&format!("{prefix}.logits"))?,
		FORWARD,
	)?);
	let loss = out.loss.as_ref().ok_or_else(|| fail!("the forward returned no loss"))?;
	stage.push(diff("loss", loss, record.get(&format!("{prefix}.loss"))?, FORWARD)?);
	for (name, value) in [
		("locale_logits", out.locale_logits.as_ref()),
		("address_system_logits", out.address_system_logits.as_ref()),
		("span_scores", out.span_scores.as_ref()),
	] {
		let key = format!("{prefix}.{name}");
		match (value, record.has(&key)) {
			(Some(v), true) => stage.push(diff(name, v, record.get(&key)?, FORWARD)?),
			(None, false) => {}
			_ => stage.notes.push(format!("{name}: present on one side only")),
		}
	}
	let recorded: Vec<(String, Tensor)> = record.prefixed(&format!("{prefix}.term."));
	for (name, t) in &recorded {
		match out.terms.iter().find(|(n, _)| n == name) {
			Some((_, v)) => stage.push(diff(&format!("term.{name}"), v, t, FORWARD)?),
			None => stage.notes.push(format!("loss term {name} is computed in Python only")),
		}
	}
	for (name, _) in &out.terms {
		if !recorded.iter().any(|(n, _)| n == name) {
			stage.notes.push(format!("loss term {name} is computed in Rust only"));
		}
	}
	Ok(())
}

fn compare_grads(stage: &mut StageResult, prefix: &str, model: &CoarseEncoder, record: &Record) -> Result<()> {
	for (name, p) in model.store.parameters() {
		let key = format!("{prefix}.grad.{name}");
		let grad = p.grad();
		match (grad.defined(), record.has(&key)) {
			(true, true) => stage.push(diff(&name, &grad, record.get(&key)?, GRADIENT)?),
			(false, false) => {}
			(true, false) => stage.notes.push(format!("{name} has a gradient in Rust only")),
			(false, true) => stage.notes.push(format!("{name} has a gradient in Python only")),
		}
	}
	Ok(())
}

/// What the Rust side needs beside the record.
pub struct CellInputs<'a> {
	pub record_dir: &'a Path,
	pub resolved: &'a Path,
	pub files: &'a DataFiles,
	/// Re-draw the batches through the Rust sampler and compare them (stage 0).
	pub sample: bool,
}

pub fn run(cell: &CellInputs) -> Result<Vec<StageResult>> {
	let meta: Value = serde_json::from_str(&std::fs::read_to_string(cell.record_dir.join("record.json"))?)?;
	let record = Record::read(&cell.record_dir.join("record.safetensors"))?;
	let mut run = RunConfig::read(cell.resolved)?;
	for o in meta["overrides"].as_array().into_iter().flatten() {
		run.set(o.as_str().ok_or_else(|| fail!("record.json overrides holds {o}"))?)?;
	}
	let seed = meta["seed"].as_i64().ok_or_else(|| fail!("record.json has no seed"))?;
	let n_steps = meta["batches"].as_u64().unwrap_or(1) as usize;
	let accum = meta["accum"].as_u64().unwrap_or(1) as usize;
	let mlm = meta["objective"].as_str() == Some("mlm");
	let autocast = meta["autocast"].is_string();
	let curriculum_step = meta["curriculum_step"].as_i64().unwrap_or(0);
	let encoder = RunEncoder::build(&run, cell.files)?;
	let mut results = Vec::new();

	if cell.sample {
		let mut stage = StageResult::new("0 batches from the Rust sampler", "exact");
		let sampler = sampler_config(&run, cell.files, &encoder.active_tags()?)?;
		let mut batches = TrainingBatches::new(
			sampler,
			run.train_i64("batch_size")? as usize,
			i128::from(seed),
			run.data_i64("train_rows_per_epoch")?.map(|n| n as u64),
			0,
			CancelToken::default(),
		);
		for i in 0..n_steps * accum {
			let ours = encoder.encode(&batches.next_batch()?)?;
			for (name, t) in ours.named() {
				let key = format!("batch{i}.{name}");
				if record.has(&key) {
					stage.push(diff(&format!("batch{i}.{name}"), &t, record.get(&key)?, EXACT)?);
				} else {
					stage.notes.push(format!("{key} is built in Rust only"));
				}
			}
		}
		results.push(stage);
	}

	tch::manual_seed(seed);
	let mut model = build_model(&run, &encoder)?;
	let mut construction = StageResult::new("construction from the seed", "exact");
	let order: Vec<String> = model.store.parameters().into_iter().map(|(n, _)| n).collect();
	let expected: Vec<String> = meta["param_order"]
		.as_array()
		.into_iter()
		.flatten()
		.filter_map(|v| v.as_str().map(str::to_owned))
		.collect();
	if order != expected {
		construction.notes.push(format!(
			"named_parameters order differs: {order:?} against {expected:?}"
		));
	}
	let init = record.prefixed("init.");
	if init.len() != model.store.state_dict().len() {
		construction.notes.push(format!(
			"state dict holds {} tensors in Rust and {} in Python",
			model.store.state_dict().len(),
			init.len()
		));
	}
	for (name, t) in model.store.state_dict() {
		let key = format!("init.{name}");
		if record.has(&key) {
			construction.push(diff(&name, &t, record.get(&key)?, EXACT)?);
		} else {
			construction
				.notes
				.push(format!("{name} is in the Rust state dict only"));
		}
	}
	results.push(construction);

	let mut stage1 = StageResult::new("1 checkpoint load", "exact");
	let params = record.prefixed("params.");
	model.store.load(&params, true)?;
	for (name, t) in model.store.state_dict() {
		stage1.push(diff(&name, &t, record.get(&format!("params.{name}"))?, EXACT)?);
	}
	results.push(stage1);
	apply_freezes(&run, &model)?;

	let b0 = batch(&record, 0)?;
	let m0 = if mlm { Some(mlm_inputs(&record, 0)?) } else { None };

	model.mode = Mode::Eval;
	let out = forward(&model, &b0, m0.as_ref(), autocast)?;
	let mut s23 = StageResult::new("2-3 eval forward and loss terms", "1e-5 rel");
	compare_outputs(&mut s23, "eval", &out, &record)?;
	results.push(s23);
	out.loss.as_ref().expect("compared above").backward();
	let mut s4 = StageResult::new("4 eval gradients", "1e-4 rel");
	compare_grads(&mut s4, "eval", &model, &record)?;
	results.push(s4);
	zero_grads(&model);

	model.mode = Mode::Train;
	tch::manual_seed(seed + 7);
	let curricula = Curricula {
		gazetteer: run.train_bool("gazetteer_curriculum")?,
		evidence: run.train_bool("evidence_curriculum")?,
		evidence_noise_prob: run.train_f64("evidence_noise_prob")?,
		max_steps: run.train_i64("max_steps")?,
	};
	let mut tb = batch(&record, 0)?;
	tb = TensorBatch::from_named(|k| tb.named().into_iter().find(|(n, _)| n == k).map(|(_, t)| t.copy()))?;
	let mut curr = StageResult::new("curricula draws", "exact");
	if !mlm {
		apply_curricula(&curricula, &mut tb, curriculum_step)?;
		for (name, t) in tb.named() {
			let key = format!("train.curriculum.{name}");
			if record.has(&key) {
				curr.push(diff(&name, &t, record.get(&key)?, EXACT)?);
			}
		}
	}
	results.push(curr);
	let out = forward(&model, &tb, m0.as_ref(), autocast)?;
	let mut s23t = StageResult::new("2-3 train forward (dropout, hints)", "1e-5 rel");
	compare_outputs(&mut s23t, "train", &out, &record)?;
	results.push(s23t);
	out.loss.as_ref().expect("compared above").backward();
	let mut s4t = StageResult::new("4 train gradients", "1e-4 rel");
	compare_grads(&mut s4t, "train", &model, &record)?;
	results.push(s4t);
	zero_grads(&model);

	// Stage 5.
	let (mut optim, mut scheduler) = if mlm {
		let lr = run.train_f64("learning_rate")?;
		let mut optim = AdamW::new(vec![Group {
			label: "base".into(),
			params: model.store.parameters(),
			lr,
			initial_lr: lr,
			weight_decay: run.train_f64("weight_decay")?,
		}]);
		let schedule = Schedule::from_config(
			&run.train_str("lr_schedule")?,
			run.train_i64("warmup_steps")?,
			run.train_i64("max_steps")?,
			run.train_opt_i64("cooldown_start_step")?,
		)?;
		let scheduler = LambdaLr::new(&mut optim, schedule);
		(optim, scheduler)
	} else {
		let (o, s, _) = build_optimization(&run, &model)?;
		(o, s)
	};
	let mut s5 = StageResult::new("5 optimizer steps", "1e-6 abs");
	let sizes: Vec<u64> = optim.groups.iter().map(|g| g.params.len() as u64).collect();
	let expected_sizes: Vec<u64> = meta["group_sizes"]
		.as_array()
		.into_iter()
		.flatten()
		.filter_map(Value::as_u64)
		.collect();
	if sizes != expected_sizes {
		s5.notes
			.push(format!("parameter groups {sizes:?} against {expected_sizes:?}"));
	}
	tch::manual_seed(seed + 11);
	let mut lrs = vec![scheduler.get_last_lr().to_vec()];
	let (mut norms, mut losses) = (Vec::new(), Vec::new());
	let grad_clip = run.train_f64("grad_clip_norm")?;
	for step in 0..n_steps {
		optim.zero_grad();
		for micro in 0..accum {
			let i = step * accum + micro;
			let mut tb = batch(&record, i)?;
			tb = TensorBatch::from_named(|k| tb.named().into_iter().find(|(n, _)| n == k).map(|(_, t)| t.copy()))?;
			let m = if mlm { Some(mlm_inputs(&record, i)?) } else { None };
			if !mlm {
				apply_curricula(&curricula, &mut tb, curriculum_step)?;
			}
			let out = forward(&model, &tb, m.as_ref(), autocast)?;
			let loss = out.loss.expect("a loss") / accum as f64;
			loss.backward();
			losses.push(loss.double_value(&[]));
		}
		let params = model.store.parameters();
		let refs: Vec<&Tensor> = params.iter().map(|(_, p)| p).collect();
		norms.push(clip_grad_norm(&refs, grad_clip)?.map_or(0.0, |t| t.double_value(&[])));
		optim.step();
		scheduler.step(&mut optim);
		lrs.push(scheduler.get_last_lr().to_vec());
		for (name, p) in &params {
			s5.push(diff(
				&format!("step{step}.{name}"),
				p,
				record.get(&format!("step{step}.{name}"))?,
				UPDATE,
			)?);
		}
	}
	let floats = |key: &str| -> Vec<f64> {
		meta[key]
			.as_array()
			.into_iter()
			.flatten()
			.filter_map(Value::as_f64)
			.collect()
	};
	let to_f32 = |v: &[f64]| Tensor::from_slice(v).to_kind(Kind::Float);
	s5.push(diff(
		"micro_losses",
		&to_f32(&losses),
		&to_f32(&floats("micro_losses")),
		FORWARD,
	)?);
	s5.push(diff(
		"grad_norms",
		&to_f32(&norms),
		&to_f32(&floats("grad_norms")),
		FORWARD,
	)?);
	let ours: Vec<f64> = lrs.concat();
	let theirs: Vec<f64> = meta["lrs"]
		.as_array()
		.into_iter()
		.flatten()
		.flat_map(|g| {
			g.as_array()
				.into_iter()
				.flatten()
				.filter_map(Value::as_f64)
				.collect::<Vec<_>>()
		})
		.collect();
	s5.push(diff(
		"lrs",
		&Tensor::from_slice(&ours),
		&Tensor::from_slice(&theirs),
		EXACT,
	)?);
	let mut sched = (Vec::new(), Vec::new());
	for (step, value) in meta["schedule"].as_object().into_iter().flatten() {
		sched.0.push(
			scheduler
				.schedule
				.multiplier(step.parse().map_err(|_| fail!("bad step {step}"))?),
		);
		sched.1.push(value.as_f64().unwrap_or(f64::NAN));
	}
	s5.push(diff(
		"schedule multipliers at 0, 1, 100, warmup, max",
		&Tensor::from_slice(&sched.0),
		&Tensor::from_slice(&sched.1),
		EXACT,
	)?);
	results.push(s5);

	results.push(stage6(
		&run,
		&mut model,
		&mut optim,
		&mut scheduler,
		&b0,
		m0.as_ref(),
		autocast,
		&encoder,
		mlm,
		&curricula,
		curriculum_step,
	)?);
	Ok(results)
}

#[allow(clippy::too_many_arguments)]
fn stage6(
	run: &RunConfig,
	model: &mut CoarseEncoder,
	optim: &mut AdamW,
	scheduler: &mut LambdaLr,
	b0: &TensorBatch,
	m0: Option<&(Tensor, Tensor)>,
	autocast: bool,
	encoder: &RunEncoder,
	mlm: bool,
	curricula: &Curricula,
	curriculum_step: i64,
) -> Result<StageResult> {
	let mut s6 = StageResult::new("6 save and restore", "exact");
	let dir = std::env::temp_dir().join(format!("trainer-parity-stage6-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir)?;
	let step = scheduler.last_epoch;
	let saved = save_checkpoint(
		model,
		&dir,
		step,
		&checkpoint_extras(step, &run.config, encoder.vocab_size),
		Some(optim),
		Some(scheduler),
		&[],
	)?;
	// A later directory without `training_state.json` is an interrupted save, which the resume passes over.
	std::fs::create_dir_all(dir.join("step-999999"))?;
	let latest = find_latest_checkpoint(&dir)?;
	if latest.as_deref() != Some(saved.as_path()) {
		s6.notes.push(format!(
			"find_latest_checkpoint chose {latest:?}, expected {}",
			saved.display()
		));
	}
	let mut restored = CoarseEncoder::from_pretrained(&saved, encoder.defaults())?;
	// `config.json` records a disabled channel's width as 0, as `to_config_dict` does, so the specs are compared as
	// the file states them.
	if restored.spec.to_config_json() != model.spec.to_config_json() {
		s6.notes
			.push("the restored config.json differs from the saved one".into());
	}
	for ((name, a), (_, b)) in model.store.state_dict().iter().zip(restored.store.state_dict()) {
		s6.push(diff(&format!("state.{name}"), &b, a, EXACT)?);
	}
	model.mode = Mode::Eval;
	restored.mode = Mode::Eval;
	let before = tch::no_grad(|| forward(model, b0, m0, autocast))?;
	let after = tch::no_grad(|| forward(&restored, b0, m0, autocast))?;
	s6.push(diff(
		"forward logits after restore",
		&after.logits,
		&before.logits,
		EXACT,
	)?);
	apply_freezes(run, &restored)?;
	let (mut optim2, mut sched2) = if mlm {
		let lr = run.train_f64("learning_rate")?;
		let mut o = AdamW::new(vec![Group {
			label: "base".into(),
			params: restored.store.parameters(),
			lr,
			initial_lr: lr,
			weight_decay: run.train_f64("weight_decay")?,
		}]);
		let s = LambdaLr::new(&mut o, scheduler.schedule.clone());
		(o, s)
	} else {
		let (o, s, _) = build_optimization(run, &restored)?;
		(o, s)
	};
	optim2.load(&saved)?;
	sched2.load(&saved)?;
	// One more step from each, from the same generator state.
	let gen_state = |m: &mut CoarseEncoder, o: &mut AdamW, s: &mut LambdaLr| -> Result<Vec<(String, Tensor)>> {
		m.mode = Mode::Train;
		tch::manual_seed(4242);
		o.zero_grad();
		let mut tb = TensorBatch::from_named(|k| b0.named().into_iter().find(|(n, _)| n == k).map(|(_, t)| t.copy()))?;
		if !mlm {
			apply_curricula(curricula, &mut tb, curriculum_step)?;
		}
		let out = forward(m, &tb, m0, autocast)?;
		out.loss.expect("a loss").backward();
		let params = m.store.parameters();
		let refs: Vec<&Tensor> = params.iter().map(|(_, p)| p).collect();
		clip_grad_norm(&refs, 1.0)?;
		o.step();
		s.step(o);
		Ok(params)
	};
	let a = gen_state(model, optim, scheduler)?;
	let b = gen_state(&mut restored, &mut optim2, &mut sched2)?;
	for ((name, x), (_, y)) in a.iter().zip(&b) {
		s6.push(diff(&format!("next step {name}"), y, x, EXACT)?);
	}
	let _ = std::fs::remove_dir_all(&dir);
	Ok(s6)
}
