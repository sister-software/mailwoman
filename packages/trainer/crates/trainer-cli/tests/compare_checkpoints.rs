//! `trainer compare-checkpoints` exits 0 on two equal checkpoints and 1 when a tensor is in one checkpoint only.

use std::path::Path;
use std::process::Command;
use tch::{Kind, Tensor};
use trainer_model::checkpoint::MODEL_FILE;

fn write_weights(dir: &Path, tensors: &[(&str, &Tensor)]) {
	std::fs::create_dir_all(dir).unwrap();
	Tensor::write_safetensors(tensors, dir.join(MODEL_FILE)).unwrap();
}

fn compare(a: &Path, b: &Path) -> (Option<i32>, String) {
	let output = Command::new(env!("CARGO_BIN_EXE_trainer"))
		.arg("compare-checkpoints")
		.arg(a)
		.arg(b)
		.output()
		.unwrap();
	(
		output.status.code(),
		String::from_utf8_lossy(&output.stdout).into_owned(),
	)
}

#[test]
fn the_command_exits_by_the_comparison_and_states_its_scope() {
	let root = tempfile::tempdir().unwrap();
	let w = Tensor::from_slice(&[1.0f32, 2.0]).to_kind(Kind::Float);
	let extra = Tensor::from_slice(&[3.0f32]).to_kind(Kind::Float);
	write_weights(&root.path().join("a"), &[("w", &w)]);
	write_weights(&root.path().join("b"), &[("w", &w)]);
	write_weights(&root.path().join("c"), &[("w", &w), ("extra", &extra)]);

	let (code, stdout) = compare(&root.path().join("a"), &root.path().join("b"));
	assert_eq!(code, Some(0), "{stdout}");
	assert!(
		stdout.contains("optimizer, scheduler and training_state.json are not compared"),
		"{stdout}"
	);

	let (code, stdout) = compare(&root.path().join("a"), &root.path().join("c"));
	assert_eq!(code, Some(1), "{stdout}");
	assert!(stdout.contains("extra is in the second checkpoint only"), "{stdout}");
}
