// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The viability table: for every state of one automaton and every pattern, whether the text read so far is a match
//! and whether some non-empty suffix extends it to a match.
//!
//! The compiler writes one table beside each DFA and the loader reads it, so both sides share this module. A table is
//! keyed by the raw state IDs of the DFA as it is serialized (a sparse DFA's IDs differ from the dense DFA's it was
//! converted from, so the compiler computes the table over the DFA it stores).
//!
//! ```text
//! 0          u32  state count n
//! 4          u32  bytes per row, ceil(patterns / 8)
//! 8          n * u32  state IDs, strictly ascending
//! 8 + 4n     n * row  accepted bits: bit p of a row is set when the text read so far is a match of pattern p
//! 8 + 4n + nr  n * row  extendable bits: bit p is set when some non-empty suffix makes the text a match of pattern p
//! ```
//!
//! Integers are little-endian and a row's bit `p` is bit `p % 8` of byte `p / 8`. Padding bits are zero.
//!
//! A text is dead for a pattern when neither bit is set.

use crate::artifact::ArtifactError;
use crate::prefix::PrefixStatus;

/// One state's bits as the compiler computes them. Each vector holds one flag per pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViabilityRow {
	pub state: u32,
	pub accepted: Vec<bool>,
	pub extendable: Vec<bool>,
}

/// A parsed table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Viability {
	ids: Vec<u32>,
	row_bytes: usize,
	accepted: Vec<u8>,
	extendable: Vec<u8>,
}

fn row_bytes(patterns: usize) -> usize {
	patterns.div_ceil(8)
}

fn pack(flags: &[bool], width: usize, out: &mut Vec<u8>) {
	let start = out.len();

	out.resize(start + width, 0);

	for (pattern, flag) in flags.iter().enumerate() {
		if *flag {
			out[start + pattern / 8] |= 1 << (pattern % 8);
		}
	}
}

fn bad(message: impl Into<String>) -> ArtifactError {
	ArtifactError::Viability(message.into())
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
	u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

impl Viability {
	/// Lays out a table for an automaton of `patterns` patterns. Rows sort by state ID.
	pub fn encode(rows: &[ViabilityRow], patterns: usize) -> Vec<u8> {
		let width = row_bytes(patterns);
		let mut sorted: Vec<&ViabilityRow> = rows.iter().collect();

		sorted.sort_by_key(|row| row.state);

		let mut out = Vec::with_capacity(8 + sorted.len() * (4 + 2 * width));

		out.extend_from_slice(&(sorted.len() as u32).to_le_bytes());
		out.extend_from_slice(&(width as u32).to_le_bytes());

		for row in &sorted {
			out.extend_from_slice(&row.state.to_le_bytes());
		}

		for row in &sorted {
			pack(&row.accepted, width, &mut out);
		}

		for row in &sorted {
			pack(&row.extendable, width, &mut out);
		}

		out
	}

	/// Reads a table, refusing one whose shape disagrees with the header: its state count must equal `states`, and its
	/// row width must hold `patterns` bits with no padding bit set.
	pub fn parse(bytes: &[u8], patterns: usize, states: usize) -> Result<Viability, ArtifactError> {
		if bytes.len() < 8 {
			return Err(bad("the table is shorter than its two counts"));
		}

		let count = u32_at(bytes, 0) as usize;
		let width = u32_at(bytes, 4) as usize;

		if count != states {
			return Err(bad(format!(
				"the table holds {count} states and the header records {states}"
			)));
		}

		if width != row_bytes(patterns) {
			return Err(bad(format!(
				"the table's rows are {width} bytes and {patterns} patterns need {}",
				row_bytes(patterns)
			)));
		}

		let expected = count
			.checked_mul(4 + 2 * width)
			.and_then(|body| body.checked_add(8))
			.ok_or_else(|| bad("the table's size overflows"))?;

		if bytes.len() != expected {
			return Err(bad(format!(
				"the table is {} bytes and its counts state {expected}",
				bytes.len()
			)));
		}

		let ids: Vec<u32> = (0..count).map(|index| u32_at(bytes, 8 + index * 4)).collect();

		if ids.windows(2).any(|pair| pair[0] >= pair[1]) {
			return Err(bad("the state IDs are not strictly ascending"));
		}

		let rows_at = 8 + count * 4;
		let accepted = bytes[rows_at..rows_at + count * width].to_vec();
		let extendable = bytes[rows_at + count * width..].to_vec();
		let spare = patterns % 8;

		if spare != 0 && width != 0 {
			let mask = !((1u8 << spare) - 1);

			for rows in [&accepted, &extendable] {
				if (0..count).any(|row| rows[row * width + width - 1] & mask != 0) {
					return Err(bad("a padding bit is set"));
				}
			}
		}

		Ok(Viability {
			ids,
			row_bytes: width,
			accepted,
			extendable,
		})
	}

	/// Whether the table holds `state`.
	pub fn contains(&self, state: u32) -> bool {
		self.ids.binary_search(&state).is_ok()
	}

	/// The status of `pattern` at `state`, or `Unknown` when the table has no row for the state or no bit for the
	/// pattern.
	pub fn status(&self, state: u32, pattern: usize) -> PrefixStatus {
		let Ok(row) = self.ids.binary_search(&state) else {
			return PrefixStatus::Unknown;
		};

		if pattern / 8 >= self.row_bytes {
			return PrefixStatus::Unknown;
		}

		let at = row * self.row_bytes + pattern / 8;
		let bit = 1u8 << (pattern % 8);

		match (self.accepted[at] & bit != 0, self.extendable[at] & bit != 0) {
			(false, false) => PrefixStatus::Dead,
			(false, true) => PrefixStatus::Viable,
			(true, false) => PrefixStatus::Accepted,
			(true, true) => PrefixStatus::AcceptedAndExtendable,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn rows() -> Vec<ViabilityRow> {
		vec![
			ViabilityRow {
				state: 8,
				accepted: vec![true, false, false],
				extendable: vec![false, true, false],
			},
			ViabilityRow {
				state: 2,
				accepted: vec![false, false, true],
				extendable: vec![true, true, true],
			},
		]
	}

	#[test]
	fn a_table_round_trips_and_answers_each_combination() {
		let table = Viability::parse(&Viability::encode(&rows(), 3), 3, 2).unwrap();

		assert_eq!(table.status(8, 0), PrefixStatus::Accepted);
		assert_eq!(table.status(8, 1), PrefixStatus::Viable);
		assert_eq!(table.status(8, 2), PrefixStatus::Dead);
		assert_eq!(table.status(2, 2), PrefixStatus::AcceptedAndExtendable);
		assert_eq!(table.status(5, 0), PrefixStatus::Unknown);
		assert_eq!(table.status(8, 9), PrefixStatus::Unknown);
		assert!(table.contains(2) && !table.contains(3));
	}

	#[test]
	fn a_table_that_disagrees_with_its_header_is_refused() {
		let bytes = Viability::encode(&rows(), 3);

		assert!(Viability::parse(&bytes, 3, 3).is_err());
		assert!(Viability::parse(&bytes, 9, 2).is_err());
		assert!(Viability::parse(&bytes[..bytes.len() - 1], 3, 2).is_err());

		let mut padded = bytes.clone();
		let last = padded.len() - 1;

		padded[last] |= 0x80;
		assert!(Viability::parse(&padded, 3, 2).is_err());
	}
}
