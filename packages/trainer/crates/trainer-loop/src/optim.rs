// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `torch.optim.AdamW`, `clip_grad_norm_`, and `optim/groups.py`'s parameter groups.
//!
//! A step runs one of two kernels, chosen by the parameters' device (`Kernel::for_device`).
//!
//! On the CPU it is torch 2.13's `_single_tensor_adam` with decoupled weight decay, the path a CPU parameter takes:
//! each scalar is computed in `f64` as Python computes it and each tensor operation is the one Python issues. The
//! parity records compare this path with Python.
//!
//! On CUDA it is `AdamW(fused=True)` and `clip_grad_norm_(foreach=True)` (`trainer_model::multi_tensor`). The
//! per-tensor path launches several kernels for every parameter tensor, and at this model's size those launches
//! take a large share of a step. The fused kernel computes the same update in float32 on the device, so its
//! results differ from the per-tensor path's in the last bits.
//!
//! On either path a parameter without a gradient is skipped, as `zero_grad(set_to_none=True)` leaves it.

use crate::{fail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tch::{Device, Kind, Tensor};
use trainer_model::autocast::{clear_grad, vector_norm};
use trainer_model::multi_tensor::{clip_grad_norm_foreach, fused_adamw, LearningRate};

/// Which implementation an optimizer step and a gradient clip run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kernel {
	/// One operation per parameter tensor, as `_single_tensor_adam` issues them.
	PerTensor,
	/// libtorch's tensor-list operations, one launch per chunk of tensors.
	MultiTensor,
}

impl Kernel {
	/// The per-tensor kernel on the CPU, where the parity records hold it to Python, and the multi-tensor kernel on
	/// CUDA.
	pub fn for_device(device: Device) -> Self {
		if device.is_cuda() {
			Kernel::MultiTensor
		} else {
			Kernel::PerTensor
		}
	}
}

/// One parameter group: its parameters by name, and its rates.
pub struct Group {
	pub label: String,
	pub params: Vec<(String, Tensor)>,
	pub lr: f64,
	pub initial_lr: f64,
	pub weight_decay: f64,
}

/// One group's learning rate and weight decay, and each of its parameters that holds a gradient this step, with that
/// gradient and the index of the parameter's state.
type GroupStep = (f64, f64, Vec<(Tensor, Tensor, usize)>);

/// One parameter's AdamW state.
///
/// `step` is a float32 scalar: on the CPU under the per-tensor kernel, and on the parameter's device under the
/// multi-tensor kernel, which reads it there.
pub struct ParamState {
	pub step: Tensor,
	pub exp_avg: Tensor,
	pub exp_avg_sq: Tensor,
}

pub struct AdamW {
	pub groups: Vec<Group>,
	pub betas: (f64, f64),
	pub eps: f64,
	/// By parameter name, in the order of each parameter's first step; absent until that step.
	pub state: Vec<(String, ParamState)>,
	/// Each parameter's index in `state`.
	index: HashMap<String, usize>,
	kernel: Kernel,
	/// Each group's learning rate as a float32 scalar on its parameters' device, when the multi-tensor step reads
	/// the rate from device memory (`use_tensor_learning_rates`). `None` passes each group's `lr` as a host value.
	lr_tensors: Option<Vec<Tensor>>,
}

impl AdamW {
	/// An optimizer over `groups` whose kernel follows the first parameter's device (`Kernel::for_device`).
	pub fn new(groups: Vec<Group>) -> Self {
		let device = groups
			.iter()
			.flat_map(|g| g.params.first())
			.map(|(_, p)| p.device())
			.next()
			.unwrap_or(Device::Cpu);
		Self::with_kernel(groups, Kernel::for_device(device))
	}

	pub fn with_kernel(groups: Vec<Group>, kernel: Kernel) -> Self {
		Self {
			groups,
			betas: (0.9, 0.999),
			eps: 1e-8,
			state: Vec::new(),
			index: HashMap::new(),
			kernel,
			lr_tensors: None,
		}
	}

	pub fn kernel(&self) -> Kernel {
		self.kernel
	}

	/// Moves every group's learning rate into a device tensor that the multi-tensor step reads, so a captured CUDA
	/// graph replays each step at the rate `write_learning_rates` last wrote. Refused on the per-tensor kernel,
	/// which reads its rate on the host.
	pub fn use_tensor_learning_rates(&mut self) -> Result<()> {
		if self.kernel != Kernel::MultiTensor {
			return Err(fail!(
				"a tensor learning rate needs the multi-tensor kernel, and this optimizer runs {:?}",
				self.kernel
			));
		}
		let tensors = self
			.groups
			.iter()
			.map(|g| {
				let device = g.params.first().map_or(Device::Cpu, |(_, p)| p.device());
				Tensor::zeros([], (Kind::Float, device))
			})
			.collect();
		self.lr_tensors = Some(tensors);
		self.write_learning_rates();
		Ok(())
	}

	/// Copies each group's `lr` into its device tensor, when the optimizer holds them. The scheduler calls it after
	/// every rate change, outside any captured region.
	pub fn write_learning_rates(&self) {
		if let Some(tensors) = &self.lr_tensors {
			for (group, tensor) in self.groups.iter().zip(tensors) {
				let _ = tensor.shallow_clone().fill_(group.lr);
			}
		}
	}

	/// Creates the zeroed state of every parameter that has none yet, as its first step would. A step captured into
	/// a CUDA graph must allocate nothing the graph would recreate on each replay, so the capture creates the state
	/// beforehand.
	pub fn create_missing_state(&mut self) {
		let params: Vec<(String, Tensor)> = self.params().map(|(n, p)| (n.clone(), p.shallow_clone())).collect();
		for (name, param) in params {
			self.state_index(&name, &param);
		}
	}

	/// The index in `state` of `param`'s state, created zeroed at its first step.
	fn state_index(&mut self, name: &str, param: &Tensor) -> usize {
		if let Some(&i) = self.index.get(name) {
			return i;
		}
		let step_device = match self.kernel {
			Kernel::PerTensor => Device::Cpu,
			Kernel::MultiTensor => param.device(),
		};
		self.state.push((
			name.to_owned(),
			ParamState {
				step: Tensor::zeros([], (Kind::Float, step_device)),
				exp_avg: param.zeros_like(),
				exp_avg_sq: param.zeros_like(),
			},
		));
		self.index.insert(name.to_owned(), self.state.len() - 1);
		self.state.len() - 1
	}

	/// `optimizer.zero_grad(set_to_none=True)`.
	pub fn zero_grad(&mut self) {
		for group in &mut self.groups {
			for (_, p) in &mut group.params {
				clear_grad(p);
			}
		}
	}

	/// Every parameter in group order.
	pub fn params(&self) -> impl Iterator<Item = &(String, Tensor)> {
		self.groups.iter().flat_map(|g| g.params.iter())
	}

	/// `optimizer.step()`.
	pub fn step(&mut self) -> Result<()> {
		// Each group's parameters that hold a gradient, with the index of their state.
		let mut stepped: Vec<GroupStep> = Vec::with_capacity(self.groups.len());
		for g in 0..self.groups.len() {
			let mut members = Vec::with_capacity(self.groups[g].params.len());
			for p in 0..self.groups[g].params.len() {
				let (name, param) = &self.groups[g].params[p];
				let grad = param.grad();
				if !grad.defined() {
					continue;
				}
				let (name, param) = (name.clone(), param.shallow_clone());
				let index = self.state_index(&name, &param);
				members.push((param, grad, index));
			}
			stepped.push((self.groups[g].lr, self.groups[g].weight_decay, members));
		}
		match self.kernel {
			Kernel::PerTensor => {
				self.step_per_tensor(&stepped);
				Ok(())
			}
			Kernel::MultiTensor => self.step_multi_tensor(&stepped),
		}
	}

	fn step_multi_tensor(&self, stepped: &[GroupStep]) -> Result<()> {
		tch::no_grad(|| {
			for (g, (lr, wd, members)) in stepped.iter().enumerate() {
				if members.is_empty() {
					continue;
				}
				let params: Vec<&Tensor> = members.iter().map(|(p, _, _)| p).collect();
				let grads: Vec<&Tensor> = members.iter().map(|(_, g, _)| g).collect();
				let exp_avgs: Vec<&Tensor> = members.iter().map(|(_, _, i)| &self.state[*i].1.exp_avg).collect();
				let exp_avg_sqs: Vec<&Tensor> = members.iter().map(|(_, _, i)| &self.state[*i].1.exp_avg_sq).collect();
				let steps: Vec<&Tensor> = members.iter().map(|(_, _, i)| &self.state[*i].1.step).collect();
				fused_adamw(
					&params,
					&grads,
					&exp_avgs,
					&exp_avg_sqs,
					&steps,
					match &self.lr_tensors {
						Some(tensors) => LearningRate::Tensor(&tensors[g]),
						None => LearningRate::Scalar(*lr),
					},
					self.betas,
					*wd,
					self.eps,
				)?;
			}
			Ok(())
		})
	}

	fn step_per_tensor(&mut self, stepped: &[GroupStep]) {
		let (beta1, beta2) = self.betas;
		let eps = self.eps;
		tch::no_grad(|| {
			for (lr, wd, members) in stepped {
				let (lr, wd) = (*lr, *wd);
				for (param, grad, index) in members {
					let state = &mut self.state[*index].1;
					let _ = state.step.g_add_scalar_(1.0);
					let mut param = param.shallow_clone();
					if wd != 0.0 {
						let _ = param.g_mul_scalar_(1.0 - lr * wd);
					}
					let _ = state.exp_avg.lerp_(grad, 1.0 - beta1);
					let _ = state.exp_avg_sq.g_mul_scalar_(beta2);
					// `addcmul_(grad, grad, value=1 - beta2)` computes `self + (value * grad) * grad`.
					let scaled = grad * (1.0 - beta2);
					let _ = state.exp_avg_sq.addcmul_(&scaled, grad);
					let step = state.step.double_value(&[]);
					let bias_correction1 = 1.0 - beta1.powf(step);
					let bias_correction2 = 1.0 - beta2.powf(step);
					let step_size = lr / bias_correction1;
					let bias_correction2_sqrt = bias_correction2.powf(0.5);
					let denom = (state.exp_avg_sq.sqrt() / bias_correction2_sqrt).g_add_scalar_(eps);
					// `addcdiv_(exp_avg, denom, value=-step_size)` computes `self + (value * exp_avg) / denom`.
					let scaled = &state.exp_avg * (-step_size);
					let _ = param.addcdiv_(&scaled, &denom);
				}
			}
		});
	}

	/// Writes `optimizer.safetensors` (each state tensor) and `optimizer.json` (the groups and the step counts).
	pub fn save(&self, dir: &Path) -> Result<()> {
		let mut tensors = Vec::new();
		for (name, s) in &self.state {
			tensors.push((
				format!("{name}.exp_avg"),
				s.exp_avg.detach().to_device(tch::Device::Cpu),
			));
			tensors.push((
				format!("{name}.exp_avg_sq"),
				s.exp_avg_sq.detach().to_device(tch::Device::Cpu),
			));
			tensors.push((format!("{name}.step"), s.step.to_device(tch::Device::Cpu)));
		}
		Tensor::write_safetensors(&tensors, dir.join("optimizer.safetensors"))?;
		let doc = OptimizerDoc {
			betas: [self.betas.0, self.betas.1],
			eps: self.eps,
			groups: self
				.groups
				.iter()
				.map(|g| GroupDoc {
					label: g.label.clone(),
					params: g.params.iter().map(|(n, _)| n.clone()).collect(),
					lr: g.lr,
					initial_lr: g.initial_lr,
					weight_decay: g.weight_decay,
				})
				.collect(),
			state: self.state.iter().map(|(n, _)| n.clone()).collect(),
		};
		std::fs::write(dir.join("optimizer.json"), serde_json::to_string_pretty(&doc)? + "\n")?;
		Ok(())
	}

	/// `optimizer.load_state_dict`: every group's rates and every state tensor, positionally by group.
	pub fn load(&mut self, dir: &Path) -> Result<()> {
		let doc: OptimizerDoc = serde_json::from_str(&std::fs::read_to_string(dir.join("optimizer.json"))?)?;
		if doc.groups.len() != self.groups.len() {
			return Err(fail!(
				"the checkpoint's optimizer has {} groups, the run has {}",
				doc.groups.len(),
				self.groups.len()
			));
		}
		for (group, saved) in self.groups.iter_mut().zip(&doc.groups) {
			let names: Vec<&String> = group.params.iter().map(|(n, _)| n).collect();
			if names.len() != saved.params.len() || names.iter().zip(&saved.params).any(|(a, b)| *a != b) {
				return Err(fail!("the checkpoint's group {:?} lists other parameters", saved.label));
			}
			group.lr = saved.lr;
			group.initial_lr = saved.initial_lr;
			group.weight_decay = saved.weight_decay;
		}
		self.write_learning_rates();
		let tensors = Tensor::read_safetensors(dir.join("optimizer.safetensors"))?;
		let take = |key: String| -> Result<Tensor> {
			tensors
				.iter()
				.find(|(n, _)| *n == key)
				.map(|(_, t)| t.shallow_clone())
				.ok_or_else(|| fail!("optimizer.safetensors has no {key}"))
		};
		self.betas = (doc.betas[0], doc.betas[1]);
		self.eps = doc.eps;
		self.state.clear();
		self.index.clear();
		for name in &doc.state {
			let device = self
				.params()
				.find(|(n, _)| n == name)
				.map(|(_, p)| p.device())
				.ok_or_else(|| fail!("the optimizer state names {name}, which no group holds"))?;
			// A checkpoint stores each step count on the CPU, the per-tensor kernel's device.
			let step_device = match self.kernel {
				Kernel::PerTensor => Device::Cpu,
				Kernel::MultiTensor => device,
			};
			self.state.push((
				name.clone(),
				ParamState {
					step: take(format!("{name}.step"))?
						.to_kind(Kind::Float)
						.to_device(step_device),
					exp_avg: take(format!("{name}.exp_avg"))?.to_device(device),
					exp_avg_sq: take(format!("{name}.exp_avg_sq"))?.to_device(device),
				},
			));
			self.index.insert(name.clone(), self.state.len() - 1);
		}
		Ok(())
	}
}

#[derive(Serialize, Deserialize)]
struct GroupDoc {
	label: String,
	params: Vec<String>,
	lr: f64,
	initial_lr: f64,
	weight_decay: f64,
}

#[derive(Serialize, Deserialize)]
struct OptimizerDoc {
	betas: [f64; 2],
	eps: f64,
	groups: Vec<GroupDoc>,
	state: Vec<String>,
}

/// `clip_grad_norm_(params, max_norm)`: scales every gradient by `min(1, max_norm / (total + 1e-6))` and returns the
/// total norm before clipping.
///
/// The kernel follows the gradients' device (`Kernel::for_device`).
pub fn clip_grad_norm(params: &[&Tensor], max_norm: f64) -> Result<Option<Tensor>> {
	let device = params.first().map_or(Device::Cpu, |p| p.device());
	clip_grad_norm_with(params, max_norm, Kernel::for_device(device))
}

/// `clip_grad_norm` under a named kernel.
pub fn clip_grad_norm_with(params: &[&Tensor], max_norm: f64, kernel: Kernel) -> Result<Option<Tensor>> {
	let grads: Vec<Tensor> = params.iter().map(|p| p.grad()).filter(Tensor::defined).collect();
	if grads.is_empty() {
		return Ok(None);
	}
	if kernel == Kernel::MultiTensor {
		let refs: Vec<&Tensor> = grads.iter().collect();
		return Ok(Some(tch::no_grad(|| clip_grad_norm_foreach(&refs, max_norm))?));
	}
	tch::no_grad(|| {
		let norms = grads
			.iter()
			.map(vector_norm)
			.collect::<trainer_model::Result<Vec<_>>>()?;
		let total = vector_norm(&Tensor::stack(&norms, 0))?;
		// `max_norm / (total + 1e-6)` is `Tensor.__rtruediv__`, which multiplies the reciprocal.
		let coef = (&total + 1e-6).reciprocal() * max_norm;
		let coef = coef.clamp_max(1.0);
		for g in &grads {
			let _ = g.shallow_clone().g_mul_(&coef);
		}
		Ok(Some(total))
	})
}

/// `build_optimizer`'s groups: one base group, or the carve-outs at their own rates after the base group.
pub fn build_groups(
	trainable: Vec<(String, Tensor)>,
	learning_rate: f64,
	weight_decay: f64,
	span_head_learning_rate: Option<f64>,
	classifier_learning_rate: Option<f64>,
) -> Result<Vec<Group>> {
	let group = |label: &str, params: Vec<(String, Tensor)>, lr: f64| Group {
		label: label.to_owned(),
		params,
		lr,
		initial_lr: lr,
		weight_decay,
	};
	let mut carveouts: Vec<(Vec<&str>, f64, &str)> = Vec::new();
	if let Some(lr) = span_head_learning_rate {
		carveouts.push((vec!["span_scorer.", "semi_crf."], lr, "span_head_learning_rate"));
	}
	if let Some(lr) = classifier_learning_rate {
		carveouts.push((
			vec![
				"classifier.",
				"street_type_projection.",
				"street_type_token_embedding",
				"locality_surface_projection.",
				"locality_surface_token_embedding",
				"code_unit_projection.",
				"code_unit_token_embedding",
			],
			lr,
			"classifier_learning_rate",
		));
	}
	if carveouts.is_empty() {
		return Ok(vec![group("base", trainable, learning_rate)]);
	}
	let mut groups = Vec::new();
	let mut rest = trainable;
	for (prefixes, lr, key) in carveouts {
		let (head, others): (Vec<_>, Vec<_>) = rest
			.into_iter()
			.partition(|(n, _)| prefixes.iter().any(|p| n.starts_with(p)));
		rest = others;
		if head.is_empty() {
			return Err(fail!(
				"train.{key} is set but no params match prefixes {prefixes:?} — check the model config enables the \
				 corresponding module, or drop the override"
			));
		}
		groups.push(group(key, head, lr));
	}
	if !rest.is_empty() {
		groups.insert(0, group("base", rest, learning_rate));
	}
	Ok(groups)
}
