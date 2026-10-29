//! Links `libtorch_cuda.so` into the `trainer` binary when `LIBTORCH` is a CUDA build.
//!
//! `torch-sys` 0.26.0 passes `-ltorch_cuda`, but the binary calls no symbol from it, so the linker's `--as-needed`
//! drops the library from the binary's NEEDED entries. libtorch then never loads its CUDA backend, and
//! `Device::cuda_if_available()` returns the CPU on a GPU host. Linking the library between `--no-as-needed` and
//! `--as-needed` keeps it in NEEDED, as the Python wheel's `libtorch_python.so` does.

use std::path::PathBuf;

fn main() {
	println!("cargo:rerun-if-env-changed=LIBTORCH");
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
		return;
	}
	let Some(root) = std::env::var_os("LIBTORCH") else {
		return;
	};
	let lib = PathBuf::from(root).join("lib");
	if !lib.join("libtorch_cuda.so").is_file() {
		return;
	}
	println!("cargo:rustc-link-search=native={}", lib.display());
	println!("cargo:rustc-link-arg-bins=-Wl,--no-as-needed");
	println!("cargo:rustc-link-arg-bins=-ltorch_cuda");
	println!("cargo:rustc-link-arg-bins=-Wl,--as-needed");
}
