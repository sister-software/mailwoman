// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Compiles the autocast, runtime and optimizer shims, and the CUDA graph shim against a CUDA libtorch, against the libtorch that `torch-sys` links, and records the locked `tch`
//! version for the runtime block of a parity record.
//!
//! `torch-sys` declares `links = "tch"` and prints `cargo:libtorch_lib=<dir>`, which reaches this script as
//! `DEP_TCH_LIBTORCH_LIB`. The headers sit beside that directory, as in the `libtorch-shared-with-deps` archive.

use std::path::PathBuf;

fn main() {
	println!("cargo:rerun-if-changed=csrc/autocast.cpp");
	println!("cargo:rerun-if-changed=csrc/runtime.cpp");
	println!("cargo:rerun-if-changed=csrc/optim.cpp");
	println!("cargo:rerun-if-changed=csrc/graph.cpp");
	println!("cargo:rerun-if-changed=../../Cargo.lock");
	println!("cargo:rustc-env=TRAINER_TCH_VERSION={}", locked_version("tch"));
	let lib =
		PathBuf::from(std::env::var("DEP_TCH_LIBTORCH_LIB").expect("torch-sys reports the libtorch library directory"));
	// The crate's tests find libtorch's shared libraries through an rpath, with no LD_LIBRARY_PATH.
	println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
	let root = lib
		.parent()
		.expect("the libtorch library directory has a parent")
		.to_path_buf();
	let shim = || {
		let mut build = cc::Build::new();
		build
			.cpp(true)
			.pic(true)
			.warnings(false)
			.include(root.join("include"))
			.include(root.join("include/torch/csrc/api/include"))
			.flag("-std=c++17")
			.flag("-D_GLIBCXX_USE_CXX11_ABI=1")
			.flag("-DGLOG_USE_GLOG_EXPORT");
		build
	};
	shim()
		.file("csrc/autocast.cpp")
		.file("csrc/runtime.cpp")
		.file("csrc/optim.cpp")
		.compile("trainer_autocast");
	// `csrc/graph.cpp` wraps `at::cuda::CUDAGraph`, which `libtorch_cuda.so` defines and the CUDA headers declare. A
	// CPU libtorch ships the headers' libtorch half but no `libtorch_cuda.so`, so the file is compiled only against a
	// CUDA libtorch, and `trainer_cuda_graph` tells `src/cuda_graph.rs` the symbols exist.
	println!("cargo:rustc-check-cfg=cfg(trainer_cuda_graph)");
	println!("cargo:rerun-if-env-changed={CUDA_INCLUDE_VARIABLE}");
	if !lib.join("libtorch_cuda.so").is_file() {
		return;
	}
	let includes = cuda_include_dirs();
	let mut build = shim();
	for dir in &includes {
		build.include(dir);
	}
	build.file("csrc/graph.cpp").compile("trainer_cuda_graph");
	println!("cargo:rustc-link-lib=dylib=torch_cuda");
	println!("cargo:rustc-link-lib=dylib=c10_cuda");
	println!("cargo:rustc-cfg=trainer_cuda_graph");
}

/// The variable that names the CUDA header directories, separated by `:`.
const CUDA_INCLUDE_VARIABLE: &str = "TRAINER_CUDA_INCLUDE";

/// The directories that hold `cuda.h` and `cuda_runtime_api.h`: those `TRAINER_CUDA_INCLUDE` names, or
/// `$CUDA_HOME/include`, or `/usr/local/cuda/include`.
///
/// A CUDA libtorch without these headers would build a trainer that can't capture a graph, and `train.cuda_graph`
/// would then fall back to the eager step on every run. The build refuses instead.
fn cuda_include_dirs() -> Vec<PathBuf> {
	let dirs: Vec<PathBuf> = match std::env::var(CUDA_INCLUDE_VARIABLE) {
		Ok(value) if !value.is_empty() => std::env::split_paths(&value).collect(),
		_ => {
			let home = std::env::var("CUDA_HOME").unwrap_or_else(|_| "/usr/local/cuda".to_owned());
			vec![PathBuf::from(home).join("include")]
		}
	};
	for header in ["cuda.h", "cuda_runtime_api.h"] {
		if !dirs.iter().any(|d| d.join(header).is_file()) {
			panic!(
				"the linked libtorch is a CUDA build, but none of {dirs:?} holds {header}; set {CUDA_INCLUDE_VARIABLE} \
				 to the CUDA include directories so csrc/graph.cpp compiles"
			);
		}
	}
	dirs
}

/// The version of `package` in the workspace's `Cargo.lock`, which is the version compiled into this build. A crate's
/// version is fixed when it is compiled, so it is read here rather than at run time.
fn locked_version(package: &str) -> String {
	let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
	let lock_path = manifest.join("../../../../Cargo.lock");
	let lock = std::fs::read_to_string(&lock_path).unwrap_or_else(|e| panic!("{}: {e}", lock_path.display()));
	let name_line = format!("name = \"{package}\"");
	let mut lines = lock.lines();
	let mut versions = Vec::new();
	while let Some(line) = lines.next() {
		if line == name_line {
			if let Some(version) = lines.next().and_then(|l| l.strip_prefix("version = \"")) {
				versions.push(version.trim_end_matches('"').to_owned());
			}
		}
	}
	match versions.as_slice() {
		[one] => one.clone(),
		_ => panic!(
			"{} names {} versions of {package}: {versions:?}",
			lock_path.display(),
			versions.len()
		),
	}
}
