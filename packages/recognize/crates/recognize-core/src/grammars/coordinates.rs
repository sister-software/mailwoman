// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `coordinates` family, as far as the compiler needs it: one unvalidated decimal pair, built from the same signed
//! decimal grammar as `primitives`. The range validator, the `geo:` URI and the whole-input scope rules belong to the
//! coordinate work in a later phase.
//!
//! - `coordinate.decimal_pair`: a signed decimal, a comma with optional whitespace around it, a signed decimal.

use crate::ast::{capture, class, literal, reference, sequence, zero_or_more};
use crate::family::{shape, term, Family};
use crate::grammars::primitives::signed_decimal;
use crate::ir::{CaptureType, Scope};

pub const FAMILY: &str = "coordinates";

/// Builds the family. The grammar is valid by construction, and the module's tests hold that.
pub fn family() -> Family {
	Family::new(FAMILY)
		.term(term("ascii_whitespace", class(&[('\t', '\r'), (' ', ' ')])))
		.term(term("digit", class(&[('0', '9')])))
		.term(term("sign", class(&[('+', '+'), ('-', '-')])))
		.shape(
			shape("coordinate.decimal_pair")
				.grammar(sequence([
					capture("latitude", signed_decimal()),
					zero_or_more(reference("ascii_whitespace")),
					literal(","),
					zero_or_more(reference("ascii_whitespace")),
					capture("longitude", signed_decimal()),
				]))
				.capture("latitude", CaptureType::Decimal)
				.capture("longitude", CaptureType::Decimal)
				.scope(Scope::WholeOrEmbedded),
		)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_family_is_valid_and_sealed() {
		let document = family().build().expect("the coordinates family validates");

		assert_eq!(document.family, FAMILY);
		assert_eq!(document.shapes.len(), 1);
		assert_eq!(document.hash, document.content_hash());
	}
}
