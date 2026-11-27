// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The multi-tensor AdamW step and gradient clip against the per-tensor ones the parity records hold to Python.
//!
//! libtorch's fused AdamW has a CPU kernel, so both kernels run here on the same parameters and gradients.
//!
//! Every tensor is a function of its shape and a seed. The global generator is shared by the tests, which run on
//! parallel threads, so a draw from it would differ between two runs of one test.

use tch::{Device, Kind, Tensor};
use trainer_loop::optim::{clip_grad_norm_with, AdamW, Group, Kernel};

/// A tensor of `shape` whose values are `sin` of its flat index scaled by `seed`.
fn fixed(shape: &[i64], seed: i64) -> Tensor {
	let n: i64 = shape.iter().product();
	(Tensor::arange(n, (Kind::Float, Device::Cpu)) * (0.37 + seed as f64 * 0.11))
		.sin()
		.reshape(shape)
}

/// Two groups of parameters with the shapes of a small encoder.
fn groups(seed: i64) -> Vec<Group> {
	let mut next = seed;
	let mut param = |shape: &[i64]| {
		next += 1;
		fixed(shape, next).set_requires_grad(true)
	};
	vec![
		Group {
			label: "base".into(),
			params: vec![
				("encoder.weight".into(), param(&[32, 16])),
				("encoder.bias".into(), param(&[32])),
				("unused.weight".into(), param(&[8, 4])),
			],
			lr: 1e-3,
			initial_lr: 1e-3,
			weight_decay: 0.01,
		},
		Group {
			label: "classifier_learning_rate".into(),
			params: vec![("classifier.weight".into(), param(&[5, 32]))],
			lr: 3e-3,
			initial_lr: 3e-3,
			weight_decay: 0.01,
		},
	]
}

/// A loss over every parameter but `unused.weight`, which keeps no gradient and must be skipped.
fn backward(optim: &AdamW, step: i64) {
	let x = fixed(&[4, 16], 100 + step);
	let p = |name: &str| {
		optim
			.params()
			.find(|(n, _)| n == name)
			.map(|(_, t)| t.shallow_clone())
			.unwrap()
	};
	let hidden = (x.matmul(&p("encoder.weight").tr()) + p("encoder.bias")).relu();
	let logits = hidden.matmul(&p("classifier.weight").tr());
	(logits.pow_tensor_scalar(2).mean(Kind::Float) * 10.0).backward();
}

fn run(kernel: Kernel, steps: i64) -> AdamW {
	let mut optim = AdamW::with_kernel(groups(7), kernel);
	for step in 0..steps {
		optim.zero_grad();
		backward(&optim, step);
		let params: Vec<Tensor> = optim.params().map(|(_, p)| p.shallow_clone()).collect();
		let refs: Vec<&Tensor> = params.iter().collect();
		clip_grad_norm_with(&refs, 0.5, kernel).unwrap();
		optim.step().unwrap();
	}
	optim
}

fn max_abs_difference(a: &Tensor, b: &Tensor) -> f64 {
	(a - b).abs().max().double_value(&[])
}

#[test]
fn the_multi_tensor_step_matches_the_per_tensor_step_and_skips_a_parameter_without_a_gradient() {
	let single = run(Kernel::PerTensor, 20);
	let multi = run(Kernel::MultiTensor, 20);
	for ((name, a), (_, b)) in single.params().zip(multi.params()) {
		let difference = max_abs_difference(a, b);
		assert!(difference < 1e-6, "{name} differs by {difference} after 20 steps");
	}
	for ((name, a), (_, b)) in single.state.iter().zip(&multi.state) {
		assert_eq!(a.step.double_value(&[]), 20.0, "{name}'s per-tensor step count");
		assert_eq!(b.step.double_value(&[]), 20.0, "{name}'s multi-tensor step count");
		assert!(
			max_abs_difference(&a.exp_avg_sq, &b.exp_avg_sq) < 1e-9,
			"{name}'s second moment differs"
		);
	}
	// `unused.weight` took no gradient, so neither kernel created its state or moved it.
	assert!(multi.state.iter().all(|(n, _)| n != "unused.weight"));
	let start = groups(7);
	let unused = |o: &AdamW| {
		o.params()
			.find(|(n, _)| n == "unused.weight")
			.map(|(_, t)| t.shallow_clone())
			.unwrap()
	};
	assert_eq!(max_abs_difference(&unused(&multi), &start[0].params[2].1), 0.0);
}

#[test]
fn the_foreach_clip_returns_the_per_tensor_norm_and_scales_the_gradients_alike() {
	let clip = |kernel: Kernel| {
		let optim = AdamW::with_kernel(groups(11), kernel);
		backward(&optim, 0);
		let params: Vec<Tensor> = optim.params().map(|(_, p)| p.shallow_clone()).collect();
		let refs: Vec<&Tensor> = params.iter().collect();
		let total = clip_grad_norm_with(&refs, 0.5, kernel)
			.unwrap()
			.unwrap()
			.double_value(&[]);
		let grads: Vec<Tensor> = params.iter().map(|p| p.grad()).filter(Tensor::defined).collect();
		(total, grads)
	};
	let (single_total, single_grads) = clip(Kernel::PerTensor);
	let (multi_total, multi_grads) = clip(Kernel::MultiTensor);
	assert!(
		single_total > 0.5,
		"the clip scales the gradients only when their norm exceeds 0.5"
	);
	assert!((single_total - multi_total).abs() < 1e-6 * single_total);
	for (a, b) in single_grads.iter().zip(&multi_grads) {
		assert!(max_abs_difference(a, b) < 1e-7);
	}
}

#[test]
fn a_multi_tensor_checkpoint_round_trips_its_step_counts_through_the_cpu() {
	let optim = run(Kernel::MultiTensor, 3);
	let dir = tempfile::tempdir().unwrap();
	optim.save(dir.path()).unwrap();
	let mut loaded = AdamW::with_kernel(groups(7), Kernel::MultiTensor);
	loaded.load(dir.path()).unwrap();
	for ((name, a), (_, b)) in optim.state.iter().zip(&loaded.state) {
		assert_eq!(b.step.double_value(&[]), 3.0, "{name}'s step count");
		assert_eq!(max_abs_difference(&a.exp_avg, &b.exp_avg), 0.0, "{name}'s first moment");
	}
}
