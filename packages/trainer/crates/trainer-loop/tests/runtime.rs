//! The runtime block of a parity report: what it reads from the loaded libtorch, and its refusal of a build
//! configuration that names no version.

use trainer_loop::compare::StageResult;
use trainer_loop::parity::Report;
use trainer_model::runtime::{build_version_beside, read, torch_version_from_config, TCH_VERSION};

#[test]
fn the_torch_version_is_read_from_the_build_settings() {
	let config = "PyTorch built with:\n  - GCC 11.2\n  - Build settings: BLAS_INFO=mkl, BUILD_TYPE=Release, \
	              TORCH_VERSION=2.13.0, USE_CUDA=OFF, USE_MKL=ON,\n";
	assert_eq!(torch_version_from_config(config).unwrap(), "2.13.0");
}

#[test]
fn a_build_configuration_without_a_version_is_refused() {
	let error = torch_version_from_config("PyTorch built with:\n  - Build settings: BUILD_TYPE=Release\n")
		.unwrap_err()
		.to_string();
	assert!(error.contains("names no TORCH_VERSION"), "{error}");
}

#[test]
fn the_build_version_file_is_read_beside_the_library_directory() {
	let root = tempfile::tempdir().unwrap();
	std::fs::create_dir(root.path().join("lib")).unwrap();
	let library = root.path().join("lib/libtorch_cpu.so");
	assert_eq!(build_version_beside(&library).unwrap(), None);
	std::fs::write(root.path().join("build-version"), "2.13.0+cpu\n").unwrap();
	assert_eq!(build_version_beside(&library).unwrap().as_deref(), Some("2.13.0+cpu"));
}

#[test]
fn the_runtime_is_read_from_the_loaded_libtorch() {
	tch::set_num_threads(3);
	let runtime = read().unwrap();
	assert_eq!(runtime.tch, TCH_VERSION);
	assert_eq!(
		runtime.threads, 3,
		"the block reports the thread count set before it is read"
	);
	assert!(
		std::path::Path::new(&runtime.libtorch_library).is_file(),
		"{} is not a file",
		runtime.libtorch_library
	);
	let numeric = |v: &str| {
		!v.is_empty()
			&& v.split('.')
				.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
	};
	assert!(numeric(&runtime.tch), "tch {:?}", runtime.tch);
	assert!(numeric(&runtime.libtorch), "libtorch {:?}", runtime.libtorch);
	assert!(
		!runtime.cpu_capability.is_empty() && runtime.cpu_capability.bytes().all(|b| b.is_ascii_alphanumeric()),
		"cpu capability {:?}",
		runtime.cpu_capability
	);
	// The archive's build-version file and the library's own build settings are two sources for one version.
	if let Some(build) = &runtime.libtorch_build {
		assert_eq!(build.split('+').next(), Some(runtime.libtorch.as_str()));
	}
}

#[test]
fn a_report_carries_the_runtime_beside_the_stages() {
	let stages = vec![StageResult::new("construction", "exact")];
	let value = serde_json::to_value(Report::new(&stages).unwrap()).unwrap();
	for key in [
		"tch",
		"libtorch",
		"libtorch_build",
		"libtorch_library",
		"threads",
		"cpu_capability",
	] {
		assert!(value["runtime"].get(key).is_some(), "runtime has no {key}: {value}");
	}
	assert_eq!(value["stages"][0]["stage"], "construction");
}
