// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The build half of `@mailwoman/recognize`. Phase 1 validates each family and renders its IR. The compiler,
//! analysis and artifact writer arrive in later phases.

use recognize_core::family::Family;
use recognize_core::{render, Diagnostic};

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

/// Renders the families this repository owns.
pub fn emit_repository_families() -> Result<Vec<EmittedIr>, Vec<Diagnostic>> {
	emit(recognize_core::grammars::families())
}

/// Renders diagnostics for a terminal.
pub fn render_diagnostics(diagnostics: &[Diagnostic]) -> String {
	render(diagnostics)
}
