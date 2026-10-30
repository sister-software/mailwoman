//! `torch.autocast(device_type, dtype)` as a guard.
//!
//! The Python loop runs the forward pass inside `torch.autocast` on an NVIDIA device in bf16 (#2871), and the
//! staged comparison runs it on the CPU. Both need the per-device autocast state, which `csrc/autocast.cpp` sets.

use crate::{fail, Result};
use tch::{Device, Kind};

extern "C" {
	fn trainer_autocast_enter(
		device: i32,
		enabled: i32,
		dtype: i32,
		prev_enabled: *mut i32,
		prev_dtype: *mut i32,
		prev_cache: *mut i32,
	) -> i32;
	fn trainer_autocast_exit(device: i32, prev_enabled: i32, prev_dtype: i32, prev_cache: i32) -> i32;
	fn trainer_autocast_is_enabled(device: i32) -> i32;
	fn trainer_grad_enabled() -> i32;
	fn trainer_clear_grad(t: *mut torch_sys::C_tensor);
	fn trainer_vector_norm(t: *const torch_sys::C_tensor) -> *mut torch_sys::C_tensor;
	fn trainer_generator_new(seed: u64) -> *mut std::ffi::c_void;
	fn trainer_generator_free(g: *mut std::ffi::c_void);
	fn trainer_bernoulli(probs: *const torch_sys::C_tensor, g: *mut std::ffi::c_void) -> *mut torch_sys::C_tensor;
	fn trainer_randint(
		low: i64,
		high: i64,
		shape: *const i64,
		ndim: i32,
		g: *mut std::ffi::c_void,
	) -> *mut torch_sys::C_tensor;
	fn trainer_default_generator_state(cuda_index: i32) -> *mut torch_sys::C_tensor;
	fn trainer_default_generator_set_state(cuda_index: i32, state: *const torch_sys::C_tensor) -> i32;
	fn trainer_generator_state(g: *mut std::ffi::c_void) -> *mut torch_sys::C_tensor;
	fn trainer_generator_set_state(g: *mut std::ffi::c_void, state: *const torch_sys::C_tensor) -> i32;
}

fn cuda_index(device: Device) -> i32 {
	match device {
		Device::Cuda(index) => index as i32,
		_ => -1,
	}
}

/// The state of the default generator on `device`, which `torch.rand`, `randint` and dropout draw from, as a uint8
/// tensor.
pub fn default_generator_state(device: Device) -> Result<tch::Tensor> {
	// SAFETY: returns a heap tensor or null.
	owned(
		unsafe { trainer_default_generator_state(cuda_index(device)) },
		"the default generator's state",
	)
}

/// Restores the default generator on `device` to a state `default_generator_state` read.
pub fn set_default_generator_state(device: Device, state: &tch::Tensor) -> Result<()> {
	// SAFETY: `state` is live for the call.
	match unsafe { trainer_default_generator_set_state(cuda_index(device), state.as_ptr()) } {
		0 => Ok(()),
		_ => Err(fail!("libtorch refused the default generator state for {device:?}")),
	}
}

fn owned(ptr: *mut torch_sys::C_tensor, what: &str) -> Result<tch::Tensor> {
	if ptr.is_null() {
		return Err(fail!("libtorch refused {what}"));
	}
	// SAFETY: the shim returns a heap `at::Tensor` the handle takes ownership of.
	Ok(unsafe { tch::Tensor::from_ptr(ptr) })
}

/// A CPU generator of its own, `torch.Generator().manual_seed(seed)`.
pub struct Generator(*mut std::ffi::c_void);

impl Generator {
	pub fn new(seed: u64) -> Result<Self> {
		// SAFETY: returns a heap generator or null.
		let ptr = unsafe { trainer_generator_new(seed) };
		if ptr.is_null() {
			return Err(fail!("libtorch refused to create a generator"));
		}
		Ok(Self(ptr))
	}

	/// `torch.bernoulli(probs, generator=self)`.
	pub fn bernoulli(&mut self, probs: &tch::Tensor) -> Result<tch::Tensor> {
		// SAFETY: both pointers are live for the call.
		owned(unsafe { trainer_bernoulli(probs.as_ptr(), self.0) }, "bernoulli")
	}

	/// `torch.randint(low, high, shape, generator=self)`.
	pub fn randint(&mut self, low: i64, high: i64, shape: &[i64]) -> Result<tch::Tensor> {
		// SAFETY: `shape` outlives the call.
		owned(
			unsafe { trainer_randint(low, high, shape.as_ptr(), shape.len() as i32, self.0) },
			"randint",
		)
	}

	/// `generator.get_state()`, a uint8 tensor.
	pub fn state(&self) -> Result<tch::Tensor> {
		// SAFETY: the generator is live for the call.
		owned(unsafe { trainer_generator_state(self.0) }, "a generator's state")
	}

	/// `generator.set_state(state)`.
	pub fn set_state(&mut self, state: &tch::Tensor) -> Result<()> {
		// SAFETY: both pointers are live for the call.
		match unsafe { trainer_generator_set_state(self.0, state.as_ptr()) } {
			0 => Ok(()),
			_ => Err(fail!("libtorch refused the generator state")),
		}
	}
}

impl Drop for Generator {
	fn drop(&mut self) {
		// SAFETY: frees the generator `new` allocated.
		unsafe { trainer_generator_free(self.0) }
	}
}

/// `param.grad = None`.
pub fn clear_grad(tensor: &mut tch::Tensor) {
	// SAFETY: `as_mut_ptr` is the live `at::Tensor` the handle owns.
	unsafe { trainer_clear_grad(tensor.as_mut_ptr()) }
}

/// `torch.linalg.vector_norm(tensor, 2)`.
pub fn vector_norm(tensor: &tch::Tensor) -> Result<tch::Tensor> {
	// SAFETY: the shim returns a heap `at::Tensor` the new handle takes ownership of, or null.
	let ptr = unsafe { trainer_vector_norm(tensor.as_ptr()) };
	if ptr.is_null() {
		return Err(fail!("libtorch refused linalg_vector_norm"));
	}
	Ok(unsafe { tch::Tensor::from_ptr(ptr) })
}

/// `torch.is_grad_enabled()`.
pub fn grad_enabled() -> bool {
	// SAFETY: a read of libtorch's thread-local grad mode.
	unsafe { trainer_grad_enabled() == 1 }
}

fn device_code(device: Device) -> i32 {
	match device {
		Device::Cuda(_) => 1,
		_ => 0,
	}
}

fn dtype_code(kind: Kind) -> Result<i32> {
	match kind {
		Kind::BFloat16 => Ok(0),
		Kind::Half => Ok(1),
		other => Err(fail!("autocast runs in bfloat16 or float16, not {other:?}")),
	}
}

/// An open autocast region. Dropping it leaves the region and restores the state it replaced.
pub struct Autocast {
	device: i32,
	prev: (i32, i32, i32),
}

impl Autocast {
	fn open(device: Device, enabled: bool, dtype: i32) -> Result<Self> {
		let code = device_code(device);
		let mut prev = (0, 0, 0);
		// SAFETY: the shim writes three ints through the pointers and touches no other memory.
		let status =
			unsafe { trainer_autocast_enter(code, i32::from(enabled), dtype, &mut prev.0, &mut prev.1, &mut prev.2) };
		if status != 0 {
			return Err(fail!("libtorch refused to change autocast on {device:?}"));
		}
		Ok(Self { device: code, prev })
	}

	/// Enters autocast on `device`'s type in `kind`.
	pub fn enter(device: Device, kind: Kind) -> Result<Self> {
		Self::open(device, true, dtype_code(kind)?)
	}

	/// Whether autocast is on for `device`'s type.
	pub fn is_enabled(device: Device) -> bool {
		// SAFETY: a read of libtorch's thread-local autocast state.
		unsafe { trainer_autocast_is_enabled(device_code(device)) == 1 }
	}
}

impl Drop for Autocast {
	fn drop(&mut self) {
		// SAFETY: restores the state `open` read; the shim catches every libtorch exception.
		unsafe {
			trainer_autocast_exit(self.device, self.prev.0, self.prev.1, self.prev.2);
		}
	}
}

/// `torch.autocast(device_type, enabled=False)`: a region with autocast off, which the CRF's fp32 path opens.
pub struct AutocastOff(#[allow(dead_code)] Autocast);

impl AutocastOff {
	pub fn enter(device: Device) -> Result<Self> {
		Ok(Self(Autocast::open(device, false, -1)?))
	}
}

/// Runs `f` inside autocast when `kind` is set, and directly otherwise.
pub fn maybe<T>(device: Device, kind: Option<Kind>, f: impl FnOnce() -> T) -> Result<T> {
	let _guard = kind.map(|k| Autocast::enter(device, k)).transpose()?;
	Ok(f())
}
