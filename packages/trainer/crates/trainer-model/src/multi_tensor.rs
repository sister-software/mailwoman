// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! libtorch's multi-tensor AdamW step and gradient clip, which `csrc/optim.cpp` calls.
//!
//! `tch` exposes no tensor-list operation. These two functions issue the ones `torch.optim.AdamW(fused=True)` and
//! `clip_grad_norm_(foreach=True)` issue, so a step launches one kernel per chunk of tensors instead of several per
//! tensor.

use crate::{fail, Result};
use std::ffi::{c_char, CStr};
use tch::Tensor;

const ERROR_BYTES: usize = 1024;

extern "C" {
	fn trainer_fused_adamw(
		params: *const *mut torch_sys::C_tensor,
		grads: *const *mut torch_sys::C_tensor,
		exp_avgs: *const *mut torch_sys::C_tensor,
		exp_avg_sqs: *const *mut torch_sys::C_tensor,
		steps: *const *mut torch_sys::C_tensor,
		n: usize,
		lr: f64,
		beta1: f64,
		beta2: f64,
		weight_decay: f64,
		eps: f64,
		err: *mut c_char,
		err_len: usize,
	) -> i32;
	fn trainer_clip_grad_norm_foreach(
		grads: *const *mut torch_sys::C_tensor,
		n: usize,
		max_norm: f64,
		err: *mut c_char,
		err_len: usize,
	) -> *mut torch_sys::C_tensor;
}

/// The libtorch message a failed call wrote.
fn message(buffer: &[c_char]) -> String {
	// SAFETY: the shim writes a NUL-terminated string within the buffer, or leaves its first byte NUL.
	unsafe { CStr::from_ptr(buffer.as_ptr()) }
		.to_string_lossy()
		.into_owned()
}

fn handles(tensors: &[&Tensor]) -> Vec<*mut torch_sys::C_tensor> {
	tensors.iter().map(|t| t.as_ptr() as *mut torch_sys::C_tensor).collect()
}

/// One AdamW step over a parameter group: each step count is incremented, then every parameter, both moments and
/// the decoupled weight decay are updated by `torch._fused_adamw_`.
///
/// The five lists are aligned by index. Every tensor sits on one device in one dtype, and each step count is a
/// float32 scalar on that device.
#[allow(clippy::too_many_arguments)]
pub fn fused_adamw(
	params: &[&Tensor],
	grads: &[&Tensor],
	exp_avgs: &[&Tensor],
	exp_avg_sqs: &[&Tensor],
	steps: &[&Tensor],
	lr: f64,
	betas: (f64, f64),
	weight_decay: f64,
	eps: f64,
) -> Result<()> {
	let n = params.len();
	if [grads.len(), exp_avgs.len(), exp_avg_sqs.len(), steps.len()]
		.iter()
		.any(|&len| len != n)
	{
		return Err(fail!(
			"fused_adamw takes aligned lists, got {n} parameters and lists of other lengths"
		));
	}
	let mut err = vec![0 as c_char; ERROR_BYTES];
	// SAFETY: each handle is a live `at::Tensor` borrowed for the call, and `err` holds `ERROR_BYTES` bytes.
	let status = unsafe {
		trainer_fused_adamw(
			handles(params).as_ptr(),
			handles(grads).as_ptr(),
			handles(exp_avgs).as_ptr(),
			handles(exp_avg_sqs).as_ptr(),
			handles(steps).as_ptr(),
			n,
			lr,
			betas.0,
			betas.1,
			weight_decay,
			eps,
			err.as_mut_ptr(),
			ERROR_BYTES,
		)
	};
	if status != 0 {
		return Err(fail!("libtorch refused _fused_adamw_: {}", message(&err)));
	}
	Ok(())
}

/// `clip_grad_norm_(grads, max_norm, foreach=True)`: scales every gradient in place by
/// `min(1, max_norm / (total + 1e-6))` and returns `total`, the 2-norm of every gradient before clipping.
pub fn clip_grad_norm_foreach(grads: &[&Tensor], max_norm: f64) -> Result<Tensor> {
	let mut err = vec![0 as c_char; ERROR_BYTES];
	// SAFETY: each handle is a live `at::Tensor` borrowed for the call, and `err` holds `ERROR_BYTES` bytes.
	let ptr = unsafe {
		trainer_clip_grad_norm_foreach(
			handles(grads).as_ptr(),
			grads.len(),
			max_norm,
			err.as_mut_ptr(),
			ERROR_BYTES,
		)
	};
	if ptr.is_null() {
		return Err(fail!("libtorch refused the foreach gradient clip: {}", message(&err)));
	}
	// SAFETY: the shim returns a heap `at::Tensor` the new handle takes ownership of.
	Ok(unsafe { Tensor::from_ptr(ptr) })
}
