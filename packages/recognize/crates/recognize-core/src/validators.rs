// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Validators and the values they validate.
//!
//! A validator is code the engine holds, keyed by the [`ValidatorID`](crate::ValidatorID) a shape declares. It reads the
//! captures of an accepted span and returns the shape's typed payload or a [`Rejection`]. Each validator is a type that
//! implements [`Validator`] and sits in this module under the name of its ID. The generated declarations of a family
//! refer to `validators::<ID>`, so a shape that declares an ID with no binding here fails the Rust build.
//!
//! Each validated value is a newtype that validates on construction, as `CellIndex::new` does in the h3 package: the
//! only way to hold a [`Decimal`] is to parse or build a finite one, and no constructor takes an unchecked value.

use std::fmt::Debug;

use serde::Serialize;

use crate::captures::Captures;
use crate::recognition::Rejection;

/// A validator bound to one `ValidatorID`.
pub trait Validator {
	/// The typed payload a validated span carries.
	type Output: Clone + Debug + PartialEq + Serialize;

	/// The `ValidatorID` text this type answers to. The generated declarations check it against the ID the grammar
	/// names, so a type under the wrong name fails the build.
	const ID: &'static str;

	/// Validates the captures of one accepted span and builds the payload.
	fn validate(captures: &Captures<'_>) -> Result<Self::Output, Rejection>;
}

/// Whether two strings are equal, for the const check the generated declarations make.
pub const fn same_text(a: &str, b: &str) -> bool {
	let (a, b) = (a.as_bytes(), b.as_bytes());

	if a.len() != b.len() {
		return false;
	}

	let mut index = 0;

	while index < a.len() {
		if a[index] != b[index] {
			return false;
		}

		index += 1;
	}

	true
}

/// Fails const evaluation, and so the build, when a validator type's `ID` differs from the ID the grammar names.
pub const fn assert_binding(declared: &str, bound: &str) {
	assert!(
		same_text(declared, bound),
		"a validator's ID differs from the ValidatorID the shape declares"
	);
}

/// A finite floating-point number parsed from a capture.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Decimal(f64);

impl Decimal {
	/// Wraps `value` when it is finite.
	pub fn new(value: f64) -> Result<Self, Rejection> {
		if value.is_finite() {
			Ok(Decimal(value))
		} else {
			Err(Rejection::new(
				"not_finite",
				None,
				format!("{value} is not a finite number"),
			))
		}
	}

	/// Parses a decimal such as `-74.006`, `+.5` or `12`.
	pub fn parse(text: &str) -> Result<Self, Rejection> {
		let value: f64 = text
			.parse()
			.map_err(|_| Rejection::new("not_a_decimal", None, format!("`{text}` is not a decimal number")))?;

		Decimal::new(value)
	}

	pub fn get(self) -> f64 {
		self.0
	}
}

/// A whole number parsed from a capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Integer(i64);

impl Integer {
	pub fn new(value: i64) -> Self {
		Integer(value)
	}

	/// Parses a whole number, with an optional sign.
	pub fn parse(text: &str) -> Result<Self, Rejection> {
		text.parse().map(Integer).map_err(|_| {
			Rejection::new(
				"not_an_integer",
				None,
				format!("`{text}` is not a whole number in range"),
			)
		})
	}

	pub fn get(self) -> i64 {
		self.0
	}
}

/// The text of a capture the parse made, or a rejection naming the capture when the parse skipped it.
pub fn required<'a>(captures: &Captures<'a>, path: &str) -> Result<&'a str, Rejection> {
	captures.get(path).ok_or_else(|| {
		Rejection::new(
			"missing_capture",
			Some(path),
			format!("the parse made no capture `{path}`"),
		)
	})
}

/// Reads a required capture as a [`Decimal`], naming the capture in a rejection.
pub fn decimal(captures: &Captures<'_>, path: &str) -> Result<Decimal, Rejection> {
	Decimal::parse(required(captures, path)?).map_err(|mut rejection| {
		rejection.capture = Some(path.to_string());
		rejection
	})
}

/// Reads a required capture as an [`Integer`], naming the capture in a rejection.
pub fn integer(captures: &Captures<'_>, path: &str) -> Result<Integer, Rejection> {
	Integer::parse(required(captures, path)?).map_err(|mut rejection| {
		rejection.capture = Some(path.to_string());
		rejection
	})
}

/// Two finite decimals, `latitude` and `longitude`, parsed from a decimal pair. The WGS84 range check is a separate
/// validator; this one proves only that both captures are finite numbers.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DecimalPair {
	latitude: Decimal,
	longitude: Decimal,
}

impl DecimalPair {
	pub fn new(latitude: Decimal, longitude: Decimal) -> Self {
		DecimalPair { latitude, longitude }
	}

	pub fn latitude(&self) -> Decimal {
		self.latitude
	}

	pub fn longitude(&self) -> Decimal {
		self.longitude
	}
}

/// `FiniteDecimalPair`: the `latitude` and `longitude` captures parse as finite numbers.
pub struct FiniteDecimalPair;

impl Validator for FiniteDecimalPair {
	type Output = DecimalPair;

	const ID: &'static str = "FiniteDecimalPair";

	fn validate(captures: &Captures<'_>) -> Result<DecimalPair, Rejection> {
		Ok(DecimalPair::new(
			decimal(captures, "latitude")?,
			decimal(captures, "longitude")?,
		))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::captures::{extract, CaptureProgram, ProgramShape};
	use crate::grammars::coordinates;

	fn captures_of(text: &str) -> Captures<'_> {
		let document = coordinates::family().build().unwrap();
		let shape = &document.shapes[0];
		let mut program = CaptureProgram::default();

		for term in &document.terms {
			program.terms.insert(term.id.clone(), term.grammar.clone());
		}

		program.shapes.insert(
			shape.id.clone(),
			ProgramShape {
				captures: shape.captures.clone(),
				node: shape.grammar.clone(),
			},
		);

		let program: &'static CaptureProgram = Box::leak(Box::new(program));

		extract(program, &shape.id, text, 0, text.len()).unwrap()
	}

	#[test]
	fn a_decimal_is_finite_by_construction() {
		assert_eq!(Decimal::new(1.5).unwrap().get(), 1.5);
		assert_eq!(Decimal::new(f64::NAN).unwrap_err().code, "not_finite");
		assert_eq!(Decimal::new(f64::INFINITY).unwrap_err().code, "not_finite");
		assert_eq!(Decimal::parse("+.5").unwrap().get(), 0.5);
		assert_eq!(Decimal::parse("-74.0060").unwrap().get(), -74.006);
		assert_eq!(Decimal::parse("abc").unwrap_err().code, "not_a_decimal");
		// A run of digits past the range of an `f64` parses to infinity and is refused.
		assert_eq!(Decimal::parse(&"9".repeat(400)).unwrap_err().code, "not_finite");
	}

	#[test]
	fn an_integer_refuses_text_out_of_range() {
		assert_eq!(Integer::parse("-12").unwrap().get(), -12);
		assert_eq!(
			Integer::parse("99999999999999999999").unwrap_err().code,
			"not_an_integer"
		);
	}

	#[test]
	fn the_finite_pair_validator_reads_both_captures() {
		let pair = FiniteDecimalPair::validate(&captures_of("40.7128, -74.0060")).unwrap();

		assert_eq!(pair.latitude().get(), 40.7128);
		assert_eq!(pair.longitude().get(), -74.006);
		assert_eq!(
			serde_json::to_string(&pair).unwrap(),
			r#"{"latitude":40.7128,"longitude":-74.006}"#
		);
	}

	#[test]
	fn the_finite_pair_validator_names_the_capture_it_refuses() {
		let rejection = FiniteDecimalPair::validate(&captures_of(&format!("{}, 1", "9".repeat(400)))).unwrap_err();

		assert_eq!(rejection.code, "not_finite");
		assert_eq!(rejection.capture.as_deref(), Some("latitude"));
	}

	#[test]
	fn a_missing_capture_is_a_rejection_and_not_a_default() {
		let rejection = FiniteDecimalPair::validate(&Captures::of_span("1,2")).unwrap_err();

		assert_eq!(rejection.code, "missing_capture");
		assert_eq!(rejection.capture.as_deref(), Some("latitude"));
	}
}
