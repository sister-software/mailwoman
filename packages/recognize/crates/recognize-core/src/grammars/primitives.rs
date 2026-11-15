// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `primitives` family: four small grammars independent of the `structure` family, which exercise the AST, the
//! references and the ambiguity declarations.
//!
//! - `number.signed_decimal`: an optional sign, then digits with an optional fraction, or a bare fraction.
//! - `number.digit_run`: one or more ASCII digits.
//! - `space.whitespace`: one or more ASCII whitespace characters.
//! - `word.ascii`: one or more ASCII letters.
//!
//! A digit run is also a signed decimal, so the two declare that overlap.

use crate::ast::{choice, class, literal, one_or_more, optional, reference, sequence};
use crate::family::{shape, term, Family};
use crate::ir::Scope;

pub const FAMILY: &str = "primitives";

/// Builds the family. The grammars are valid by construction, and the module's tests hold that.
pub fn family() -> Family {
	Family::new(FAMILY)
		.term(term("ascii_letter", class(&[('A', 'Z'), ('a', 'z')])))
		.term(term("ascii_whitespace", class(&[('\t', '\r'), (' ', ' ')])))
		.term(term("digit", class(&[('0', '9')])))
		.term(term("sign", class(&[('+', '+'), ('-', '-')])))
		.shape(
			shape("number.signed_decimal")
				.grammar(sequence([
					optional(reference("sign")),
					choice([
						sequence([
							one_or_more(reference("digit")),
							optional(sequence([literal("."), one_or_more(reference("digit"))])),
						]),
						sequence([literal("."), one_or_more(reference("digit"))]),
					]),
				]))
				.scope(Scope::WholeOrEmbedded)
				.may_overlap(&["number.digit_run"]),
		)
		.shape(
			shape("number.digit_run")
				.grammar(one_or_more(reference("digit")))
				.scope(Scope::WholeOrEmbedded)
				.may_overlap(&["number.signed_decimal"]),
		)
		.shape(
			shape("space.whitespace")
				.grammar(one_or_more(reference("ascii_whitespace")))
				.scope(Scope::WholeOrEmbedded),
		)
		.shape(
			shape("word.ascii")
				.grammar(one_or_more(reference("ascii_letter")))
				.scope(Scope::WholeOrEmbedded),
		)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_family_is_valid_and_sealed() {
		let document = family().build().expect("the primitives family validates");

		assert_eq!(document.family, FAMILY);
		assert_eq!(document.shapes.len(), 4);
		assert_eq!(document.terms.len(), 4);
		assert_eq!(document.hash, document.content_hash());
		assert!(document
			.shapes
			.iter()
			.all(|shape| shape.source.file.ends_with("grammars/primitives.rs")));
	}
}
