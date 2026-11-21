// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The machine-readable compiler report and the witness fixture, both rendered from one build.
//!
//! The report states, per family, its shapes with scope, validator ID and handler ID, the backend and size of each
//! automaton, the unreachable shape IDs, the equivalent pairs and each overlapping pair with its witness and whether the
//! pair is declared. Pairs whose shapes belong to different families are listed once, under `crossFamily`. Keys are in
//! byte order and the text ends with a newline.
//!
//! The witness fixture lists the declared overlapping pairs and the shortest string each pair shares, so a test can hold
//! the engine to reporting both shapes on that string.

use std::collections::BTreeMap;

use recognizer_core::{IrDocument, Scope};
use serde_json::{json, Map, Value};

use crate::analysis::{Analysis, Overlap, ShapeKey};
use crate::{AutomatonReport, BuiltFamily};

fn scope_name(scope: Scope) -> &'static str {
	match scope {
		Scope::Whole => "whole",
		Scope::Embedded => "embedded",
		Scope::WholeOrEmbedded => "whole_or_embedded",
		Scope::Partition => "partition",
	}
}

/// One automaton as the manifest and the report state it. A partition automaton adds the partition's name, and the
/// others add nothing, so a family without partitions reads as it did before they existed.
pub fn automaton_json(automaton: &AutomatonReport) -> Value {
	let mut entry = Map::new();

	entry.insert("backend".to_string(), json!(automaton.backend.as_str()));
	entry.insert("bytes".to_string(), json!(automaton.bytes));

	if let Some(partition) = &automaton.partition {
		entry.insert("partition".to_string(), json!(partition));
	}

	entry.insert("patterns".to_string(), json!(automaton.patterns));
	entry.insert("role".to_string(), json!(automaton.role.as_str()));
	entry.insert("states".to_string(), json!(automaton.states));

	Value::Object(entry)
}

fn key_json(key: &ShapeKey) -> Value {
	json!({ "family": key.family, "shape": key.shape })
}

fn text(value: &Value) -> String {
	let mut text = serde_json::to_string_pretty(value).expect("a report always serializes");

	text.push('\n');

	text
}

/// The compiler report.
pub fn report_json(built: &[BuiltFamily], documents: &[IrDocument], analysis: &Analysis) -> String {
	let mut families = Map::new();

	for document in documents {
		let compiled = built
			.iter()
			.find(|family| family.ir.family == document.family)
			.map(|family| &family.compiled);
		let within = |overlap: &&Overlap| overlap.a.family == document.family && overlap.b.family == document.family;
		let unreachable: Vec<&_> = analysis
			.unreachable
			.iter()
			.filter(|entry| entry.key.family == document.family)
			.collect();

		families.insert(
			document.family.clone(),
			json!({
				"automata": compiled.map_or(Vec::new(), |compiled| compiled.automata.iter().map(automaton_json).collect()),
				"equivalent": analysis.overlaps.iter().filter(within).filter(|overlap| overlap.equivalent).map(|overlap| json!({
					"a": overlap.a.shape,
					"b": overlap.b.shape,
				})).collect::<Vec<Value>>(),
				"overlaps": analysis.overlaps.iter().filter(within).map(|overlap| json!({
					"a": overlap.a.shape,
					"b": overlap.b.shape,
					"declared": overlap.declared,
					"witness": overlap.witness,
				})).collect::<Vec<Value>>(),
				"shapes": document.shapes.iter().map(|shape| {
					let found = unreachable.iter().find(|entry| entry.key.shape == shape.id);

					json!({
						"handler": shape.handler.as_ref().map(|id| id.as_str()),
						"id": shape.id,
						"scope": scope_name(shape.scope),
						"unreachable": found.map(|entry| json!({
							"declared": entry.declared,
							"reason": entry.reason,
						})),
						"validator": shape.validator.as_ref().map(|id| id.as_str()),
					})
				}).collect::<Vec<Value>>(),
				"unreachable": unreachable.iter().map(|entry| entry.key.shape.clone()).collect::<Vec<String>>(),
			}),
		);
	}

	let across = |overlap: &&Overlap| overlap.a.family != overlap.b.family;
	let report = json!({
		"crossFamily": {
			"equivalent": analysis.overlaps.iter().filter(across).filter(|overlap| overlap.equivalent).map(|overlap| json!({
				"a": key_json(&overlap.a),
				"b": key_json(&overlap.b),
			})).collect::<Vec<Value>>(),
			"overlaps": analysis.overlaps.iter().filter(across).map(|overlap| json!({
				"a": key_json(&overlap.a),
				"b": key_json(&overlap.b),
				"declared": overlap.declared,
				"witness": overlap.witness,
			})).collect::<Vec<Value>>(),
		},
		"families": Value::Object(families),
	});

	text(&report)
}

/// The witness fixture: each declared overlapping pair and its shortest shared string.
pub fn witnesses_json(analysis: &Analysis) -> String {
	witnesses_json_of(analysis, None)
}

/// The witness fixture of one family's pairs: each declared pair with a shape in `family`, within it or across.
pub fn witnesses_json_of(analysis: &Analysis, family: Option<&str>) -> String {
	let pairs: BTreeMap<(&ShapeKey, &ShapeKey), &Overlap> = analysis
		.overlaps
		.iter()
		.filter(|overlap| overlap.declared)
		.filter(|overlap| family.is_none_or(|family| overlap.a.family == family || overlap.b.family == family))
		.map(|overlap| ((&overlap.a, &overlap.b), overlap))
		.collect();

	text(&json!({
		"pairs": pairs.values().map(|overlap| json!({
			"a": key_json(&overlap.a),
			"b": key_json(&overlap.b),
			"witness": overlap.witness,
		})).collect::<Vec<Value>>(),
	}))
}
