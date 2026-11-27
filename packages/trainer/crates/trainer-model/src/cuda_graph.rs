// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `torch.cuda.CUDAGraph` over `csrc/graph.cpp`: capture a region of CUDA work once, then replay it.
//!
//! The build script compiles the shim only against a CUDA libtorch, so a binary linked to the CPU libtorch holds no
//! graph symbols. [`compiled`] says which build this is, and [`available`] also asks for a CUDA device. Every other
//! function refuses in a build without the shim.
//!
//! A captured region must issue the same kernels on the same addresses every time: no host read of a device value,
//! no shape that varies, and no allocation outside the graph's pool that a replay would need. A replay reruns the
//! kernels on whatever the captured input tensors hold at that moment.

use crate::{fail, Result};

#[cfg(trainer_cuda_graph)]
mod shim {
	use crate::multi_tensor::message;
	use crate::{fail, Result};
	use std::ffi::{c_char, c_void};

	const ERROR_BYTES: usize = 1024;

	extern "C" {
		fn trainer_cuda_graph_device_count() -> i32;
		fn trainer_cuda_graph_pool_handle(first: *mut u64, second: *mut u64, err: *mut c_char, err_len: usize) -> i32;
		fn trainer_cuda_graph_new(err: *mut c_char, err_len: usize) -> *mut c_void;
		fn trainer_cuda_graph_capture_begin(
			handle: *mut c_void,
			device: i32,
			pool_first: u64,
			pool_second: u64,
			err: *mut c_char,
			err_len: usize,
		) -> i32;
		fn trainer_cuda_graph_capture_end(handle: *mut c_void, err: *mut c_char, err_len: usize) -> i32;
		fn trainer_cuda_graph_replay(handle: *mut c_void, err: *mut c_char, err_len: usize) -> i32;
		fn trainer_cuda_graph_free(handle: *mut c_void);
	}

	/// Runs a shim call that reports failure through `err`.
	fn call(what: &str, f: impl FnOnce(*mut c_char, usize) -> i32) -> Result<()> {
		let mut err = vec![0 as c_char; ERROR_BYTES];
		if f(err.as_mut_ptr(), ERROR_BYTES) != 0 {
			return Err(fail!("libtorch refused {what}: {}", message(&err)));
		}
		Ok(())
	}

	pub fn device_count() -> i32 {
		// SAFETY: a read of the CUDA runtime's device count.
		unsafe { trainer_cuda_graph_device_count() }
	}

	pub fn pool_handle() -> Result<(u64, u64)> {
		let (mut first, mut second) = (0u64, 0u64);
		// SAFETY: the shim writes two integers through the pointers.
		call("graph_pool_handle", |err, len| unsafe {
			trainer_cuda_graph_pool_handle(&mut first, &mut second, err, len)
		})?;
		Ok((first, second))
	}

	pub fn new() -> Result<*mut c_void> {
		let mut err = vec![0 as c_char; ERROR_BYTES];
		// SAFETY: returns a heap graph or null.
		let handle = unsafe { trainer_cuda_graph_new(err.as_mut_ptr(), ERROR_BYTES) };
		if handle.is_null() {
			return Err(fail!("libtorch refused a CUDAGraph: {}", message(&err)));
		}
		Ok(handle)
	}

	pub fn capture_begin(handle: *mut c_void, device: i32, pool: (u64, u64)) -> Result<()> {
		// SAFETY: `handle` is a live graph `new` returned.
		call("capture_begin", |err, len| unsafe {
			trainer_cuda_graph_capture_begin(handle, device, pool.0, pool.1, err, len)
		})
	}

	pub fn capture_end(handle: *mut c_void) -> Result<()> {
		// SAFETY: `handle` is a live graph `new` returned.
		call("capture_end", |err, len| unsafe {
			trainer_cuda_graph_capture_end(handle, err, len)
		})
	}

	pub fn replay(handle: *mut c_void) -> Result<()> {
		// SAFETY: `handle` is a live graph `new` returned.
		call("replay", |err, len| unsafe {
			trainer_cuda_graph_replay(handle, err, len)
		})
	}

	pub fn free(handle: *mut c_void) {
		// SAFETY: frees the graph `new` returned, once.
		unsafe { trainer_cuda_graph_free(handle) }
	}
}

/// Whether this binary holds the CUDA graph shim: true only when it was built against a CUDA libtorch.
pub const fn compiled() -> bool {
	cfg!(trainer_cuda_graph)
}

/// Whether a graph can be captured here: the shim is compiled in and the process sees a CUDA device.
pub fn available() -> bool {
	#[cfg(trainer_cuda_graph)]
	{
		shim::device_count() > 0
	}
	#[cfg(not(trainer_cuda_graph))]
	{
		false
	}
}

#[cfg(not(trainer_cuda_graph))]
fn not_compiled() -> crate::Error {
	fail!("this trainer was built against a CPU libtorch, which holds no CUDA graph support")
}

/// A memory pool several graphs share, `torch.cuda.graph_pool_handle()`. Graphs that share a pool reuse each other's
/// temporaries, which is safe when no graph reads another's output after that other graph's next replay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pool(
	#[cfg_attr(not(trainer_cuda_graph), allow(dead_code))] u64,
	#[cfg_attr(not(trainer_cuda_graph), allow(dead_code))] u64,
);

impl Pool {
	pub fn new() -> Result<Self> {
		#[cfg(trainer_cuda_graph)]
		{
			let (a, b) = shim::pool_handle()?;
			Ok(Self(a, b))
		}
		#[cfg(not(trainer_cuda_graph))]
		{
			Err(not_compiled())
		}
	}
}

/// One CUDA graph. Dropping it frees the graph and its executable.
pub struct CudaGraph {
	#[cfg_attr(not(trainer_cuda_graph), allow(dead_code))]
	handle: *mut std::ffi::c_void,
	captured: bool,
}

impl CudaGraph {
	pub fn new() -> Result<Self> {
		#[cfg(trainer_cuda_graph)]
		{
			Ok(Self {
				handle: shim::new()?,
				captured: false,
			})
		}
		#[cfg(not(trainer_cuda_graph))]
		{
			Err(not_compiled())
		}
	}

	/// Records the CUDA work `region` issues on device `device` into this graph, with its allocations in `pool`.
	///
	/// The region runs on a side stream, and its kernels are recorded rather than run: the work happens at the first
	/// [`replay`](Self::replay). The default CUDA generator's state is registered first, so each replay draws fresh
	/// random values. A failure inside `region` still closes the capture before it is returned.
	pub fn capture<T, E: From<crate::Error>>(
		&mut self,
		device: usize,
		pool: Pool,
		region: impl FnOnce() -> std::result::Result<T, E>,
	) -> std::result::Result<T, E> {
		if self.captured {
			return Err(fail!("this CUDA graph is already captured").into());
		}
		#[cfg(trainer_cuda_graph)]
		{
			shim::capture_begin(self.handle, device as i32, (pool.0, pool.1))?;
			let out = region();
			let closed = shim::capture_end(self.handle);
			let out = out?;
			closed?;
			self.captured = true;
			Ok(out)
		}
		#[cfg(not(trainer_cuda_graph))]
		{
			let _ = (device, pool, region);
			Err(not_compiled().into())
		}
	}

	/// Runs the captured work on the current stream.
	pub fn replay(&self) -> Result<()> {
		if !self.captured {
			return Err(fail!("replay of a CUDA graph that holds no capture"));
		}
		#[cfg(trainer_cuda_graph)]
		{
			shim::replay(self.handle)
		}
		#[cfg(not(trainer_cuda_graph))]
		{
			Err(not_compiled())
		}
	}
}

impl Drop for CudaGraph {
	fn drop(&mut self) {
		#[cfg(trainer_cuda_graph)]
		{
			shim::free(self.handle);
		}
	}
}
