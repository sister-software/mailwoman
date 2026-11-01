//! The runtime a Rust parity record was measured on: the counterpart of the Python reference's `runtime` block.
//!
//! The Python side recorded the interpreter version, `torch`, `threads` and `cpu_capability`. The Rust side records the `tch` crate
//! version compiled into the binary, the version of the libtorch the process loaded, that library's path, libtorch's
//! thread count and ATen's CPU capability. Everything except the `tch` version is read from the loaded library when
//! the record is written, because a binary can run against a libtorch other than the one it was built beside.

use crate::{fail, Result};
use serde::Serialize;
use std::ffi::{c_char, CStr};
use std::path::Path;

extern "C" {
	fn trainer_show_config() -> *mut c_char;
	fn trainer_cpu_capability() -> *mut c_char;
	fn trainer_libtorch_library() -> *mut c_char;
	fn trainer_free_string(value: *mut c_char);
}

/// The `tch` version in the workspace's `Cargo.lock` when this crate was compiled.
pub const TCH_VERSION: &str = env!("TRAINER_TCH_VERSION");

/// One record's runtime block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Runtime {
	/// The `tch` crate version compiled into the binary.
	pub tch: String,
	/// `TORCH_VERSION` from the loaded libtorch's build settings, such as `2.13.0`.
	pub libtorch: String,
	/// The `build-version` file of the libtorch archive that holds the loaded library, such as `2.13.0+cpu`. It names
	/// the CPU or CUDA variant that the build settings leave out. `None` when that directory has no such file, as a
	/// libtorch inside a Python wheel has none.
	pub libtorch_build: Option<String>,
	/// The shared object that defines `at::show_config`.
	pub libtorch_library: String,
	/// `at::get_num_threads()`, the intra-op thread count the record's kernels ran with.
	pub threads: i64,
	/// `at::get_cpu_capability()`, the kernel set ATen dispatches to, such as `AVX512`.
	pub cpu_capability: String,
}

/// Takes a heap string from the shim, or names what libtorch did not report.
fn take(ptr: *mut c_char, what: &str) -> Result<String> {
	if ptr.is_null() {
		return Err(fail!("libtorch did not report {what}"));
	}
	// SAFETY: the shim returns a NUL-terminated heap copy that this function frees once.
	let value = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
	unsafe { trainer_free_string(ptr) };
	Ok(value)
}

/// The `TORCH_VERSION=` entry of `at::show_config()`'s build settings.
pub fn torch_version_from_config(config: &str) -> Result<String> {
	config
		.split(|c: char| c == ',' || c.is_whitespace())
		.find_map(|field| field.strip_prefix("TORCH_VERSION="))
		.filter(|v| !v.is_empty())
		.map(str::to_owned)
		.ok_or_else(|| fail!("at::show_config() names no TORCH_VERSION in its build settings:\n{config}"))
}

/// The `build-version` file beside the `lib/` directory that holds `library`, as the libtorch archive lays it out.
pub fn build_version_beside(library: &Path) -> Result<Option<String>> {
	let Some(root) = library.parent().and_then(Path::parent) else {
		return Ok(None);
	};
	let path = root.join("build-version");
	match std::fs::read_to_string(&path) {
		Ok(text) => Ok(Some(text.trim().to_owned())),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(e) => Err(fail!("{}: {e}", path.display())),
	}
}

/// Reads the runtime block from the loaded libtorch.
pub fn read() -> Result<Runtime> {
	// SAFETY: each shim call returns a heap string or null.
	let config = take(unsafe { trainer_show_config() }, "its build configuration")?;
	let libtorch_library = take(unsafe { trainer_libtorch_library() }, "the path of its shared library")?;
	let cpu_capability = take(unsafe { trainer_cpu_capability() }, "its CPU capability")?;
	Ok(Runtime {
		tch: TCH_VERSION.to_owned(),
		libtorch: torch_version_from_config(&config)?,
		libtorch_build: build_version_beside(Path::new(&libtorch_library))?,
		libtorch_library,
		threads: tch::get_num_threads() as i64,
		cpu_capability,
	})
}
