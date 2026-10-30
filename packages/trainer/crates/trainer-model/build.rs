//! Compiles the autocast and runtime shims against the libtorch that `torch-sys` links, and records the locked `tch`
//! version for the runtime block of a parity record.
//!
//! `torch-sys` declares `links = "tch"` and prints `cargo:libtorch_lib=<dir>`, which reaches this script as
//! `DEP_TCH_LIBTORCH_LIB`. The headers sit beside that directory, as in the `libtorch-shared-with-deps` archive.

use std::path::PathBuf;

fn main() {
	println!("cargo:rerun-if-changed=csrc/autocast.cpp");
	println!("cargo:rerun-if-changed=csrc/runtime.cpp");
	println!("cargo:rerun-if-changed=../../Cargo.lock");
	println!("cargo:rustc-env=TRAINER_TCH_VERSION={}", locked_version("tch"));
	let lib =
		PathBuf::from(std::env::var("DEP_TCH_LIBTORCH_LIB").expect("torch-sys reports the libtorch library directory"));
	let root = lib
		.parent()
		.expect("the libtorch library directory has a parent")
		.to_path_buf();
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
		.file("csrc/runtime.cpp")
		.compile("trainer_autocast");
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
