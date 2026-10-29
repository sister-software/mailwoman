// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Reading and editing a SentencePiece `ModelProto` through [`ModelEditor`].

use crate::args::Result;
use mtf_core::model_edit::{
	field_number, EditablePiece, ModelEditor, NORMALIZER_SPEC_FIELD, NORMALIZER_SPEC_FIELDS, TRAINER_SPEC_FIELD,
	TRAINER_SPEC_FIELDS,
};
use mtf_core::PieceType;
use serde_json::{json, Value};

/// `ModelProto.SentencePiece.Type` by its wire value.
pub fn piece_type(wire: u64) -> Result<PieceType> {
	Ok(match wire {
		1 => PieceType::Normal,
		2 => PieceType::Unknown,
		3 => PieceType::Control,
		4 => PieceType::UserDefined,
		5 => PieceType::Unused,
		6 => PieceType::Byte,
		other => return Err(format!("unknown piece type {other}")),
	})
}

pub fn parse(bytes: &[u8], path: &str) -> Result<ModelEditor> {
	ModelEditor::parse(bytes).map_err(|e| format!("{path}: {e}"))
}

/// Every piece as `[piece, score, type]`, with the type's wire value.
pub fn pieces_json(editor: &ModelEditor) -> Value {
	Value::Array(
		editor
			.pieces()
			.iter()
			.map(|p| json!([p.piece, p.score, p.kind.wire()]))
			.collect(),
	)
}

/// The `TrainerSpec` and `NormalizerSpec` fields the Python wheel writes for a training call that named `flags`.
///
/// The wheel builds its specs from the keyword arguments alone, so the trainer spec holds exactly the named fields.
/// The trainer always fills the normalizer's rule name and compiled character map. `spm_train` reads three lists from
/// files that the wheel takes inline, and `minloglevel`, `random_seed` and `denormalization_rule_tsv` set no field of
/// either spec.
pub struct WheelFields {
	pub trainer: Vec<u64>,
	pub normalizer: Vec<u64>,
}

pub fn wheel_fields(flags: &[&str]) -> Result<WheelFields> {
	let mut trainer = Vec::new();
	let mut normalizer = vec![1, 2];
	for &flag in flags {
		let inline = match flag {
			"user_defined_symbols_file" => "user_defined_symbols",
			"control_symbols_file" => "control_symbols",
			"required_chars_file" => "required_chars",
			other => other,
		};
		if let Some(number) = field_number(TRAINER_SPEC_FIELDS, inline) {
			trainer.push(number);
		} else if let Some(number) = field_number(NORMALIZER_SPEC_FIELDS, inline) {
			normalizer.push(number);
		} else if !matches!(
			inline,
			"normalization_rule_name" | "minloglevel" | "random_seed" | "denormalization_rule_tsv"
		) {
			return Err(format!("{flag} is neither a trainer nor a normalizer field"));
		}
	}
	Ok(WheelFields { trainer, normalizer })
}

/// Applies an edit plan: `keep` (piece ids, in order), then `append` (`[piece, score, type]` entries), then
/// `wheel_flags` (the flag names a training call passed, whose unnamed spec fields are dropped).
pub fn apply_plan(editor: &mut ModelEditor, plan: &Value) -> Result<Value> {
	if let Some(keep) = plan.get("keep").filter(|v| !v.is_null()) {
		let ids = keep
			.as_array()
			.ok_or("plan.keep is not an array")?
			.iter()
			.map(|v| v.as_u64().map(|id| id as usize).ok_or("plan.keep holds a non-integer"))
			.collect::<std::result::Result<Vec<_>, _>>()?;
		editor.keep(&ids).map_err(|e| e.to_string())?;
	}
	if let Some(append) = plan.get("append").filter(|v| !v.is_null()) {
		for entry in append.as_array().ok_or("plan.append is not an array")? {
			let piece = entry[0].as_str().ok_or("an appended piece has no text")?;
			let score = entry[1].as_f64().ok_or("an appended piece has no score")? as f32;
			let kind = piece_type(entry[2].as_u64().ok_or("an appended piece has no type")?)?;
			editor.push(EditablePiece::new(piece, score, kind));
		}
	}
	let mut dropped = json!({});
	if let Some(flags) = plan.get("wheel_flags").filter(|v| !v.is_null()) {
		let names = flags
			.as_array()
			.ok_or("plan.wheel_flags is not an array")?
			.iter()
			.map(|v| v.as_str().ok_or("plan.wheel_flags holds a non-string"))
			.collect::<std::result::Result<Vec<_>, _>>()?;
		let fields = wheel_fields(&names)?;
		let trainer = editor
			.retain_spec_fields(TRAINER_SPEC_FIELD, &|n| fields.trainer.contains(&n))
			.map_err(|e| e.to_string())?;
		let normalizer = editor
			.retain_spec_fields(NORMALIZER_SPEC_FIELD, &|n| fields.normalizer.contains(&n))
			.map_err(|e| e.to_string())?;
		dropped = json!({ "trainer": trainer, "normalizer": normalizer });
	}
	Ok(json!({ "pieces": editor.pieces().len(), "dropped_fields": dropped }))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_file_flag_names_its_inline_field() {
		let fields = wheel_fields(&["vocab_size", "user_defined_symbols_file", "add_dummy_prefix"]).unwrap();
		assert_eq!(fields.trainer, vec![4, 31]);
		assert_eq!(fields.normalizer, vec![1, 2, 3]);
	}

	#[test]
	fn an_unknown_flag_is_refused() {
		assert!(wheel_fields(&["vocab"]).is_err());
	}
}
