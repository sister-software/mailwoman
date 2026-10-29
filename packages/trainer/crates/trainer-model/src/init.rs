//! `torch.nn.init` and the default `reset_parameters` of the modules the encoder uses, in torch 2.13's arithmetic.
//!
//! Each initializer computes its bound in `f64` with the same operations as the Python function and then issues
//! the one `uniform_` or `normal_` call it issues, so the same generator state gives the same draws.

use tch::Tensor;

/// `_calculate_fan_in_and_fan_out`: dimension 1 and dimension 0, each times the receptive field.
pub fn fans(tensor: &Tensor) -> (i64, i64) {
	let size = tensor.size();
	let receptive: i64 = size[2..].iter().product();
	(size[1] * receptive, size[0] * receptive)
}

fn uniform(tensor: &Tensor, a: f64, b: f64) {
	tch::no_grad(|| {
		let _ = tensor.shallow_clone().uniform_(a, b);
	});
}

/// `init.uniform_(tensor, a, b)`.
pub fn uniform_(tensor: &Tensor, a: f64, b: f64) {
	uniform(tensor, a, b);
}

/// `init.normal_(tensor, mean, std)`.
pub fn normal_(tensor: &Tensor, mean: f64, std: f64) {
	tch::no_grad(|| {
		let _ = tensor.shallow_clone().normal_(mean, std);
	});
}

/// `init.zeros_`.
pub fn zeros_(tensor: &Tensor) {
	tch::no_grad(|| {
		let _ = tensor.shallow_clone().zero_();
	});
}

/// `init.ones_`.
pub fn ones_(tensor: &Tensor) {
	tch::no_grad(|| {
		let _ = tensor.shallow_clone().fill_(1.0);
	});
}

/// `init.xavier_uniform_(tensor, gain=1.0)`.
pub fn xavier_uniform_(tensor: &Tensor) {
	let (fan_in, fan_out) = fans(tensor);
	let std = 1.0 * (2.0 / (fan_in + fan_out) as f64).sqrt();
	let a = 3.0f64.sqrt() * std;
	uniform(tensor, -a, a);
}

/// `init.kaiming_uniform_(tensor, a=math.sqrt(5))`, the default weight init of `Linear` and `Conv1d`.
pub fn kaiming_uniform_sqrt5_(tensor: &Tensor) {
	let negative_slope = 5.0f64.sqrt();
	let gain = (2.0 / (1.0 + negative_slope.powf(2.0))).sqrt();
	let (fan_in, _) = fans(tensor);
	let std = gain / (fan_in as f64).sqrt();
	let bound = 3.0f64.sqrt() * std;
	uniform(tensor, -bound, bound);
}

/// The bias init of `Linear` and `Conv1d`: uniform in `±1/sqrt(fan_in)` of the weight, or 0 for an empty fan.
pub fn bias_uniform_(bias: &Tensor, weight: &Tensor) {
	let (fan_in, _) = fans(weight);
	let bound = if fan_in > 0 { 1.0 / (fan_in as f64).sqrt() } else { 0.0 };
	uniform(bias, -bound, bound);
}
