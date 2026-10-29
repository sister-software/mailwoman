//! Compiles the autocast shim against the libtorch that `torch-sys` links.
//!
//! `torch-sys` declares `links = "tch"` and prints `cargo:libtorch_lib=<dir>`, which reaches this script as
//! `DEP_TCH_LIBTORCH_LIB`. The headers sit beside that directory, as in the `libtorch-shared-with-deps` archive.

use std::path::PathBuf;

fn main() {
	println!("cargo:rerun-if-changed=csrc/autocast.cpp");
	let lib = PathBuf::from(
		std::env::var("DEP_TCH_LIBTORCH_LIB").expect("torch-sys reports the libtorch library directory"),
	);
	let root = lib.parent().expect("the libtorch library directory has a parent").to_path_buf();
	cc::Build::new()
		.cpp(true)
		.pic(true)
		.warnings(false)
		.include(root.join("include"))
		.include(root.join("include/torch/csrc/api/include"))
		.flag("-std=c++17")
		.flag("-D_GLIBCXX_USE_CXX11_ABI=1")
		.flag("-DGLOG_USE_GLOG_EXPORT")
		.file("csrc/autocast.cpp")
		.compile("trainer_autocast");
}
