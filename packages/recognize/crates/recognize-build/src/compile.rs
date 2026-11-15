// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Compilation: one family's IR becomes an anchored whole-input automaton and an embedded-span automaton, serialized
//! into one artifact.
//!
//! # Backends and the fallback rule
//!
//! Each automaton is a `regex-automata` DFA built with `MatchKind::All` and an anchored start, so it keeps every
//! pattern that accepts at each end position and carries no unanchored prefix. The rule that picks the stored backend:
//!
//! 1. Build a dense DFA with construction memory capped at [`Limits::build_bytes`]. A grammar that exceeds the cap
//!    fails the build. A sparse DFA is derived from the dense one, so no backend avoids this cap.
//! 2. A DFA with more than [`Limits::max_states`] states fails the build, on every backend.
//! 3. When the dense serialization fits [`Limits::dense_bytes`], the backend is dense: the fastest search.
//! 4. Otherwise the DFA converts to a sparse DFA. When that serialization fits [`Limits::sparse_bytes`], the backend is
//!    sparse: slower to search and smaller to store.
//! 5. Otherwise the build fails.
//!
//! A lazy DFA or an NFA search is not a backend here: `regex-automata` has no serialized form of either, so loading one
//! would put the regex compiler in the runtime crate. A grammar over the limit of dense and sparse therefore fails
//! the build with a diagnostic. No step raises or removes a limit.

use recognize_core::artifact::{
	assemble, AutomatonMeta, Backend, Header, PatternMeta, Payload, Role, ARTIFACT_FORMAT, ARTIFACT_SCHEMA_VERSION,
	COMPILER_VERSION, DECLARATIONS_HASH_UNSET,
};
use recognize_core::ir::sha256_hex;
use recognize_core::{Diagnostic, DiagnosticKind, IrDocument, Scope, Shape};
use regex_automata::dfa::{dense, Automaton, StartKind};
use regex_automata::nfa::thompson::{self, WhichCaptures};
use regex_automata::util::start;
use regex_automata::{Anchored, MatchKind};
use regex_syntax::hir::{Hir, Look};

use crate::lower::Lowerer;

/// The Unicode version of the tables the pinned `regex-syntax` ships. A test parses `\p{Age=V16_0}` and `\p{Age=V17_0}`
/// to hold this constant equal to the library's tables.
pub const UNICODE_VERSION: &str = "16.0.0";

/// The configured limits of one build. A grammar that exceeds one fails the build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
	/// The most states a DFA may have, on any backend.
	pub max_states: usize,
	/// The cap on the Thompson NFA's memory.
	pub nfa_bytes: usize,
	/// The cap on DFA construction memory, for the table and the working sets.
	pub build_bytes: usize,
	/// The largest dense serialization the dense backend accepts.
	pub dense_bytes: usize,
	/// The largest sparse serialization the sparse backend accepts.
	pub sparse_bytes: usize,
	/// The deepest grammar nesting, after terms expand.
	pub max_depth: usize,
	/// The most nodes one shape lowers to, after terms expand.
	pub max_lowered_nodes: usize,
	/// The most captures one shape makes.
	pub max_captures: usize,
	/// The longest input, in UTF-8 bytes, the artifact's search accepts.
	pub max_input_bytes: u32,
}

impl Default for Limits {
	fn default() -> Self {
		Limits {
			max_states: 50_000,
			nfa_bytes: 8 << 20,
			build_bytes: 32 << 20,
			dense_bytes: 2 << 20,
			sparse_bytes: 2 << 20,
			max_depth: 64,
			max_lowered_nodes: 100_000,
			max_captures: 64,
			max_input_bytes: 4096,
		}
	}
}

/// What the build records about one automaton.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomatonReport {
	pub role: Role,
	pub backend: Backend,
	pub states: usize,
	/// The serialized DFA's byte length.
	pub bytes: usize,
	pub patterns: usize,
}

/// One compiled family.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledFamily {
	pub family: String,
	pub ir_hash: String,
	pub artifact: Vec<u8>,
	pub sha256: String,
	pub automata: Vec<AutomatonReport>,
}

impl CompiledFamily {
	/// The file name the artifact is committed under.
	pub fn file_name(&self) -> String {
		format!("{}.rca1", self.family)
	}
}

struct Built {
	backend: Backend,
	states: usize,
	bytes: Vec<u8>,
}

/// Why one set of patterns did not compile.
struct Failure {
	kind: DiagnosticKind,
	message: String,
}

impl Failure {
	fn limit(message: impl Into<String>) -> Self {
		Failure {
			kind: DiagnosticKind::LimitExceeded,
			message: message.into(),
		}
	}
}

/// Counts the states reachable from every kind of anchored start state, which includes the dead state when a path
/// reaches it. `regex-automata` exposes no state count, so the compiler walks the transition function.
fn count_states(dfa: &dense::DFA<Vec<u32>>) -> Result<usize, Failure> {
	use std::collections::BTreeSet;

	let mut seen = BTreeSet::new();
	let mut stack = Vec::new();

	// One look-behind byte per start kind: none, line feed, carriage return, word and non-word.
	for look_behind in [None, Some(b'\n'), Some(b'\r'), Some(b'a'), Some(b' ')] {
		let config = start::Config::new().anchored(Anchored::Yes).look_behind(look_behind);
		let id = dfa.start_state(&config).map_err(|error| Failure {
			kind: DiagnosticKind::UnsupportedOperator,
			message: format!("the DFA has no anchored start state: {error}"),
		})?;

		if seen.insert(id) {
			stack.push(id);
		}
	}

	let units: Vec<_> = dfa.byte_classes().representatives(..).collect();

	while let Some(id) = stack.pop() {
		for unit in &units {
			let next = match unit.as_u8() {
				Some(byte) => dfa.next_state(id, byte),
				None => dfa.next_eoi_state(id),
			};

			if seen.insert(next) {
				stack.push(next);
			}
		}
	}

	Ok(seen.len())
}

fn compile_hirs(hirs: &[Hir], limits: &Limits) -> Result<Built, Failure> {
	let nfa = thompson::Compiler::new()
		.configure(
			thompson::Config::new()
				.which_captures(WhichCaptures::None)
				.nfa_size_limit(Some(limits.nfa_bytes)),
		)
		.build_many_from_hir(hirs)
		.map_err(|error| Failure {
			kind: if error.size_limit().is_some() {
				DiagnosticKind::LimitExceeded
			} else {
				DiagnosticKind::UnsupportedOperator
			},
			message: format!("the NFA does not build: {error}"),
		})?;

	let dense = dense::Builder::new()
		.configure(
			dense::Config::new()
				.match_kind(MatchKind::All)
				.start_kind(StartKind::Anchored)
				.dfa_size_limit(Some(limits.build_bytes))
				.determinize_size_limit(Some(limits.build_bytes)),
		)
		.build_from_nfa(&nfa)
		.map_err(|error| {
			if error.is_size_limit_exceeded() {
				Failure::limit(format!(
					"construction passes the {}-byte build limit, and no backend avoids it: {error}",
					limits.build_bytes
				))
			} else {
				Failure {
					kind: DiagnosticKind::UnsupportedOperator,
					message: format!("the DFA does not build: {error}"),
				}
			}
		})?;

	let states = count_states(&dense)?;

	if states > limits.max_states {
		return Err(Failure::limit(format!(
			"the DFA has {states} states and the limit is {}",
			limits.max_states
		)));
	}

	let (padded, padding) = dense.to_bytes_little_endian();
	let dense_bytes = padded[padding..].to_vec();

	if dense_bytes.len() <= limits.dense_bytes {
		return Ok(Built {
			backend: Backend::Dense,
			states,
			bytes: dense_bytes,
		});
	}

	let sparse = dense.to_sparse().map_err(|error| Failure {
		kind: DiagnosticKind::LimitExceeded,
		message: format!("the sparse conversion fails: {error}"),
	})?;
	let sparse_bytes = sparse.to_bytes_little_endian();

	if sparse_bytes.len() <= limits.sparse_bytes {
		return Ok(Built {
			backend: Backend::Sparse,
			states,
			bytes: sparse_bytes,
		});
	}

	Err(Failure::limit(format!(
		"the dense serialization is {} bytes against a limit of {}, and the sparse serialization is {} bytes against a limit of {}",
		dense_bytes.len(),
		limits.dense_bytes,
		sparse_bytes.len(),
		limits.sparse_bytes
	)))
}

/// The shapes a role searches, with the HIR the role compiles for each.
fn role_hirs(role: Role, shapes: &[(&Shape, Hir)]) -> Vec<(usize, Hir)> {
	shapes
		.iter()
		.enumerate()
		.filter(|(_, (shape, _))| match role {
			Role::Whole => matches!(shape.scope, Scope::Whole | Scope::WholeOrEmbedded),
			Role::Embedded => matches!(shape.scope, Scope::Embedded | Scope::WholeOrEmbedded),
		})
		.map(|(index, (_, hir))| {
			let hir = match role {
				// The whole-input automaton accepts a match only at the end of the text, and its search starts at the
				// beginning of it, so a match it reports is the whole text.
				Role::Whole => Hir::concat(vec![hir.clone(), Hir::look(Look::End)]),
				Role::Embedded => hir.clone(),
			};

			(index, hir)
		})
		.collect()
}

/// Compiles one family under `limits`, or returns every diagnostic with the source file and line of the grammar at
/// fault. The result is deterministic: the same IR and limits give the same bytes.
pub fn compile_family(document: &IrDocument, limits: &Limits) -> Result<CompiledFamily, Vec<Diagnostic>> {
	let mut lowerer = Lowerer::new(&document.terms, limits);
	let mut lowered: Vec<(&Shape, Hir)> = Vec::new();
	let mut diagnostics = Vec::new();

	for shape in &document.shapes {
		match lowerer.shape(shape) {
			Ok(hir) => lowered.push((shape, hir)),
			Err(found) => diagnostics.extend(found),
		}
	}

	if !diagnostics.is_empty() {
		diagnostics.sort();
		diagnostics.dedup();

		return Err(diagnostics);
	}

	let mut metas = Vec::new();
	let mut built = Vec::new();

	for role in [Role::Whole, Role::Embedded] {
		let hirs = role_hirs(role, &lowered);

		if hirs.is_empty() {
			continue;
		}

		let only: Vec<Hir> = hirs.iter().map(|(_, hir)| hir.clone()).collect();

		match compile_hirs(&only, limits) {
			Ok(result) => {
				metas.push(AutomatonMeta {
					backend: result.backend,
					patterns: hirs
						.iter()
						.map(|(index, _)| PatternMeta {
							scope: lowered[*index].0.scope,
							shape: lowered[*index].0.id.clone(),
						})
						.collect(),
					role,
					sha256: sha256_hex(&result.bytes),
					states: u32::try_from(result.states).expect("a state count within the limit fits u32"),
				});
				built.push((role, result));
			}
			Err(failure) => diagnostics.extend(blame(&document.family, role, &hirs, &lowered, limits, failure)),
		}
	}

	if !diagnostics.is_empty() {
		diagnostics.sort();
		diagnostics.dedup();

		return Err(diagnostics);
	}

	let header = Header {
		automata: metas,
		byte_order: "little".to_string(),
		compiler_version: COMPILER_VERSION.to_string(),
		declarations_hash: DECLARATIONS_HASH_UNSET.to_string(),
		family: document.family.clone(),
		format: ARTIFACT_FORMAT.to_string(),
		input_limit_bytes: limits.max_input_bytes,
		ir_hash: document.hash.clone(),
		schema_version: ARTIFACT_SCHEMA_VERSION,
		unicode_version: UNICODE_VERSION.to_string(),
	};
	let payloads: Vec<Payload<'_>> = built
		.iter()
		.map(|(role, result)| Payload {
			role: *role,
			backend: result.backend,
			bytes: &result.bytes,
		})
		.collect();
	let anchor = document.shapes.first().map(|shape| shape.source.clone());
	let artifact = assemble(&header, &payloads).map_err(|error| {
		vec![Diagnostic::new(
			DiagnosticKind::MalformedIR,
			&anchor.unwrap_or_else(|| recognize_core::Source::new("<artifact>", 0)),
			format!("family `{}` does not assemble: {error}", document.family),
		)]
	})?;
	let automata = header
		.automata
		.iter()
		.zip(&built)
		.map(|(meta, (_, result))| AutomatonReport {
			role: meta.role,
			backend: meta.backend,
			states: result.states,
			bytes: result.bytes.len(),
			patterns: meta.patterns.len(),
		})
		.collect();

	Ok(CompiledFamily {
		family: document.family.clone(),
		ir_hash: document.hash.clone(),
		sha256: sha256_hex(&artifact),
		artifact,
		automata,
	})
}

/// Names the shapes at fault. A shape that fails alone is reported at its own source. When every shape compiles alone
/// and the set does not, the set is reported at its first shape.
fn blame(
	family: &str,
	role: Role,
	hirs: &[(usize, Hir)],
	lowered: &[(&Shape, Hir)],
	limits: &Limits,
	failure: Failure,
) -> Vec<Diagnostic> {
	let mut out = Vec::new();

	for (index, hir) in hirs {
		if let Err(alone) = compile_hirs(std::slice::from_ref(hir), limits) {
			let shape = lowered[*index].0;

			out.push(Diagnostic::new(
				alone.kind,
				&shape.source,
				format!(
					"family `{family}`, {} automaton, shape `{}`: {}",
					role.as_str(),
					shape.id,
					alone.message
				),
			));
		}
	}

	if out.is_empty() {
		let first = lowered[hirs[0].0].0;

		out.push(Diagnostic::new(
			failure.kind,
			&first.source,
			format!(
				"family `{family}`, {} automaton of {} shapes, starting at shape `{}`: {}",
				role.as_str(),
				hirs.len(),
				first.id,
				failure.message
			),
		));
	}

	out
}
