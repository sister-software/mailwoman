//! `torch.optim.AdamW` on the CPU path, `clip_grad_norm_`, and `optim/groups.py`'s parameter groups.
//!
//! The step is torch 2.13's `_single_tensor_adam` with decoupled weight decay, the path a CPU parameter takes:
//! each scalar is computed in `f64` as Python computes it and each tensor operation is the one Python issues. A
//! parameter without a gradient is skipped, as `zero_grad(set_to_none=True)` leaves it.

use crate::{fail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tch::{Kind, Tensor};
use trainer_model::autocast::{clear_grad, vector_norm};

/// One parameter group: its parameters by name, and its rates.
pub struct Group {
	pub label: String,
	pub params: Vec<(String, Tensor)>,
	pub lr: f64,
	pub initial_lr: f64,
	pub weight_decay: f64,
}

/// One parameter's AdamW state.
pub struct ParamState {
	pub step: Tensor,
	pub exp_avg: Tensor,
	pub exp_avg_sq: Tensor,
}

pub struct AdamW {
	pub groups: Vec<Group>,
	pub betas: (f64, f64),
	pub eps: f64,
	/// By parameter name; absent until the parameter's first step.
	pub state: Vec<(String, ParamState)>,
}

impl AdamW {
	pub fn new(groups: Vec<Group>) -> Self {
		Self {
			groups,
			betas: (0.9, 0.999),
			eps: 1e-8,
			state: Vec::new(),
		}
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
	pub fn step(&mut self) {
		let (beta1, beta2) = self.betas;
		let eps = self.eps;
		tch::no_grad(|| {
			for group in &self.groups {
				let lr = group.lr;
				let wd = group.weight_decay;
				for (name, param) in &group.params {
					let grad = param.grad();
					if !grad.defined() {
						continue;
					}
					let index = match self.state.iter().position(|(n, _)| n == name) {
						Some(i) => i,
						None => {
							self.state.push((
								name.clone(),
								ParamState {
									step: Tensor::zeros([], (Kind::Float, tch::Device::Cpu)),
									exp_avg: param.zeros_like(),
									exp_avg_sq: param.zeros_like(),
								},
							));
							self.state.len() - 1
						}
					};
					let state = &mut self.state[index].1;
					let _ = state.step.g_add_scalar_(1.0);
					let mut param = param.shallow_clone();
					if wd != 0.0 {
						let _ = param.g_mul_scalar_(1.0 - lr * wd);
					}
					let _ = state.exp_avg.lerp_(&grad, 1.0 - beta1);
					let _ = state.exp_avg_sq.g_mul_scalar_(beta2);
					// `addcmul_(grad, grad, value=1 - beta2)` computes `self + (value * grad) * grad`.
					let scaled = &grad * (1.0 - beta2);
					let _ = state.exp_avg_sq.addcmul_(&scaled, &grad);
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
			tensors.push((format!("{name}.exp_avg"), s.exp_avg.detach().to_device(tch::Device::Cpu)));
			tensors.push((format!("{name}.exp_avg_sq"), s.exp_avg_sq.detach().to_device(tch::Device::Cpu)));
			tensors.push((format!("{name}.step"), s.step.shallow_clone()));
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
		for name in &doc.state {
			let device = self
				.params()
				.find(|(n, _)| n == name)
				.map(|(_, p)| p.device())
				.ok_or_else(|| fail!("the optimizer state names {name}, which no group holds"))?;
			self.state.push((
				name.clone(),
				ParamState {
					step: take(format!("{name}.step"))?,
					exp_avg: take(format!("{name}.exp_avg"))?.to_device(device),
					exp_avg_sq: take(format!("{name}.exp_avg_sq"))?.to_device(device),
				},
			));
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
pub fn clip_grad_norm(params: &[&Tensor], max_norm: f64) -> Result<Option<Tensor>> {
	let grads: Vec<Tensor> = params.iter().map(|p| p.grad()).filter(Tensor::defined).collect();
	if grads.is_empty() {
		return Ok(None);
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
				"deploc_head.",
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
