//! Compares every row of `test/fixtures/board-reference-v0.2.2.json` with this crate's output.
//!
//! The fixture records Google SentencePiece v0.2.2's IDs, pieces, UTF-8 offsets and decode output for
//! each gauntlet board input on the shipped Latin `tokenizer.model`. The model is not committed, so
//! the test reads it from `MTF_REFERENCE_MODEL` or the en-us weights package and fails when it is
//! absent.

use mtf_core::Processor;
use std::path::PathBuf;

fn workspace_path(relative: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(relative)
}

#[test]
fn matches_the_v0_2_2_reference_on_every_board_input() {
	let model_path = std::env::var_os("MTF_REFERENCE_MODEL")
		.map(PathBuf::from)
		.unwrap_or_else(|| workspace_path("../neural-weights-en-us/tokenizer.model"));
	let model = std::fs::read(&model_path)
		.unwrap_or_else(|e| panic!("cannot read the reference model at {}: {e}", model_path.display()));
	let fixture: serde_json::Value = serde_json::from_slice(
		&std::fs::read(workspace_path("test/fixtures/board-reference-v0.2.2.json")).expect("fixture is readable"),
	)
	.expect("fixture is JSON");

	let processor = Processor::from_model_proto(&model).expect("model loads");
	let rows = fixture["rows"].as_array().expect("rows array");
	assert!(!rows.is_empty());

	let mut mismatches = Vec::new();
	for row in rows {
		let text = row["text"].as_str().expect("text");
		let pieces = processor.encode(text).expect("encode succeeds");
		let ids: Vec<u32> = pieces.iter().map(|p| p.id).collect();
		let got = serde_json::json!({
			"ids": ids,
			"pieces": pieces.iter().map(|p| p.piece.clone()).collect::<Vec<_>>(),
			"begins": pieces.iter().map(|p| p.begin).collect::<Vec<_>>(),
			"ends": pieces.iter().map(|p| p.end).collect::<Vec<_>>(),
			"decoded": processor.decode(&ids).expect("decode succeeds"),
		});
		for field in ["ids", "pieces", "begins", "ends", "decoded"] {
			if got[field] != row[field] {
				mismatches.push(format!("{text:?} {field}: expected {} got {}", row[field], got[field]));
			}
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
	);
}
