// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The validators of the `spatial` family's grid codes: the Open Location Code and DIGIPIN.
//!
//! A validator reads the format of a code and builds its canonical text. Decoding a code to its cell is arithmetic on
//! the grid, and it stays in `@mailwoman/spatial`.
//!
//! # `PlusCode`
//!
//! The Open Location Code specification fixes the alphabet and the separator. The alphabet is the twenty characters
//! `23456789CFGHJMPQRVWX` (section "Character Set > Digits"), the separator is `+` (section "Format Separator"), and
//! the code is case insensitive when read and upper case when written (section "API Requirements").
//!
//! The grammar admits two to eight digits before the separator and two or three after it. The validator reads the count
//! before the separator:
//!
//! * Eight digits is a full code. The specification places the separator after eight digits (section "Formatting").
//! * Two, four or six digits is a short code. The specification removes between two and six digits from the start of a
//!   code (section "Short Codes"), and the Open Location Code shortens in pairs, so an odd count is refused.
//!
//! A code that holds a padding `0`, and a code with more than three digits after the separator, are valid in the
//! specification and are not admitted. An address carries the ten and eleven digit forms, and
//! `@mailwoman/spatial` reads only those.
//!
//! # `DIGIPIN`
//!
//! India Post's technical document fixes the alphabet, `2 3 4 5 6 7 8 9 C J K L M P F T` (section 4.3), and the length of
//! ten characters (section 2). The document forbids hyphens and requires upper case. `@mailwoman/spatial` reads the
//! display form `39J-49L-L8T4`, with hyphens after the third and sixth character, and reads lower case, so this
//! validator does too, and the payload holds the ten characters in upper case.

use serde::Serialize;

use crate::captures::Captures;
use crate::recognition::Rejection;
use crate::validators::{FieldType, PayloadField, Validator};

/// The Open Location Code digits.
const OLC_ALPHABET: &str = "23456789CFGHJMPQRVWX";

/// The DIGIPIN characters, in no grid order.
const DIGIPIN_ALPHABET: &str = "23456789CJKLMPFT";

/// An Open Location Code in upper case, as the one variant that holds it.
///
/// A full code has eight digits before the separator and names a cell by itself. A short code has two, four or six and
/// names a cell only beside a reference position. The payload holds exactly one of the two fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PlusCodeValue {
	Full { full_code: String },
	Short { short_code: String },
}

/// `PlusCode`: a token of Open Location Code digits and a separator, read as a full or a short code.
pub struct PlusCode;

impl Validator for PlusCode {
	type Output = PlusCodeValue;

	const ID: &'static str = "PlusCode";

	const PAYLOAD: &'static [PayloadField] = &[
		PayloadField {
			name: "full_code",
			kind: FieldType::FullPlusCode,
			optional: true,
		},
		PayloadField {
			name: "short_code",
			kind: FieldType::ShortPlusCode,
			optional: true,
		},
	];

	const REJECTIONS: &'static [&'static str] = &["invalid_digit", "invalid_prefix_length", "invalid_suffix_length"];

	fn validate(captures: &Captures<'_>) -> Result<PlusCodeValue, Rejection> {
		let code = captures.span().to_ascii_uppercase();
		let Some((prefix, suffix)) = code.split_once('+') else {
			return Err(Rejection::new("invalid_digit", None, "the code has no `+` separator"));
		};

		if let Some(digit) = prefix
			.chars()
			.chain(suffix.chars())
			.find(|digit| !OLC_ALPHABET.contains(*digit))
		{
			return Err(Rejection::new(
				"invalid_digit",
				None,
				format!("`{digit}` is not an Open Location Code digit"),
			));
		}

		if !(2..=3).contains(&suffix.len()) {
			return Err(Rejection::new(
				"invalid_suffix_length",
				None,
				format!(
					"{} digits follow the separator, and a code has two or three",
					suffix.len()
				),
			));
		}

		match prefix.len() {
			8 => Ok(PlusCodeValue::Full { full_code: code }),
			2 | 4 | 6 => Ok(PlusCodeValue::Short { short_code: code }),
			length => Err(Rejection::new(
				"invalid_prefix_length",
				None,
				format!("{length} digits precede the separator, and a code has two, four, six or eight"),
			)),
		}
	}
}

/// A DIGIPIN as its ten characters in upper case, without hyphens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DigipinValue {
	pub code: String,
}

/// `DIGIPIN`: ten characters of the DIGIPIN alphabet, or the display form with hyphens after the third and sixth.
pub struct DIGIPIN;

impl Validator for DIGIPIN {
	type Output = DigipinValue;

	const ID: &'static str = "DIGIPIN";

	const PAYLOAD: &'static [PayloadField] = &[PayloadField {
		name: "code",
		kind: FieldType::Digipin,
		optional: false,
	}];

	const REJECTIONS: &'static [&'static str] = &["invalid_character", "invalid_length"];

	fn validate(captures: &Captures<'_>) -> Result<DigipinValue, Rejection> {
		let span = captures.span();
		let digits: String = match span.len() {
			10 => span.to_string(),
			12 if span.as_bytes()[3] == b'-' && span.as_bytes()[7] == b'-' => span.replace('-', ""),
			length => {
				return Err(Rejection::new(
					"invalid_length",
					None,
					format!("{length} characters, and a DIGIPIN has ten or twelve with two hyphens"),
				))
			}
		};
		let code = digits.to_ascii_uppercase();

		match code.chars().find(|character| !DIGIPIN_ALPHABET.contains(*character)) {
			Some(character) => Err(Rejection::new(
				"invalid_character",
				None,
				format!("`{character}` is not a DIGIPIN character"),
			)),
			None => Ok(DigipinValue { code }),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn plus(text: &str) -> Result<PlusCodeValue, Rejection> {
		PlusCode::validate(&Captures::of_span(text))
	}

	fn pin(text: &str) -> Result<DigipinValue, Rejection> {
		DIGIPIN::validate(&Captures::of_span(text))
	}

	#[test]
	fn a_full_code_has_eight_digits_before_the_separator() {
		assert_eq!(
			plus("764mvfq6+92p").unwrap(),
			PlusCodeValue::Full {
				full_code: "764MVFQ6+92P".to_string()
			}
		);
		assert!(plus("764MVFQ6+92PX").is_err());
	}

	#[test]
	fn a_short_code_has_two_four_or_six_digits() {
		for text in ["VF+92", "VFQ6+92P", "VFQ6M7+92"] {
			assert!(matches!(plus(text).unwrap(), PlusCodeValue::Short { .. }), "{text}");
		}

		for text in ["VFQ+92P", "VFQ6M+92", "VFQ6M7X+92"] {
			assert_eq!(plus(text).unwrap_err().code, "invalid_prefix_length", "{text}");
		}
	}

	#[test]
	fn a_code_outside_the_alphabet_is_refused() {
		assert_eq!(plus("VFA6+92P").unwrap_err().code, "invalid_digit");
		assert_eq!(plus("VFQ6+9").unwrap_err().code, "invalid_suffix_length");
		assert_eq!(plus("VFQ6").unwrap_err().code, "invalid_digit");
	}

	#[test]
	fn a_digipin_reads_both_forms_and_normalizes_them() {
		assert_eq!(pin("39J49LL8T4").unwrap().code, "39J49LL8T4");
		assert_eq!(pin("39j-49l-l8t4").unwrap().code, "39J49LL8T4");
	}

	#[test]
	fn a_digipin_with_a_wrong_length_or_character_is_refused() {
		assert_eq!(pin("39J49LL8T").unwrap_err().code, "invalid_length");
		assert_eq!(pin("39J-49LL-8T4").unwrap_err().code, "invalid_length");
		assert_eq!(pin("39J49LL8TA").unwrap_err().code, "invalid_character");
		assert_eq!(pin("39J-49L-L8T1").unwrap_err().code, "invalid_character");
	}
}
