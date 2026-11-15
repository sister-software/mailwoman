// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Reachability over a serialized DFA's transition graph: the states a search can reach, and for each state and
//! pattern whether the text read so far is a match and whether a non-empty suffix extends it to one.
//!
//! The walk is generic over [`Automaton`], so the compiler runs it over the DFA it stores, dense or sparse, and the table
//! it writes is keyed by that DFA's own state IDs. Transitions are taken over one representative byte of each byte class,
//! which covers every byte because a class is a set of bytes with identical transitions in every state. The end-of-input
//! transition is the accepting step: a DFA delays a match by one byte, so the text read so far is a match of pattern `p`
//! exactly when the end-of-input transition from its state lands in a match state that lists `p`.

use std::collections::HashMap;

use recognize_core::viability::ViabilityRow;
use regex_automata::dfa::Automaton;
use regex_automata::util::primitives::StateID;
use regex_automata::util::start;
use regex_automata::Anchored;

/// One representative byte per byte class, in ascending order.
pub fn representatives(classes: &regex_automata::util::alphabet::ByteClasses) -> Vec<u8> {
	classes.representatives(..).filter_map(|unit| unit.as_u8()).collect()
}

/// Every state reachable from an anchored start state of any look-behind kind, including each end-of-input target and
/// the dead state when a path reaches it. Sorted by raw state ID.
pub fn reachable_states<A: Automaton>(dfa: &A, bytes: &[u8]) -> Result<Vec<StateID>, String> {
	let mut seen: HashMap<u32, StateID> = HashMap::new();
	let mut stack = Vec::new();

	// One look-behind byte per start kind: none, line feed, carriage return, word and non-word.
	for look_behind in [None, Some(b'\n'), Some(b'\r'), Some(b'a'), Some(b' ')] {
		let config = start::Config::new().anchored(Anchored::Yes).look_behind(look_behind);
		let id = dfa
			.start_state(&config)
			.map_err(|error| format!("the DFA has no anchored start state: {error}"))?;

		if seen.insert(id.as_u32(), id).is_none() {
			stack.push(id);
		}
	}

	while let Some(id) = stack.pop() {
		let eoi = dfa.next_eoi_state(id);

		for next in bytes
			.iter()
			.map(|byte| dfa.next_state(id, *byte))
			.chain(std::iter::once(eoi))
		{
			if seen.insert(next.as_u32(), next).is_none() {
				stack.push(next);
			}
		}
	}

	let mut out: Vec<StateID> = seen.into_values().collect();

	out.sort_by_key(|id| id.as_u32());

	Ok(out)
}

/// The viability row of every reachable state.
///
/// For pattern `p`, let `A(s)` hold when the end-of-input transition from `s` is a match of `p`, and let `R(s)` be the
/// least set that holds `A` and every state with a byte transition into `R`. Then a state is accepting for `p` when
/// `A(s)`, and extendable when a byte transition leads into `R`. `R` is the set of states that can still reach a match,
/// computed by walking the reversed graph from the accepting states.
pub fn viability_rows<A: Automaton>(dfa: &A, bytes: &[u8], patterns: usize) -> Result<Vec<ViabilityRow>, String> {
	let states = reachable_states(dfa, bytes)?;
	let index: HashMap<u32, usize> = states.iter().enumerate().map(|(at, id)| (id.as_u32(), at)).collect();
	let words = patterns.div_ceil(64).max(1);
	let mut accepted = vec![vec![0u64; words]; states.len()];
	let mut forward: Vec<Vec<usize>> = Vec::with_capacity(states.len());
	let mut backward: Vec<Vec<usize>> = vec![Vec::new(); states.len()];

	for (at, id) in states.iter().enumerate() {
		let eoi = dfa.next_eoi_state(*id);

		if dfa.is_match_state(eoi) {
			for position in 0..dfa.match_len(eoi) {
				let pattern = dfa.match_pattern(eoi, position).as_usize();

				if pattern >= patterns {
					return Err(format!(
						"the DFA reports pattern {pattern} and the family declares {patterns}"
					));
				}

				accepted[at][pattern / 64] |= 1 << (pattern % 64);
			}
		}

		let mut next: Vec<usize> = bytes
			.iter()
			.map(|byte| index[&dfa.next_state(*id, *byte).as_u32()])
			.collect();

		next.sort_unstable();
		next.dedup();

		for target in &next {
			backward[*target].push(at);
		}

		forward.push(next);
	}

	let mut reach = accepted.clone();
	let mut work: Vec<usize> = (0..states.len()).collect();

	while let Some(target) = work.pop() {
		let bits = reach[target].clone();

		for source in backward[target].clone() {
			let mut changed = false;

			for (word, bit) in reach[source].iter_mut().zip(&bits) {
				if *word | *bit != *word {
					*word |= *bit;
					changed = true;
				}
			}

			if changed {
				work.push(source);
			}
		}
	}

	Ok(states
		.iter()
		.enumerate()
		.map(|(at, id)| {
			let mut extendable = vec![0u64; words];

			for target in &forward[at] {
				for (word, bit) in extendable.iter_mut().zip(&reach[*target]) {
					*word |= *bit;
				}
			}

			let flags = |bits: &[u64]| -> Vec<bool> {
				(0..patterns)
					.map(|pattern| bits[pattern / 64] >> (pattern % 64) & 1 == 1)
					.collect()
			};

			ViabilityRow {
				state: id.as_u32(),
				accepted: flags(&accepted[at]),
				extendable: flags(&extendable),
			}
		})
		.collect())
}
