// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `ModelEditor` writes the bytes Python's protobuf runtime writes for the same vocabulary edits.
//!
//! `fixtures/model-edit-reference.json` records, for the tracked `tokenizer-v0.1.0.model`, the SHA-256 of the model
//! after each edit as `tokenizer/splice.py` and `tokenizer/vocab/prune.py` make it: a round trip, a prune, a
//! reordering keep, a splice of three pieces, and a prune followed by the splice.

#![cfg(feature = "edit")]

use mtf_core::model_edit::{EditablePiece, ModelEditor};
use mtf_core::PieceType;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

fn manifest(relative: &str) -> std::path::PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn sha256(bytes: &[u8]) -> String {
	Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn keep_ids(rule: &str, n: usize) -> Vec<usize> {
	match rule {
		"prune" => (0..n).filter(|&i| i < 4 || i % 5 != 0).collect(),
		"reorder" => (0..4).chain((4..n).rev().step_by(7)).collect(),
		other => panic!("unknown keep rule {other}"),
	}
}

#[test]
fn every_recorded_edit_matches_python() {
	let reference: Value = serde_json::from_str(
		&std::fs::read_to_string(manifest("tests/fixtures/model-edit-reference.json")).expect("reference"),
	)
	.expect("reference parses");
	let model = std::fs::read(manifest("../../../neural/test/fixtures/tokenizer-v0.1.0.model")).expect("model");
	assert_eq!(sha256(&model), reference["input_sha256"].as_str().unwrap());
	for case in reference["cases"].as_array().unwrap() {
		let name = case["name"].as_str().unwrap();
		let mut editor = ModelEditor::parse(&model).expect("model parses");
		assert_eq!(editor.pieces().len() as u64, reference["pieces"].as_u64().unwrap());
		if let Some(rule) = case["keep"].as_str() {
			let ids = keep_ids(rule, editor.pieces().len());
			editor.keep(&ids).expect("keep");
		}
		for appended in case["append"].as_array().unwrap() {
			let piece = appended[0].as_str().unwrap();
			let score = appended[1].as_f64().unwrap() as f32;
			editor.push(EditablePiece::new(piece, score, PieceType::Normal));
		}
		assert_eq!(sha256(&editor.to_bytes()), case["sha256"].as_str().unwrap(), "{name}");
	}
}

/// Reads the shipped tokenizers under `MAILWOMAN_DATA_ROOT`, which CI does not hold, so the test is ignored unless run
/// with `--ignored` on a host that holds them. It fails when it reads none of them.
#[test]
#[ignore = "reads the shipped tokenizers under MAILWOMAN_DATA_ROOT; run with --ignored on a host that holds them"]
fn the_shipped_tokenizers_round_trip() {
	let root = std::env::var_os("MAILWOMAN_DATA_ROOT").expect("MAILWOMAN_DATA_ROOT names the data root");
	let mut read = 0;
	for relative in [
		"weights/en-us/tokenizer.model",
		"models/tokenizer/v0.9.0-multisplice/tokenizer.model",
		"models/tokenizer/v0.10.0-c6-isolated-punctuation/tokenizer.model",
	] {
		let path = Path::new(&root).join(relative);
		let Ok(model) = std::fs::read(&path) else {
			eprintln!("{} is absent; not read", path.display());
			continue;
		};
		let editor = ModelEditor::parse(&model).expect("model parses");
		assert_eq!(editor.to_bytes(), model, "{}", path.display());
		read += 1;
	}
	assert!(read > 0, "read none of the shipped tokenizers under {}", Path::new(&root).display());
}

#[test]
fn a_keep_outside_the_vocabulary_or_repeated_is_refused() {
	let model = std::fs::read(manifest("../../../neural/test/fixtures/tokenizer-v0.1.0.model")).expect("model");
	let mut editor = ModelEditor::parse(&model).expect("model parses");
	assert!(editor.keep(&[0, 0]).is_err());
	assert!(editor.keep(&[16_000]).is_err());
}
