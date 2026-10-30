//! `compare_checkpoints` fails on a tensor or a Fisher artifact that one checkpoint holds and the other does not, in
//! either direction.

use std::path::Path;
use tch::{Kind, Tensor};
use trainer_loop::compare::compare_checkpoints;
use trainer_loop::fisher::FisherAccumulator;
use trainer_model::checkpoint::MODEL_FILE;

fn tensor(values: &[f32]) -> Tensor {
	Tensor::from_slice(values).to_kind(Kind::Float)
}

fn write_weights(dir: &Path, tensors: &[(&str, &Tensor)]) {
	std::fs::create_dir_all(dir).unwrap();
	Tensor::write_safetensors(tensors, dir.join(MODEL_FILE)).unwrap();
}

fn write_fisher(dir: &Path) {
	let p = tensor(&[1.0, 2.0]).set_requires_grad(true);
	let params = vec![("w".to_owned(), p.shallow_clone())];
	let mut fisher = FisherAccumulator::new(&params);
	(&p * &p).sum(Kind::Float).backward();
	fisher.accumulate(&params);
	fisher.save(dir, serde_json::Map::new()).unwrap();
}

fn passes(a: &Path, b: &Path) -> bool {
	compare_checkpoints(a, b)
		.unwrap()
		.iter()
		.all(|r| r.pass() && r.notes.is_empty())
}

#[test]
fn equal_checkpoints_pass() {
	let root = tempfile::tempdir().unwrap();
	let w = tensor(&[1.0, 2.0]);
	write_weights(&root.path().join("a"), &[("w", &w)]);
	write_weights(&root.path().join("b"), &[("w", &w)]);
	write_fisher(&root.path().join("a"));
	write_fisher(&root.path().join("b"));
	let results = compare_checkpoints(&root.path().join("a"), &root.path().join("b")).unwrap();
	assert_eq!(results.len(), 2);
	assert!(passes(&root.path().join("a"), &root.path().join("b")));
}

#[test]
fn a_tensor_in_the_second_checkpoint_only_fails() {
	let root = tempfile::tempdir().unwrap();
	let w = tensor(&[1.0, 2.0]);
	let extra = tensor(&[3.0]);
	write_weights(&root.path().join("a"), &[("w", &w)]);
	write_weights(&root.path().join("b"), &[("w", &w), ("extra", &extra)]);
	let results = compare_checkpoints(&root.path().join("a"), &root.path().join("b")).unwrap();
	assert_eq!(
		results[0].notes,
		vec!["extra is in the second checkpoint only".to_owned()]
	);
	assert!(!passes(&root.path().join("a"), &root.path().join("b")));
	assert!(!passes(&root.path().join("b"), &root.path().join("a")));
}

#[test]
fn a_fisher_artifact_on_one_side_fails() {
	let root = tempfile::tempdir().unwrap();
	let w = tensor(&[1.0, 2.0]);
	write_weights(&root.path().join("a"), &[("w", &w)]);
	write_weights(&root.path().join("b"), &[("w", &w)]);
	write_fisher(&root.path().join("b"));
	assert!(!passes(&root.path().join("a"), &root.path().join("b")));
	assert!(!passes(&root.path().join("b"), &root.path().join("a")));
}
