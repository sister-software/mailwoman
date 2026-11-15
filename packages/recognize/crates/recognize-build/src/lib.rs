// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The build half of `@mailwoman/recognize`. It validates each family, renders its IR, lowers the grammar to
//! automata under configured limits ([`compile`]), writes one artifact per family, and records each artifact's size,
//! backend, state count and hashes in a manifest.
//!
//! The overlap analysis ([`analysis`]) runs over every family together and the compiler report ([`report`]) states what
//! it finds.

pub mod analysis;
pub mod compile;
pub mod lower;
pub mod reach;
pub mod report;

use recognize_core::family::Family;
use recognize_core::{render, Diagnostic, IrDocument};
use serde_json::{json, Map, Value};

pub use analysis::{Analysis, Overlap, ShapeKey, Unreachable};
pub use compile::{compile_family, AutomatonReport, CompiledFamily, Limits, UNICODE_VERSION};

/// One family's rendered IR.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmittedIr {
	/// The family ID, which names the file.
	pub family: String,
	/// The content hash the document carries.
	pub hash: String,
	/// The committed text.
	pub json: String,
}

impl EmittedIr {
	/// The file name the IR is committed under.
	pub fn file_name(&self) -> String {
		format!("{}.json", self.family)
	}
}

/// One family's IR and its compiled artifact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltFamily {
	pub ir: EmittedIr,
	pub compiled: CompiledFamily,
}

/// Validates and renders every family, or returns every family's diagnostics.
pub fn emit(families: Vec<Family>) -> Result<Vec<EmittedIr>, Vec<Diagnostic>> {
	let mut emitted = Vec::new();
	let mut diagnostics = Vec::new();

	for family in families {
		match family.build() {
			Ok(document) => emitted.push(EmittedIr {
				family: document.family.clone(),
				hash: document.hash.clone(),
				json: document.to_json(),
			}),
			Err(found) => diagnostics.extend(found),
		}
	}

	if !diagnostics.is_empty() {
		return Err(diagnostics);
	}

	emitted.sort_by(|a, b| a.family.cmp(&b.family));

	Ok(emitted)
}

/// Validates every family, renders its IR, and compiles it under `limits`, or returns every diagnostic.
pub fn compile_families(families: Vec<Family>, limits: &Limits) -> Result<Vec<BuiltFamily>, Vec<Diagnostic>> {
	let mut built = Vec::new();
	let mut diagnostics = Vec::new();

	for family in families {
		let document = match family.build() {
			Ok(document) => document,
			Err(found) => {
				diagnostics.extend(found);

				continue;
			}
		};

		match compile_family(&document, limits) {
			Ok(compiled) => built.push(BuiltFamily {
				ir: EmittedIr {
					family: document.family.clone(),
					hash: document.hash.clone(),
					json: document.to_json(),
				},
				compiled,
			}),
			Err(found) => diagnostics.extend(found),
		}
	}

	if !diagnostics.is_empty() {
		diagnostics.sort();
		diagnostics.dedup();

		return Err(diagnostics);
	}

	built.sort_by(|a, b| a.ir.family.cmp(&b.ir.family));

	Ok(built)
}

/// Every family compiled, and the analysis across all of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Build {
	pub families: Vec<BuiltFamily>,
	/// The sealed IR of each family, sorted by family ID.
	pub documents: Vec<IrDocument>,
	pub analysis: Analysis,
}

impl Build {
	/// The compiler report, as it is committed.
	pub fn report_json(&self) -> String {
		report::report_json(&self.families, &self.documents, &self.analysis)
	}

	/// The witness fixture, as it is committed.
	pub fn witnesses_json(&self) -> String {
		report::witnesses_json(&self.analysis)
	}
}

/// Validates, compiles and analyzes `families` together: unreachable shapes fail the build, and the overlap analysis
/// runs within each family and across every pair.
pub fn build_families(families: Vec<Family>, limits: &Limits) -> Result<Build, Vec<Diagnostic>> {
	let mut documents = Vec::new();
	let mut diagnostics = Vec::new();

	for family in families {
		match family.build() {
			Ok(document) => documents.push(document),
			Err(found) => diagnostics.extend(found),
		}
	}

	let mut built = Vec::new();

	for document in &documents {
		match compile_family(document, limits) {
			Ok(compiled) => built.push(BuiltFamily {
				ir: EmittedIr {
					family: document.family.clone(),
					hash: document.hash.clone(),
					json: document.to_json(),
				},
				compiled,
			}),
			Err(found) => diagnostics.extend(found),
		}
	}

	if diagnostics.is_empty() {
		documents.sort_by(|a, b| a.family.cmp(&b.family));
		built.sort_by(|a, b| a.ir.family.cmp(&b.ir.family));

		match analysis::analyze(&documents, limits) {
			Ok(analysis) => {
				return Ok(Build {
					families: built,
					documents,
					analysis,
				})
			}
			Err(found) => diagnostics.extend(found),
		}
	}

	diagnostics.sort();
	diagnostics.dedup();

	Err(diagnostics)
}

/// Builds the families this repository owns.
pub fn build_repository_families(limits: &Limits) -> Result<Build, Vec<Diagnostic>> {
	build_families(recognize_core::grammars::families(), limits)
}

/// Renders the families this repository owns.
pub fn emit_repository_families() -> Result<Vec<EmittedIr>, Vec<Diagnostic>> {
	emit(recognize_core::grammars::families())
}

/// Compiles the families this repository owns.
pub fn compile_repository_families(limits: &Limits) -> Result<Vec<BuiltFamily>, Vec<Diagnostic>> {
	compile_families(recognize_core::grammars::families(), limits)
}

/// The build manifest: each artifact's byte size, backend, state count and hashes, and the limits they were built
/// under. Keys are in byte order and the text ends with a newline.
pub fn manifest_json(built: &[BuiltFamily], limits: &Limits) -> String {
	let mut families = Map::new();

	for family in built {
		let compiled = &family.compiled;

		families.insert(
			compiled.family.clone(),
			json!({
				"artifact": compiled.file_name(),
				"automata": compiled.automata.iter().map(|automaton| json!({
					"backend": automaton.backend.as_str(),
					"bytes": automaton.bytes,
					"patterns": automaton.patterns,
					"role": automaton.role.as_str(),
					"states": automaton.states,
				})).collect::<Vec<Value>>(),
				"bytes": compiled.artifact.len(),
				"compilerVersion": recognize_core::artifact::COMPILER_VERSION,
				"declarationsHash": recognize_core::artifact::DECLARATIONS_HASH_UNSET,
				"irHash": compiled.ir_hash,
				"sha256": compiled.sha256,
				"unicodeVersion": UNICODE_VERSION,
			}),
		);
	}

	let manifest = json!({
		"families": Value::Object(families),
		"limits": {
			"buildBytes": limits.build_bytes,
			"denseBytes": limits.dense_bytes,
			"inputBytes": limits.max_input_bytes,
			"maxCaptures": limits.max_captures,
			"maxDepth": limits.max_depth,
			"maxLoweredNodes": limits.max_lowered_nodes,
			"maxProductStates": limits.max_product_states,
			"maxStates": limits.max_states,
			"nfaBytes": limits.nfa_bytes,
			"sparseBytes": limits.sparse_bytes,
		},
	});
	let mut text = serde_json::to_string_pretty(&manifest).expect("a manifest always serializes");

	text.push('\n');

	text
}

/// Renders diagnostics for a terminal.
pub fn render_diagnostics(diagnostics: &[Diagnostic]) -> String {
	render(diagnostics)
}
