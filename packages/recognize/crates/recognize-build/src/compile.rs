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
	COMPILER_VERSION,
};
use recognize_core::ir::sha256_hex;
use recognize_core::viability::Viability;
use recognize_core::Declarations;
use recognize_core::{Diagnostic, DiagnosticKind, IrDocument, Scope, Shape};
use regex_automata::dfa::{dense, Automaton, StartKind};
use regex_automata::nfa::thompson::{self, WhichCaptures};
use regex_automata::MatchKind;
use regex_syntax::hir::{Hir, Look};

use crate::analysis;
use crate::lower::Lowerer;
use crate::reach;

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
	/// The longest input a family accepts when every shape of it is a partition piece. A partition scan is linear in the
	/// length of the text, so it admits a longer input than a search, which restarts at every character.
	pub max_partition_input_bytes: u32,
	/// The most states the overlap analysis visits in the product of two shapes' automata. A pair that passes it fails
	/// the build, so no overlap is skipped silently.
	pub max_product_states: usize,
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
			max_partition_input_bytes: 1 << 20,
			max_product_states: 1_000_000,
		}
	}
}

/// What the build records about one automaton.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomatonReport {
	pub role: Role,
	/// The partition a `Partition` automaton scans.
	pub partition: Option<String>,
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
	/// The hash of the family's generated declarations, which the artifact embeds.
	pub declarations_hash: String,
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
	viability: Vec<u8>,
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

/// The viability table of the DFA the artifact stores, or a failure when the walk cannot start.
fn viability_of<A: Automaton>(dfa: &A, bytes: &[u8], patterns: usize) -> Result<Vec<u8>, Failure> {
	let rows = reach::viability_rows(dfa, bytes, patterns).map_err(|message| Failure {
		kind: DiagnosticKind::UnsupportedOperator,
		message,
	})?;

	Ok(Viability::encode(&rows, patterns))
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

	let bytes = reach::representatives(dense.byte_classes());
	let states = reach::reachable_states(&dense, &bytes)
		.map_err(|message| Failure {
			kind: DiagnosticKind::UnsupportedOperator,
			message,
		})?
		.len();

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
			viability: viability_of(&dense, &bytes, hirs.len())?,
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
			// The table is keyed by the sparse DFA's own state IDs, which are not the dense DFA's.
			viability: viability_of(&sparse, &bytes, hirs.len())?,
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

/// The shapes a role searches, with the HIR the role compiles for each. A partition role takes the shapes of the
/// partition `partition` names.
fn role_hirs(role: Role, partition: Option<&str>, shapes: &[(&Shape, Hir)]) -> Vec<(usize, Hir)> {
	shapes
		.iter()
		.enumerate()
		.filter(|(_, (shape, _))| match role {
			Role::Whole => matches!(shape.scope, Scope::Whole | Scope::WholeOrEmbedded),
			Role::Embedded => matches!(shape.scope, Scope::Embedded | Scope::WholeOrEmbedded),
			Role::Partition => shape.scope == Scope::Partition && shape.partition.as_deref() == partition,
		})
		.map(|(index, (_, hir))| {
			let hir = match role {
				// The whole-input automaton accepts a match only at the end of the text, and its search starts at the
				// beginning of it, so a match it reports is the whole text.
				Role::Whole => Hir::concat(vec![hir.clone(), Hir::look(Look::End)]),
				Role::Embedded | Role::Partition => hir.clone(),
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

	// A shape no search can report fails the build here, so the check holds for a family compiled alone as well as for
	// a build of every family.
	diagnostics.extend(analysis::unreachable_diagnostics(document, limits).unwrap_or_else(|found| found));

	if !diagnostics.is_empty() {
		diagnostics.sort();
		diagnostics.dedup();

		return Err(diagnostics);
	}

	let mut metas = Vec::new();
	let mut built = Vec::new();

	// The whole-input and embedded automata, then one automaton for each partition in name order.
	let mut partitions: Vec<&str> = document
		.shapes
		.iter()
		.filter_map(|shape| shape.partition.as_deref())
		.collect();

	partitions.sort_unstable();
	partitions.dedup();

	let mut jobs: Vec<(Role, Option<&str>)> = vec![(Role::Whole, None), (Role::Embedded, None)];

	jobs.extend(partitions.into_iter().map(|name| (Role::Partition, Some(name))));

	for (role, partition) in jobs {
		let hirs = role_hirs(role, partition, &lowered);

		if hirs.is_empty() {
			continue;
		}

		let only: Vec<Hir> = hirs.iter().map(|(_, hir)| hir.clone()).collect();

		match compile_hirs(&only, limits) {
			Ok(result) => {
				metas.push(AutomatonMeta {
					backend: result.backend,
					partition: partition.map(str::to_string),
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
					viability_sha256: sha256_hex(&result.viability),
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

	let captures = crate::program::build(document)?.to_bytes();
	let header = Header {
		automata: metas,
		byte_order: "little".to_string(),
		captures_sha256: sha256_hex(&captures),
		compiler_version: COMPILER_VERSION.to_string(),
		declarations_hash: Declarations::from_ir(document).hash(),
		family: document.family.clone(),
		format: ARTIFACT_FORMAT.to_string(),
		input_limit_bytes: if document.shapes.iter().all(|shape| shape.scope == Scope::Partition) {
			limits.max_partition_input_bytes
		} else {
			limits.max_input_bytes
		},
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
			viability: &result.viability,
		})
		.collect();
	let anchor = document.shapes.first().map(|shape| shape.source.clone());
	let artifact = assemble(&header, &payloads, &captures).map_err(|error| {
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
			partition: meta.partition.clone(),
			backend: meta.backend,
			states: result.states,
			bytes: result.bytes.len(),
			patterns: meta.patterns.len(),
		})
		.collect();

	Ok(CompiledFamily {
		family: document.family.clone(),
		ir_hash: document.hash.clone(),
		declarations_hash: header.declarations_hash.clone(),
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
