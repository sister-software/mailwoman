// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Prefix continuation: whether a text is the beginning of a match, and whether it can still grow into one.
//!
//! # What the answer means
//!
//! Read a text as the beginning of a whole-input match of one shape's grammar. Then, per shape:
//!
//! * [`PrefixStatus::Dead`]: no suffix, the empty one included, makes the text a match.
//! * [`PrefixStatus::Viable`]: the text is not a match, and some non-empty suffix makes it one.
//! * [`PrefixStatus::Accepted`]: the text is a match, and no non-empty suffix keeps it one.
//! * [`PrefixStatus::AcceptedAndExtendable`]: the text is a match, and some non-empty suffix is also a match.
//! * [`PrefixStatus::Unknown`]: the engine cannot establish the answer soundly.
//!
//! The answer is about the shape's grammar and does not depend on the shape's scope: an `Embedded` shape never reports
//! the span `0..len` in a search, and its prefix status still says whether the text is a prefix of the grammar.
//!
//! # How soundness is established
//!
//! A DFA state that is not the dead state can still be unable to reach a match: determinization keeps a state for each
//! set of NFA states that can still move, whether or not that set can ever accept, and the builder guarantees only that
//! the dead state is the one with no way forward. A multi-pattern DFA built with `MatchKind::All` also shares one state
//! between patterns, so one state can be viable for one shape and dead for another. The compiler therefore computes the
//! answer for every state and pattern at build time, by backward reachability over the transition graph with the
//! end-of-input transition as the accepting step, and stores it in the artifact next to the DFA (see
//! [`crate::viability`]). The runtime reads two bits per state and pattern and never searches.
//!
//! A state the table does not hold, which a valid artifact never reaches, answers `Unknown`.
//!
//! # Whole texts and pieces
//!
//! [`Engine::prefix_status`] answers for one text. A [`PrefixCursor`] takes text in pieces and keeps one DFA state per
//! automaton as its checkpoint, so a caller that appends to a text pays for the appended bytes only. A cursor is
//! `Clone`, and a clone is a checkpoint to return to. Every piece must be a whole `&str`, so the cursor always sits on a
//! codepoint boundary.

use regex_automata::dfa::Automaton;
use regex_automata::util::primitives::StateID;
use regex_automata::{Anchored, Input};

use crate::engine::{Dfa, Engine, Loaded, SearchError};

/// The answer for one shape and one text. See the module documentation for each variant's meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PrefixStatus {
	Dead,
	Viable,
	Accepted,
	AcceptedAndExtendable,
	Unknown,
}

impl PrefixStatus {
	/// The variant as the reports and fixtures spell it.
	pub fn as_str(self) -> &'static str {
		match self {
			PrefixStatus::Dead => "dead",
			PrefixStatus::Viable => "viable",
			PrefixStatus::Accepted => "accepted",
			PrefixStatus::AcceptedAndExtendable => "accepted_and_extendable",
			PrefixStatus::Unknown => "unknown",
		}
	}

	/// Whether some suffix, the empty one included, makes the text a match.
	pub fn can_complete(self) -> bool {
		matches!(
			self,
			PrefixStatus::Viable | PrefixStatus::Accepted | PrefixStatus::AcceptedAndExtendable
		)
	}
}

/// One shape's status for a text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShapePrefix<'engine> {
	pub family: &'engine str,
	pub shape: &'engine str,
	pub status: PrefixStatus,
}

fn automaton_error(error: impl std::fmt::Display) -> SearchError {
	SearchError::Automaton(error.to_string())
}

/// The anchored start state of a text that begins at its first byte.
pub(crate) fn start_state(dfa: &Dfa) -> Result<StateID, SearchError> {
	let input = Input::new("").anchored(Anchored::Yes);

	match dfa {
		Dfa::Dense(dfa) => dfa.start_state_forward(&input),
		Dfa::Sparse(dfa) => dfa.start_state_forward(&input),
	}
	.map_err(automaton_error)
}

fn step(dfa: &Dfa, state: StateID, byte: u8) -> StateID {
	match dfa {
		Dfa::Dense(dfa) => dfa.next_state(state, byte),
		Dfa::Sparse(dfa) => dfa.next_state(state, byte),
	}
}

/// The automata of the loaded families, in the order a cursor keeps its states.
fn slots(engine: &Engine) -> impl Iterator<Item = (usize, &Loaded)> {
	engine.families.iter().enumerate().flat_map(|(index, family)| {
		[family.whole.as_ref(), family.embedded.as_ref()]
			.into_iter()
			.flatten()
			.map(move |loaded| (index, loaded))
	})
}

/// A text fed in pieces, with one checkpoint per automaton.
#[derive(Clone)]
pub struct PrefixCursor<'engine> {
	engine: &'engine Engine,
	states: Vec<StateID>,
	length: usize,
}

impl Engine {
	/// A cursor at the empty text.
	pub fn prefix_cursor(&self) -> Result<PrefixCursor<'_>, SearchError> {
		let states = slots(self)
			.map(|(_, loaded)| start_state(&loaded.dfa))
			.collect::<Result<Vec<_>, _>>()?;

		Ok(PrefixCursor {
			engine: self,
			states,
			length: 0,
		})
	}

	/// The status of every shape of every loaded family for `text`, sorted by `(family order, shape)`.
	///
	/// The text is refused when it is longer than a family's `inputLimitBytes`, as a search refuses it.
	pub fn prefix_status(&self, text: &str) -> Result<Vec<ShapePrefix<'_>>, SearchError> {
		let mut cursor = self.prefix_cursor()?;

		cursor.push(text)?;

		Ok(cursor.status())
	}
}

impl<'engine> PrefixCursor<'engine> {
	/// The bytes fed so far.
	pub fn len(&self) -> usize {
		self.length
	}

	pub fn is_empty(&self) -> bool {
		self.length == 0
	}

	/// Feeds `piece`. The cursor is unchanged when the text would pass a family's input limit.
	pub fn push(&mut self, piece: &str) -> Result<(), SearchError> {
		let length = self.length + piece.len();

		for family in &self.engine.families {
			let limit = family.header.input_limit_bytes as usize;

			if length > limit {
				return Err(SearchError::InputTooLong {
					family: family.header.family.clone(),
					length,
					limit,
				});
			}
		}

		for ((_, loaded), state) in slots(self.engine).zip(self.states.iter_mut()) {
			for byte in piece.bytes() {
				*state = step(&loaded.dfa, *state, byte);
			}
		}

		self.length = length;

		Ok(())
	}

	/// The status of every shape for the text fed so far.
	///
	/// A shape with a whole-input automaton reads that one, and a shape with only an embedded automaton reads it.
	pub fn status(&self) -> Vec<ShapePrefix<'engine>> {
		let mut out = Vec::new();
		let mut slot = 0;

		for family in &self.engine.families {
			let mut shapes: Vec<ShapePrefix<'engine>> = Vec::new();

			for loaded in [family.whole.as_ref(), family.embedded.as_ref()].into_iter().flatten() {
				let state = self.states[slot];

				slot += 1;

				for (pattern, meta) in loaded.patterns.iter().enumerate() {
					if shapes.iter().any(|known| known.shape == meta.shape) {
						continue;
					}

					shapes.push(ShapePrefix {
						family: family.header.family.as_str(),
						shape: meta.shape.as_str(),
						status: loaded.viability.status(state.as_u32(), pattern),
					});
				}
			}

			shapes.sort_by(|a, b| a.shape.cmp(b.shape));
			out.extend(shapes);
		}

		out
	}
}
