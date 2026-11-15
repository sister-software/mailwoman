// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The search runtime: loads family artifacts into one engine and reports the shapes a text contains.
//!
//! The span policy is stated in the crate documentation. This module links the search half of `regex-automata` only.

use std::collections::BTreeSet;
use std::fmt;

use regex_automata::dfa::{dense, sparse, Automaton, OverlappingState};
use regex_automata::{Anchored, Input};

use crate::artifact::{parse, ArtifactError, Backend, Header, PatternMeta, Role, DECLARATIONS_HASH_UNSET};
use crate::ir::Scope;
use crate::prefix::start_state;
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
	pub(crate) dfa: Dfa,
	pub(crate) viability: Viability,
}

pub(crate) struct LoadedFamily {
	pub(crate) header: Header,
	pub(crate) whole: Option<Loaded>,
	pub(crate) embedded: Option<Loaded>,
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

		if self.families.iter().any(|family| family.header.family == header.family) {
			return Err(ArtifactError::DuplicateFamily(header.family));
		}

		let mut whole = None;
		let mut embedded = None;

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
				dfa,
				viability,
			};

			match meta.role {
				Role::Whole => whole = Some(loaded),
				Role::Embedded => embedded = Some(loaded),
			}
		}

		self.families.push(LoadedFamily {
			header,
			whole,
			embedded,
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

	/// Whether the artifact carries the placeholder declarations hash.
	pub fn has_declarations_hash(&self, family: &str) -> bool {
		self.header(family)
			.is_some_and(|header| header.declarations_hash != DECLARATIONS_HASH_UNSET)
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
		for family in &self.families {
			let limit = family.header.input_limit_bytes as usize;

			if text.len() > limit {
				return Err(SearchError::InputTooLong {
					family: family.header.family.clone(),
					length: text.len(),
					limit,
				});
			}
		}

		let mut found: BTreeSet<(usize, usize, usize, &str)> = BTreeSet::new();

		if text.is_empty() {
			return Ok(Vec::new());
		}

		for (family_index, family) in self.families.iter().enumerate() {
			if let Some(whole) = &family.whole {
				for pattern in whole_matches(whole, text)? {
					found.insert((0, text.len(), family_index, whole.patterns[pattern].shape.as_str()));
				}
			}

			if let Some(embedded) = &family.embedded {
				for (pattern, start, end) in embedded_candidates(embedded, text)? {
					let meta = &embedded.patterns[pattern];

					// An `Embedded` shape reports spans inside the text. The whole text is for `Whole` and
					// `WholeOrEmbedded`.
					if meta.scope == Scope::Embedded && start == 0 && end == text.len() {
						continue;
					}

					found.insert((start, end, family_index, meta.shape.as_str()));
				}
			}
		}

		Ok(found
			.into_iter()
			.map(|(start, end, family_index, shape)| Candidate {
				start,
				end,
				family: self.families[family_index].header.family.as_str(),
				shape,
			})
			.collect())
	}
}

fn automaton_error(error: regex_automata::MatchError) -> SearchError {
	SearchError::Automaton(error.to_string())
}

/// Every `(pattern, end)` the automaton reports for matches that begin at `start`.
fn ends_from<A: Automaton>(
	dfa: &A,
	text: &str,
	start: usize,
	out: &mut Vec<(usize, usize)>,
) -> Result<(), SearchError> {
	let input = Input::new(text).span(start..text.len()).anchored(Anchored::Yes);
	let mut state = OverlappingState::start();

	loop {
		dfa.try_search_overlapping_fwd(&input, &mut state)
			.map_err(automaton_error)?;

		match state.get_match() {
			Some(found) => out.push((found.pattern().as_usize(), found.offset())),
			None => return Ok(()),
		}
	}
}

fn whole_matches(loaded: &Loaded, text: &str) -> Result<Vec<usize>, SearchError> {
	let mut ends = Vec::new();

	match &loaded.dfa {
		Dfa::Dense(dfa) => ends_from(dfa, text, 0, &mut ends)?,
		Dfa::Sparse(dfa) => ends_from(dfa, text, 0, &mut ends)?,
	}

	Ok(ends
		.into_iter()
		.filter(|(_, end)| *end == text.len())
		.map(|(pattern, _)| pattern)
		.collect())
}

/// The candidate spans of an embedded automaton under the crate's span policy: for each pattern, the match that is
/// not inside another match of the same pattern.
fn embedded_candidates(loaded: &Loaded, text: &str) -> Result<Vec<(usize, usize, usize)>, SearchError> {
	let mut candidates = Vec::new();
	// The furthest end any earlier start reached, per pattern. Zero means none: a match ends after it starts.
	let mut reach = vec![0usize; loaded.patterns.len()];
	let mut ends = Vec::new();
	let mut longest = vec![0usize; loaded.patterns.len()];

	for (start, _) in text.char_indices() {
		ends.clear();

		match &loaded.dfa {
			Dfa::Dense(dfa) => ends_from(dfa, text, start, &mut ends)?,
			Dfa::Sparse(dfa) => ends_from(dfa, text, start, &mut ends)?,
		}

		for (pattern, end) in &ends {
			longest[*pattern] = longest[*pattern].max(*end);
		}

		for (pattern, end) in ends.drain(..) {
			let longest_end = longest[pattern];

			if longest_end == 0 {
				continue;
			}

			// Report the longest match at this start once, and only when it reaches past every earlier start's.
			if end == longest_end && longest_end > reach[pattern] {
				candidates.push((pattern, start, longest_end));
			}
		}

		for (pattern, end) in longest.iter_mut().enumerate() {
			reach[pattern] = reach[pattern].max(*end);
			*end = 0;
		}
	}

	candidates.sort_unstable();
	candidates.dedup();

	Ok(candidates)
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
