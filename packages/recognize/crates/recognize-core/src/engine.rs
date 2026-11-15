// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The search runtime: loads family artifacts into one engine and reports the shapes a text contains.
//!
//! The span policy is stated in the crate documentation. This module links the search half of `regex-automata` only.

use std::fmt;

use regex_automata::dfa::{dense, sparse, Automaton};
use regex_automata::util::primitives::StateID;

use crate::artifact::{parse, ArtifactError, Backend, Header, PatternMeta, Role};
use crate::captures::{extract, CaptureProgram, ExtractError};
use crate::declared::{self, Kind};
use crate::ir::Scope;
use crate::prefix::start_state;
use crate::recognition::{Recognition, Rejection, ValidationResult};
use crate::trace::{self, Trace};
use crate::viability::Viability;

/// One recognized span: the shape, and the UTF-8 byte range `start..end` of the text that matches it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Candidate<'engine> {
	pub start: usize,
	pub end: usize,
	/// The family that owns the shape, in the order the engine loaded it.
	pub family: &'engine str,
	pub shape: &'engine str,
}

/// Why a search did not run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchError {
	/// The text is longer than a family's compiler limit admits.
	InputTooLong {
		family: String,
		length: usize,
		limit: usize,
	},
	/// The bytes are not UTF-8, so no span over them could be a valid slice.
	NotUTF8 { valid_up_to: usize },
	/// The automaton stopped the search.
	Automaton(String),
	/// A scan named a partition the family does not declare.
	NoPartition { family: String, partition: String },
}

impl fmt::Display for SearchError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			SearchError::InputTooLong { family, length, limit } => write!(
				formatter,
				"the text is {length} bytes and family `{family}` admits {limit}"
			),
			SearchError::NotUTF8 { valid_up_to } => {
				write!(formatter, "the bytes are not UTF-8 after byte {valid_up_to}")
			}
			SearchError::Automaton(message) => write!(formatter, "the automaton stopped the search: {message}"),
			SearchError::NoPartition { family, partition } => {
				write!(formatter, "family `{family}` declares no partition `{partition}`")
			}
		}
	}
}

impl std::error::Error for SearchError {}

pub(crate) enum Dfa {
	Dense(dense::DFA<Vec<u32>>),
	Sparse(sparse::DFA<Vec<u8>>),
}

pub(crate) struct Loaded {
	pub(crate) patterns: Vec<PatternMeta>,
	/// The position of each pattern's shape in the family's shape table, parallel to `patterns`.
	pub(crate) shape_indexes: Vec<usize>,
	pub(crate) dfa: Dfa,
	/// The state an anchored search begins in. The grammar has no look-around, so the state does not depend on the byte
	/// before the start and one state serves every start of a text.
	pub(crate) start: StateID,
	pub(crate) viability: Viability,
}

pub(crate) struct LoadedFamily {
	pub(crate) header: Header,
	pub(crate) whole: Option<Loaded>,
	pub(crate) embedded: Option<Loaded>,
	/// One automaton for each partition the family declares, by name.
	pub(crate) partitions: Vec<(String, Loaded)>,
	pub(crate) program: CaptureProgram,
	/// The family's shape IDs in byte order, without repeats. A shape's position is its index in a [`Located`].
	pub(crate) shapes: Vec<String>,
	/// The closed kind of each shape, parallel to `shapes`.
	pub(crate) kinds: Vec<Option<Kind>>,
}

/// One located span of a search, with the family and shape as positions.
///
/// The derived order is the order a search returns: start, end, family in load order, then shape in byte order of its ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Located {
	pub start: usize,
	pub end: usize,
	/// The family's position in load order.
	pub family: usize,
	/// The shape's position in [`Engine::shapes`] of the family.
	pub shape: usize,
}

/// Several families' automata, searched in one call.
#[derive(Default)]
pub struct Engine {
	pub(crate) families: Vec<LoadedFamily>,
}

/// What a caller already knows about the artifact it loads.
#[derive(Clone, Copy, Debug, Default)]
pub struct Expected<'a> {
	pub ir_hash: Option<&'a str>,
	pub declarations_hash: Option<&'a str>,
}

/// Copies DFA bytes to an address aligned for `u32`, which `regex-automata` requires of a dense DFA, and reads them
/// through its checked deserialization. The copy is the alignment: no `unsafe`, and no assumption about where the
/// caller's buffer starts.
fn read_dense(role: Role, bytes: &[u8]) -> Result<dense::DFA<Vec<u32>>, ArtifactError> {
	let mut buffer = vec![0u8; bytes.len() + 4];
	let skip = (4 - buffer.as_ptr() as usize % 4) % 4;
	let aligned = &mut buffer[skip..skip + bytes.len()];

	aligned.copy_from_slice(bytes);

	let (dfa, read) = dense::DFA::from_bytes(aligned).map_err(|error| ArtifactError::Automaton {
		role,
		message: error.to_string(),
	})?;

	if read != bytes.len() {
		return Err(ArtifactError::Automaton {
			role,
			message: format!("{} bytes follow the DFA", bytes.len() - read),
		});
	}

	Ok(dfa.to_owned())
}

fn read_sparse(role: Role, bytes: &[u8]) -> Result<sparse::DFA<Vec<u8>>, ArtifactError> {
	let (dfa, read) = sparse::DFA::from_bytes(bytes).map_err(|error| ArtifactError::Automaton {
		role,
		message: error.to_string(),
	})?;

	if read != bytes.len() {
		return Err(ArtifactError::Automaton {
			role,
			message: format!("{} bytes follow the DFA", bytes.len() - read),
		});
	}

	Ok(dfa.to_owned())
}

impl Engine {
	/// An engine with no family.
	pub fn new() -> Self {
		Engine::default()
	}

	/// Loads one family artifact, validating every field and every DFA before the engine holds it. A family whose ID
	/// is already loaded is refused.
	pub fn load(&mut self, bytes: &[u8]) -> Result<(), ArtifactError> {
		self.load_checked(bytes, &Expected::default())
	}

	/// Loads one family artifact and also refuses it when its IR hash or declarations hash differs from the one the
	/// caller holds.
	pub fn load_checked(&mut self, bytes: &[u8], expected: &Expected<'_>) -> Result<(), ArtifactError> {
		let artifact = parse(bytes)?;
		let header = artifact.header;

		if let Some(ir_hash) = expected.ir_hash {
			if ir_hash != header.ir_hash {
				return Err(ArtifactError::IRHash {
					expected: ir_hash.to_string(),
					found: header.ir_hash,
				});
			}
		}

		if let Some(declarations_hash) = expected.declarations_hash {
			if declarations_hash != header.declarations_hash {
				return Err(ArtifactError::DeclarationsHash {
					expected: declarations_hash.to_string(),
					found: header.declarations_hash,
				});
			}
		}

		// An artifact built from other declarations than the ones this crate holds would dispatch a shape to the wrong
		// validator, so it is refused whatever the caller expects.
		if let Some(declared) = declared::declarations_hash(&header.family) {
			if declared != header.declarations_hash {
				return Err(ArtifactError::DeclarationsHash {
					expected: declared.to_string(),
					found: header.declarations_hash,
				});
			}
		}

		if self.families.iter().any(|family| family.header.family == header.family) {
			return Err(ArtifactError::DuplicateFamily(header.family));
		}

		let program = CaptureProgram::from_bytes(artifact.captures).map_err(ArtifactError::CaptureProgram)?;

		let mut shapes: Vec<String> = header
			.automata
			.iter()
			.flat_map(|meta| meta.patterns.iter().map(|pattern| pattern.shape.clone()))
			.collect();

		shapes.sort_unstable();
		shapes.dedup();

		let kinds = shapes
			.iter()
			.map(|shape| declared::kind(&header.family, shape))
			.collect();

		let mut whole = None;
		let mut embedded = None;
		let mut partitions = Vec::new();

		for (meta, payload) in header.automata.iter().zip(&artifact.payloads) {
			let dfa = match meta.backend {
				Backend::Dense => Dfa::Dense(read_dense(meta.role, payload.bytes)?),
				Backend::Sparse => Dfa::Sparse(read_sparse(meta.role, payload.bytes)?),
			};
			let found = match &dfa {
				Dfa::Dense(dfa) => dfa.pattern_len(),
				Dfa::Sparse(dfa) => dfa.pattern_len(),
			};

			if found != meta.patterns.len() {
				return Err(ArtifactError::PatternCount {
					role: meta.role,
					header: meta.patterns.len(),
					automaton: found,
				});
			}

			let viability = Viability::parse(payload.viability, meta.patterns.len(), meta.states as usize)?;
			let start = start_state(&dfa).map_err(|error| ArtifactError::Automaton {
				role: meta.role,
				message: error.to_string(),
			})?;

			if !viability.contains(start.as_u32()) {
				return Err(ArtifactError::Viability(format!(
					"the {} automaton's start state has no row",
					meta.role.as_str()
				)));
			}

			let loaded = Loaded {
				patterns: meta.patterns.clone(),
				shape_indexes: meta
					.patterns
					.iter()
					.map(|pattern| shapes.binary_search(&pattern.shape).unwrap_or_else(|index| index))
					.collect(),
				dfa,
				start,
				viability,
			};

			match meta.role {
				Role::Whole => whole = Some(loaded),
				Role::Embedded => embedded = Some(loaded),
				Role::Partition => partitions.push((meta.partition.clone().unwrap_or_default(), loaded)),
			}
		}

		self.families.push(LoadedFamily {
			header,
			whole,
			embedded,
			partitions,
			program,
			shapes,
			kinds,
		});

		Ok(())
	}

	/// The IDs of the loaded families, in load order.
	pub fn family_ids(&self) -> Vec<&str> {
		self.families
			.iter()
			.map(|family| family.header.family.as_str())
			.collect()
	}

	/// The header of a loaded family.
	pub fn header(&self, family: &str) -> Option<&Header> {
		self.families
			.iter()
			.map(|loaded| &loaded.header)
			.find(|header| header.family == family)
	}

	/// Searches bytes that may not be UTF-8. Non-UTF-8 input is refused, because a span over it has no codepoint
	/// boundaries to respect.
	pub fn search_bytes(&self, bytes: &[u8]) -> Result<Vec<Candidate<'_>>, SearchError> {
		let text = std::str::from_utf8(bytes).map_err(|error| SearchError::NotUTF8 {
			valid_up_to: error.valid_up_to(),
		})?;

		self.search(text)
	}

	/// Every candidate span of every loaded family, sorted by `(start, end, family, shape)`.
	///
	/// Offsets are UTF-8 byte offsets and each lies on a codepoint boundary. The crate documentation states which
	/// spans a shape reports.
	pub fn search(&self, text: &str) -> Result<Vec<Candidate<'_>>, SearchError> {
		self.search_in(text, |_| true)
	}

	/// Like [`Engine::search`], over the families `include` accepts. The argument is a family's position in load order.
	/// One engine can serve callers that compose different families, because each caller names its own.
	pub fn search_in(&self, text: &str, include: impl Fn(usize) -> bool) -> Result<Vec<Candidate<'_>>, SearchError> {
		Ok(self
			.locate(text, include)?
			.into_iter()
			.map(|located| self.candidate(located))
			.collect())
	}

	/// The shape IDs of a loaded family in byte order, which is the order of [`Located::shape`]. A family position
	/// outside the load order has none.
	pub fn shapes(&self, family: usize) -> &[String] {
		self.families.get(family).map_or(&[], |loaded| loaded.shapes.as_slice())
	}

	/// The names behind a located span.
	pub fn candidate(&self, located: Located) -> Candidate<'_> {
		let family = &self.families[located.family];

		Candidate {
			start: located.start,
			end: located.end,
			family: family.header.family.as_str(),
			shape: family.shapes[located.shape].as_str(),
		}
	}

	/// Like [`Engine::search_in`], with the family and shape as positions, so a caller that decodes by position builds
	/// no string.
	pub fn locate(&self, text: &str, include: impl Fn(usize) -> bool) -> Result<Vec<Located>, SearchError> {
		for family in self
			.families
			.iter()
			.enumerate()
			.filter(|(index, _)| include(*index))
			.map(|(_, family)| family)
		{
			let limit = family.header.input_limit_bytes as usize;

			if text.len() > limit {
				return Err(SearchError::InputTooLong {
					family: family.header.family.clone(),
					length: text.len(),
					limit,
				});
			}
		}

		let mut found: Vec<Located> = Vec::new();

		if text.is_empty() {
			return Ok(found);
		}

		for (family_index, family) in self.families.iter().enumerate().filter(|(index, _)| include(*index)) {
			if let Some(whole) = &family.whole {
				let (start, end) = (0, text.len());

				search_whole(whole, text, |pattern| {
					found.push(Located {
						start,
						end,
						family: family_index,
						shape: whole.shape_indexes[pattern],
					})
				})?;
			}

			if let Some(embedded) = &family.embedded {
				search_embedded(embedded, text, |pattern, start, end| {
					// An `Embedded` shape reports spans inside the text. The whole text is for `Whole` and
					// `WholeOrEmbedded`.
					if embedded.patterns[pattern].scope == Scope::Embedded && start == 0 && end == text.len() {
						return;
					}

					found.push(Located {
						start,
						end,
						family: family_index,
						shape: embedded.shape_indexes[pattern],
					})
				})?;
			}
		}

		found.sort_unstable();
		found.dedup();

		Ok(found)
	}
}

impl Engine {
	/// Splits `text` into the pieces of the family's partition `partition`, in one pass from left to right, and calls
	/// `on_piece` with the piece's shape position in [`Engine::shapes`], its kind and its UTF-8 byte range for each one.
	///
	/// The scan starts at byte 0. At each position it runs the partition's automaton anchored there and takes the longest
	/// match over all the partition's shapes, which is the piece. It continues where the piece ends. A position where no
	/// shape matches is skipped by one character and reports no piece, and a partition whose shapes together accept every
	/// character has none. Pieces are consecutive, never overlap, and each is non-empty. The cost is linear in the length
	/// of the text: a byte is read once by the piece that contains it and at most once more by the match that ends the
	/// piece.
	///
	/// The build refuses a partition whose shapes share a string, so the longest match belongs to one shape. When the
	/// automaton reports several, the shape that sorts first by ID wins.
	pub fn scan(
		&self,
		family: usize,
		partition: &str,
		text: &str,
		mut on_piece: impl FnMut(usize, Option<Kind>, usize, usize),
	) -> Result<(), SearchError> {
		let loaded = &self.families[family];
		let limit = loaded.header.input_limit_bytes as usize;

		if text.len() > limit {
			return Err(SearchError::InputTooLong {
				family: loaded.header.family.clone(),
				length: text.len(),
				limit,
			});
		}

		let Some((_, automaton)) = loaded.partitions.iter().find(|(name, _)| name == partition) else {
			return Err(SearchError::NoPartition {
				family: loaded.header.family.clone(),
				partition: partition.to_string(),
			});
		};
		let bytes = text.as_bytes();
		let mut at = 0;

		while at < bytes.len() {
			let found = match &automaton.dfa {
				Dfa::Dense(dfa) => longest(dfa, automaton.start, bytes, at)?,
				Dfa::Sparse(dfa) => longest(dfa, automaton.start, bytes, at)?,
			};

			match found {
				Some((end, pattern)) => {
					let shape = automaton.shape_indexes[pattern];

					on_piece(shape, loaded.kinds[shape], at, end);
					at = end;
				}
				None => {
					// A position no shape matches: skip the character, which is one lead byte and its continuation bytes.
					at += 1;

					while at < bytes.len() && bytes[at] & 0xC0 == 0x80 {
						at += 1;
					}
				}
			}
		}

		Ok(())
	}
}

impl Engine {
	/// Every candidate of every loaded family with its validation: the span's captures are extracted and validated
	/// before a payload exists, and a shape without a validator carries its span and raw text only.
	pub fn recognize<'engine, 'text>(
		&'engine self,
		text: &'text str,
	) -> Result<Vec<Recognition<'engine, 'text>>, SearchError> {
		self.recognize_in(text, |_| true)
	}

	/// Like [`Engine::recognize`], over the families `include` accepts. See [`Engine::search_in`].
	pub fn recognize_in<'engine, 'text>(
		&'engine self,
		text: &'text str,
		include: impl Fn(usize) -> bool,
	) -> Result<Vec<Recognition<'engine, 'text>>, SearchError> {
		let located = self.locate(text, include)?;
		let mut recognitions = Vec::with_capacity(located.len());

		for span in located {
			let (kind, validation) = self.validate(span, text);

			recognitions.push(Recognition {
				text: &text[span.start..span.end],
				candidate: self.candidate(span),
				kind,
				validation,
			});
		}

		Ok(recognitions)
	}

	/// The kind of a located span and the outcome of validating its captures. A shape without a validator is
	/// `Unvalidated` and runs no capture walk.
	pub fn validate(&self, located: Located, text: &str) -> (Option<Kind>, ValidationResult) {
		let family = &self.families[located.family];
		let kind = family.kinds[located.shape];

		let Some(validated) = kind.filter(|kind| kind.validated()) else {
			return (kind, ValidationResult::Unvalidated);
		};

		let shape = family.shapes[located.shape].as_str();
		let validation = match extract(&family.program, shape, text, located.start, located.end) {
			Ok(captures) => match declared::bind(validated, &captures) {
				Some(Ok(payload)) => ValidationResult::Validated(payload),
				Some(Err(rejection)) => ValidationResult::Rejected(rejection),
				None => ValidationResult::Unvalidated,
			},
			Err(ExtractError::Limit) => ValidationResult::Rejected(Rejection::new(
				"capture_limit",
				None,
				"the capture walk passed its step or depth limit",
			)),
			Err(ExtractError::NoParse) => ValidationResult::Rejected(Rejection::new(
				"capture_mismatch",
				None,
				"no parse of the capture program consumes the span its automaton accepted",
			)),
		};

		(kind, validation)
	}
}

impl Engine {
	/// The trace of one located span: the replay of its shape's grammar, and the validator's outcome.
	pub fn trace_located(&self, located: Located, text: &str) -> Trace {
		let family = &self.families[located.family];
		let (_, validation) = self.validate(located, text);

		trace::accepted(
			&family.header.family,
			&family.program,
			&family.shapes[located.shape],
			text,
			located.start,
			located.end,
			&validation,
		)
	}

	/// The traces of a call that asked for them: one per recognition, in the order of [`Engine::recognize_in`], then one
	/// per shape named in `explain` and found in an included family.
	///
	/// A shape in `explain` is replayed against the whole text. When the shape matches it, its trace is the trace of
	/// an accepted span. When it does not, the trace is the first failing step. A name no included family declares has
	/// no trace.
	pub fn trace(
		&self,
		text: &str,
		include: impl Fn(usize) -> bool,
		explain: &[&str],
	) -> Result<Vec<Trace>, SearchError> {
		let located = self.locate(text, &include)?;
		let mut traces: Vec<Trace> = located.iter().map(|span| self.trace_located(*span, text)).collect();

		if text.is_empty() {
			return Ok(traces);
		}

		for (family_index, family) in self.families.iter().enumerate().filter(|(index, _)| include(*index)) {
			for shape in explain {
				match trace::explain(&family.header.family, &family.program, shape, text) {
					trace::Explained::Unknown => {}
					trace::Explained::Trace(trace) => traces.push(trace),
					trace::Explained::Accepts => {
						if let Ok(position) = family
							.shapes
							.binary_search_by(|candidate| candidate.as_str().cmp(shape))
						{
							traces.push(self.trace_located(
								Located {
									start: 0,
									end: text.len(),
									family: family_index,
									shape: position,
								},
								text,
							));
						}
					}
				}
			}
		}

		Ok(traces)
	}
}

/// Walks `dfa` over `bytes` from `from` with an anchored search that begins in `start`, and calls `on_match` with the
/// automaton, the match state and the end of the match for every match state it passes, the one at the end of the
/// text included. A match state is reported one byte after the match ends, so the end is the position of the byte
/// that led into it. The walk stops at the dead state.
///
/// This is the loop `try_search_overlapping_fwd` runs, without the per-call input and state it builds: the search is
/// repeated at every start, and those costs dominate a short text.
fn walk<A: Automaton>(
	dfa: &A,
	start: StateID,
	bytes: &[u8],
	from: usize,
	mut on_match: impl FnMut(&A, StateID, usize),
) -> Result<(), SearchError> {
	let mut state = start;

	for (offset, byte) in bytes.iter().enumerate().skip(from) {
		state = dfa.next_state(state, *byte);

		if dfa.is_special_state(state) {
			if dfa.is_dead_state(state) {
				return Ok(());
			}

			if dfa.is_quit_state(state) {
				return Err(SearchError::Automaton(format!("the automaton quit at byte {offset}")));
			}

			if dfa.is_match_state(state) {
				on_match(dfa, state, offset);
			}
		}
	}

	state = dfa.next_eoi_state(state);

	if dfa.is_match_state(state) {
		on_match(dfa, state, bytes.len());
	}

	Ok(())
}

/// The longest match of an anchored search that begins at `from`: its end and the first pattern that matches there.
///
/// A match state is reported one byte after the match ends, so the end is the position of the byte that led into it. The
/// walk stops at the dead state, so it reads the piece and the one byte that ends it.
fn longest<A: Automaton>(
	dfa: &A,
	start: StateID,
	bytes: &[u8],
	from: usize,
) -> Result<Option<(usize, usize)>, SearchError> {
	let mut state = start;
	let mut best = None;
	let mut offset = from;

	while offset < bytes.len() {
		state = dfa.next_state(state, bytes[offset]);

		if dfa.is_special_state(state) {
			if dfa.is_dead_state(state) {
				return Ok(best);
			}

			if dfa.is_quit_state(state) {
				return Err(SearchError::Automaton(format!("the automaton quit at byte {offset}")));
			}

			if dfa.is_match_state(state) {
				best = Some((offset, dfa.match_pattern(state, 0).as_usize()));
			}
		}

		offset += 1;
	}

	state = dfa.next_eoi_state(state);

	if dfa.is_match_state(state) {
		best = Some((bytes.len(), dfa.match_pattern(state, 0).as_usize()));
	}

	Ok(best)
}

/// Calls `found` with the pattern of every pattern that accepts exactly `text`.
fn search_whole(loaded: &Loaded, text: &str, mut found: impl FnMut(usize)) -> Result<(), SearchError> {
	let bytes = text.as_bytes();

	fn run<A: Automaton>(
		dfa: &A,
		loaded: &Loaded,
		bytes: &[u8],
		found: &mut impl FnMut(usize),
	) -> Result<(), SearchError> {
		walk(dfa, loaded.start, bytes, 0, |dfa, state, end| {
			if end == bytes.len() {
				for index in 0..dfa.match_len(state) {
					found(dfa.match_pattern(state, index).as_usize());
				}
			}
		})
	}

	match &loaded.dfa {
		Dfa::Dense(dfa) => run(dfa, loaded, bytes, &mut found),
		Dfa::Sparse(dfa) => run(dfa, loaded, bytes, &mut found),
	}
}

/// Calls `found` with `(pattern, start, end)` for the candidate spans of an embedded automaton under the crate's span
/// policy: for each pattern, the match that is not inside another match of the same pattern.
fn search_embedded(loaded: &Loaded, text: &str, mut found: impl FnMut(usize, usize, usize)) -> Result<(), SearchError> {
	fn run<A: Automaton>(
		dfa: &A,
		loaded: &Loaded,
		bytes: &[u8],
		found: &mut impl FnMut(usize, usize, usize),
	) -> Result<(), SearchError> {
		// The furthest end any earlier start reached, per pattern. Zero means none: a match ends after it starts.
		let mut reach = vec![0usize; loaded.patterns.len()];
		// The longest end of the current start, per pattern, and the patterns that have one.
		let mut longest = vec![0usize; loaded.patterns.len()];
		let mut touched: Vec<usize> = Vec::new();

		for start in 0..bytes.len() {
			// A start inside a codepoint is not a boundary.
			if bytes[start] & 0xC0 == 0x80 {
				continue;
			}

			// One walk sees the ends in increasing order, so the last one a pattern reports is its longest.
			walk(dfa, loaded.start, bytes, start, |dfa, state, end| {
				for index in 0..dfa.match_len(state) {
					let pattern = dfa.match_pattern(state, index).as_usize();

					if longest[pattern] == 0 {
						touched.push(pattern);
					}

					longest[pattern] = end;
				}
			})?;

			// Report the longest match at this start once, and only when it reaches past every earlier start's.
			for pattern in touched.drain(..) {
				let end = std::mem::take(&mut longest[pattern]);

				if end > reach[pattern] {
					found(pattern, start, end);
					reach[pattern] = end;
				}
			}
		}

		Ok(())
	}

	match &loaded.dfa {
		Dfa::Dense(dfa) => run(dfa, loaded, text.as_bytes(), &mut found),
		Dfa::Sparse(dfa) => run(dfa, loaded, text.as_bytes(), &mut found),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn an_engine_with_no_family_finds_nothing() {
		assert!(Engine::new().search("12345").unwrap().is_empty());
	}

	#[test]
	fn bytes_that_are_not_utf8_are_refused() {
		let error = Engine::new().search_bytes(&[b'a', 0xFF]).unwrap_err();

		assert_eq!(error, SearchError::NotUTF8 { valid_up_to: 1 });
	}
}
