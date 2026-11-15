// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The known-formats pass: the postcode and PO box formats a text holds, computed from the tokens the `structure` pass
//! found and a family of whole-input shapes that another package owns.
//!
//! The pass is token-level and reproduces `detectKnownFormats` of `@mailwoman/query-shape`:
//!
//! 1. Each token's text runs through the family's whole-input automaton, and every shape that accepts it is a hit of kind
//!    [`HitKind::Token`]. The tokens go in order.
//! 2. Each adjacent pair of tokens, joined by exactly one space whatever separated them in the text, runs through the same
//!    automaton, and every shape that accepts it is a hit of kind [`HitKind::Pair`]. The span of the hit runs from the
//!    first token's start to the second token's end.
//! 3. The first PO box is a hit of kind [`HitKind::POBox`]: a leader token, optional further leaders, and then a digit or
//!    mixed token within the next three tokens.
//!
//! The hits come out in that order, and within one text in the order of the shapes' IDs. A family that wants a hit order
//! names its shapes so that their IDs sort in that order.
//!
//! # The family's contract
//!
//! The pass reads one convention. A shape whose ID begins with [`LEADER_PREFIX`] marks a token as a PO box leader, and is
//! no format. Every other shape is a format. The family decides which of a token hit and a pair hit applies to a shape,
//! because the engine reports the kind of each hit and the shape's position and the caller keeps the pair it expects.
//!
//! The family has no captures and no validator, and the pass does not look at either.

use crate::engine::{search_whole, Engine, SearchError};
use crate::structure::{Structure, Token, TokenClass};

/// The prefix of the shape IDs that mark a PO box leader.
pub const LEADER_PREFIX: &str = "leader.";

/// The shape word of a PO box hit, which no shape of the family has.
pub const NO_SHAPE: u32 = u32::MAX;

/// What a hit covers. The discriminant is the code a result record carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum HitKind {
	/// One token.
	Token = 0,
	/// Two adjacent tokens joined by one space.
	Pair = 1,
	/// A PO box, from its first leader to its box number.
	POBox = 2,
}

/// One known-format hit: a UTF-8 byte range and the shape that accepted it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
	pub kind: HitKind,
	/// The shape's position in [`Engine::shapes`] of the family, or [`NO_SHAPE`] for a PO box.
	pub shape: u32,
	pub start: u32,
	pub end: u32,
}

/// The hits of one text, and the buffers the pass reuses across calls.
#[derive(Clone, Debug, Default)]
pub struct KnownFormats {
	pub hits: Vec<Hit>,
	/// The joined text of one pair.
	joined: Vec<u8>,
	/// The shapes one text matched.
	matched: Vec<usize>,
	/// Whether each token is a PO box leader.
	leaders: Vec<bool>,
}

fn is_number(token: &Token) -> bool {
	matches!(token.class, TokenClass::Digit | TokenClass::Mixed)
}

impl Engine {
	/// Computes the known formats of `text`, whose tokens `structure` holds, with the family at position `family` in load
	/// order.
	///
	/// Fails when the family has no whole-input automaton.
	pub fn known_formats(
		&self,
		family: usize,
		text: &str,
		structure: &Structure,
		out: &mut KnownFormats,
	) -> Result<(), SearchError> {
		let loaded = &self.families[family];
		let Some(whole) = &loaded.whole else {
			return Err(SearchError::NoWhole {
				family: loaded.header.family.clone(),
			});
		};
		let bytes = text.as_bytes();
		let tokens = &structure.tokens;
		let KnownFormats {
			hits,
			joined,
			matched,
			leaders,
		} = out;

		hits.clear();
		leaders.clear();

		let collect = |piece: &[u8], matched: &mut Vec<usize>| -> Result<(), SearchError> {
			matched.clear();
			search_whole(whole, piece, |pattern| matched.push(whole.shape_indexes[pattern]))?;
			matched.sort_unstable();
			matched.dedup();

			Ok(())
		};

		for token in tokens {
			collect(&bytes[token.start as usize..token.end as usize], matched)?;

			let mut leader = false;

			for shape in matched.iter().copied() {
				if loaded.leaders[shape] {
					leader = true;
				} else {
					hits.push(Hit {
						kind: HitKind::Token,
						shape: shape as u32,
						start: token.start,
						end: token.end,
					});
				}
			}

			leaders.push(leader);
		}

		for pair in tokens.windows(2) {
			let (first, second) = (&pair[0], &pair[1]);

			joined.clear();
			joined.extend_from_slice(&bytes[first.start as usize..first.end as usize]);
			joined.push(b' ');
			joined.extend_from_slice(&bytes[second.start as usize..second.end as usize]);

			collect(joined, matched)?;

			for shape in matched.iter().copied() {
				if !loaded.leaders[shape] {
					hits.push(Hit {
						kind: HitKind::Pair,
						shape: shape as u32,
						start: first.start,
						end: second.end,
					});
				}
			}
		}

		// A PO box: a leader, optional further leaders, then a number within the next three tokens. Only the first is
		// reported, and a leader whose walk finds no number leaves the search to the next token.
		for (index, _) in tokens.iter().enumerate().filter(|(index, _)| leaders[*index]) {
			let mut last = index;
			let mut found = false;

			for next in index + 1..=(index + 3).min(tokens.len() - 1) {
				if leaders[next] {
					last = next;

					continue;
				}

				if is_number(&tokens[next]) {
					last = next;
					found = true;
				}

				break;
			}

			if found {
				hits.push(Hit {
					kind: HitKind::POBox,
					shape: NO_SHAPE,
					start: tokens[index].start,
					end: tokens[last].end,
				});

				break;
			}
		}

		Ok(())
	}
}
