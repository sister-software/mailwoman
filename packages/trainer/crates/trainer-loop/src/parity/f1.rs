//! F1: one pre-norm block, AdamW and the cosine `LambdaLR`, against `trainer_parity f1`'s record.

use crate::compare::{diff, Record, StageResult, Tolerance};
use crate::optim::{clip_grad_norm, AdamW, Group};
use crate::schedules::{LambdaLr, Schedule};
use crate::{fail, Result};
use serde_json::Value;
use std::path::Path;
use tch::Tensor;
use trainer_model::layers::{EncoderBlock, Mode};
use trainer_model::store::Store;

const EXACT: Tolerance = Tolerance::Exact;
const FORWARD: Tolerance = Tolerance::Relative { rel: 1e-5, floor: 1e-3 };
const GRADIENT: Tolerance = Tolerance::Relative { rel: 1e-4, floor: 1e-3 };
const UPDATE: Tolerance = Tolerance::Absolute { abs: 1e-6 };

/// Runs every F1 comparison and returns one result per check.
pub fn run(dir: &Path) -> Result<Vec<StageResult>> {
	let record = Record::read(&dir.join("f1.safetensors"))?;
	let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("f1.json"))?)?;
	let mut results = Vec::new();

	let dim = |k: &str, d: i64| meta["dims"][k].as_i64().unwrap_or(d);
	tch::manual_seed(0);
	let mut store = Store::default();
	let block = EncoderBlock::new(
		&mut store,
		"",
		dim("hidden", 384),
		dim("heads", 6),
		dim("ff", 1536),
		0.1,
	);
	let order: Vec<String> = store.parameters().into_iter().map(|(n, _)| n).collect();
	let expected: Vec<String> = meta["param_order"]
		.as_array()
		.ok_or_else(|| fail!("f1.json has no param_order"))?
		.iter()
		.filter_map(|v| v.as_str().map(str::to_owned))
		.collect();
	let mut construction = StageResult::new("construction from seed 0", "exact");
	if order != expected {
		construction
			.notes
			.push(format!("parameter order {order:?} against {expected:?}"));
	}
	for (name, t) in store.state_dict() {
		construction.push(diff(&name, &t, record.get(&format!("init.{name}"))?, EXACT)?);
	}
	results.push(construction);

	let x = record.get("x")?;
	let cot = record.get("cot")?;
	let kpm = record.get("mask")?.eq(0);

	let mut eval = StageResult::new("eval forward, no grad (fast path)", "1e-5 rel");
	let out = tch::no_grad(|| block.forward(x, Some(&kpm), Mode::Eval, false));
	eval.push(diff("eval_nograd", &out, record.get("eval_nograd")?, FORWARD)?);
	results.push(eval);

	let mut eval_grad = StageResult::new("eval forward + backward", "1e-5 / 1e-4 rel");
	let xg = x.copy().set_requires_grad(true);
	let out = block.forward(&xg, Some(&kpm), Mode::Eval, false);
	eval_grad.push(diff("eval", &out, record.get("eval")?, FORWARD)?);
	(&out * cot).sum(None).backward();
	eval_grad.push(diff("grad.x", &xg.grad(), record.get("eval.grad.x")?, GRADIENT)?);
	for (name, p) in store.parameters() {
		eval_grad.push(diff(
			&name,
			&p.grad(),
			record.get(&format!("eval.grad.{name}"))?,
			GRADIENT,
		)?);
	}
	results.push(eval_grad);

	let params = store.parameters();
	let mut optim = AdamW::new(vec![Group {
		label: "base".into(),
		params: params.iter().map(|(n, p)| (n.clone(), p.shallow_clone())).collect(),
		lr: 5e-4,
		initial_lr: 5e-4,
		weight_decay: 0.01,
	}]);
	let mut scheduler = LambdaLr::new(
		&mut optim,
		Schedule::Cosine {
			warmup_steps: 2,
			max_steps: 10,
		},
	);
	let mut lrs = vec![scheduler.get_last_lr()[0]];
	let mut norms = Vec::new();
	for step in 0..3 {
		optim.zero_grad();
		tch::manual_seed(100 + step);
		let y = block.forward(x, Some(&kpm), Mode::Train, false);
		let mut fwd = StageResult::new(&format!("train step {step}: forward (dropout)"), "1e-5 rel");
		fwd.push(diff("out", &y, record.get(&format!("train{step}.out"))?, FORWARD)?);
		results.push(fwd);
		(&y * cot).sum(None).backward();
		let mut grads = StageResult::new(&format!("train step {step}: gradients"), "1e-4 rel");
		for (name, p) in &params {
			grads.push(diff(
				name,
				&p.grad(),
				record.get(&format!("train{step}.grad.{name}"))?,
				GRADIENT,
			)?);
		}
		results.push(grads);
		let refs: Vec<&Tensor> = params.iter().map(|(_, p)| p).collect();
		let norm = clip_grad_norm(&refs, 1.0)?.expect("every parameter has a gradient");
		norms.push(norm.double_value(&[]));
		optim.step();
		scheduler.step(&mut optim);
		lrs.push(scheduler.get_last_lr()[0]);
		let mut update = StageResult::new(&format!("train step {step}: AdamW update"), "1e-6 abs");
		for (name, p) in &params {
			update.push(diff(
				name,
				p,
				record.get(&format!("train{step}.param.{name}"))?,
				UPDATE,
			)?);
		}
		results.push(update);
	}

	let mut schedule = StageResult::new("LambdaLR rates and clip norms", "exact");
	let expected_lrs: Vec<f64> = meta["lrs"]
		.as_array()
		.ok_or_else(|| fail!("f1.json has no lrs"))?
		.iter()
		.filter_map(Value::as_f64)
		.collect();
	let expected_norms: Vec<f64> = meta["grad_norms"]
		.as_array()
		.ok_or_else(|| fail!("f1.json has no grad_norms"))?
		.iter()
		.filter_map(Value::as_f64)
		.collect();
	schedule.push(diff(
		"lrs",
		&Tensor::from_slice(&lrs),
		&Tensor::from_slice(&expected_lrs),
		EXACT,
	)?);
	schedule.push(diff(
		"grad_norms",
		&Tensor::from_slice(&norms).to_kind(tch::Kind::Float),
		&Tensor::from_slice(&expected_norms).to_kind(tch::Kind::Float),
		FORWARD,
	)?);
	let sched = Schedule::Cosine {
		warmup_steps: 2,
		max_steps: 10,
	};
	let multipliers = meta["schedule_multipliers"]
		.as_object()
		.ok_or_else(|| fail!("f1.json has no schedule_multipliers"))?;
	let (mut ours, mut theirs) = (Vec::new(), Vec::new());
	for (step, value) in multipliers {
		ours.push(sched.multiplier(step.parse().map_err(|_| fail!("bad step {step}"))?));
		theirs.push(value.as_f64().ok_or_else(|| fail!("bad multiplier"))?);
	}
	schedule.push(diff(
		"multipliers",
		&Tensor::from_slice(&ours),
		&Tensor::from_slice(&theirs),
		EXACT,
	)?);
	results.push(schedule);
	Ok(results)
}
