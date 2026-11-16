// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The validators of the coordinate spellings that carry more than two bare numbers: degrees, minutes and seconds with
//! hemisphere letters, a pair with axis labels, and a Google Maps path segment.
//!
//! All three build the payload of the decimal pair, [`PairPoint`]: a validated latitude, a validated longitude and
//! the axis order the text was read in. What differs is how each decides the order.
//!
//! # `AnglePair`
//!
//! The shape's grammar accepts the text and declares no captures, because a pair of marked angles has no capture layout
//! that holds one capture for each part: which half carries a mark changes the structure. The validator reads the span.
//!
//! It requires a character that marks a coordinate (a separator, a decimal point, a degree, minute or second mark or a
//! hemisphere letter), so `12 34` stays a house number and a postcode. It splits the text at the first comma or
//! semicolon; or after the first hemisphere letter that white space follows; or at the white space between two tokens.
//! Anything after a second separator is dropped. Each half is read with the angle program of
//! [`crate::grammars::angles`]: an optional sign, degrees, optional minutes and seconds and an optional hemisphere
//! letter. The magnitude is `degrees + minutes / 60 + seconds / 3600`, evaluated left to right in 64-bit floating point,
//! and the angle is negative when the sign is `-` or the hemisphere is `S` or `W`.
//!
//! Hemisphere letters decide the axis. `N` and `S` name latitudes and `E` and `W` name longitudes. With letters on both
//! halves, a latitude letter on the first and a longitude letter on the second is latitude first, the reverse is
//! longitude first, and two letters of one axis are refused. With a letter on one half only, that letter decides which
//! axis the half is, and the other half is the other axis. Without letters the first half is the latitude, unless only
//! the other order puts both numbers in range. A pair with a letter and a value out of range is refused and never
//! swapped.
//!
//! # `LabeledPair`
//!
//! The labels `lat`, `latitude`, `lon`, `longitude` and `lng` in either case say which half is which. The labels must
//! name both axes. The order is fixed by the labels, so a value out of range is refused and never swapped.
//!
//! # `MapsSegment`
//!
//! Google Maps writes `@latitude,longitude,zoom` in a path segment, and the order is fixed at latitude first.

use crate::captures::{extract, Captures, ExtractError};
use crate::grammars::angles::{angle_program, ANGLE_SHAPE};
use crate::recognition::Rejection;
use crate::validators::{
	about, decimal, read_pair, required, AxisOrder, Decimal, FieldType, Latitude, Longitude, PairPoint, PayloadField,
	Validator,
};

/// Builds the payload of a pair from a latitude and a longitude that are not yet checked.
fn point(latitude: f64, longitude: f64, order: AxisOrder) -> Result<PairPoint, Rejection> {
	Ok(PairPoint {
		latitude: Latitude::new(latitude)?,
		longitude: Longitude::new(longitude)?,
		order,
	})
}

const PAIR_PAYLOAD: &[PayloadField] = &[
	PayloadField {
		name: "latitude",
		kind: FieldType::Latitude,
		optional: false,
	},
	PayloadField {
		name: "longitude",
		kind: FieldType::Longitude,
		optional: false,
	},
	PayloadField {
		name: "order",
		kind: FieldType::AxisOrder,
		optional: false,
	},
];

/// The characters JavaScript's `\s` matches, which the grammar's `whitespace` term holds too.
fn is_space(character: char) -> bool {
	matches!(
		character,
		'\t'..='\r'
			| ' ' | '\u{a0}'
			| '\u{1680}'
			| '\u{2000}'..='\u{200a}'
			| '\u{2028}'
			| '\u{2029}'
			| '\u{202f}'
			| '\u{205f}'
			| '\u{3000}'
			| '\u{feff}'
	)
}

/// The characters a regular expression's `.` does not match.
fn is_line_terminator(character: char) -> bool {
	matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The characters that make a text a candidate for a pair of angles, so that `12 34` stays a house number and a
/// postcode.
const COORDINATE_MARKS: &str = ",;.°º'′\"″NSEWnsew";

/// One half of a pair of angles, with the hemisphere letter it carried.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Angle {
	degrees: f64,
	hemisphere: Option<char>,
}

fn malformed(half: &str, why: &str) -> Rejection {
	Rejection::new(
		"malformed_angle",
		None,
		format!("`{}` is not an angle: {why}", half.trim_matches(is_space)),
	)
}

impl Angle {
	/// Reads one half of a pair with the angle program, as the half trimmed of white space is read.
	fn read(half: &str) -> Result<Angle, Rejection> {
		let text = half.trim_matches(is_space);
		let captures = extract(angle_program(), ANGLE_SHAPE, text, 0, text.len()).map_err(|error| match error {
			ExtractError::Limit => malformed(half, "the capture walk passed its limit"),
			ExtractError::NoParse => malformed(half, "it has no degrees, minutes, seconds and hemisphere form"),
		})?;
		let number = |path: &str| -> Result<f64, Rejection> {
			match captures.get(path) {
				Some(text) => Ok(Decimal::parse(text).map_err(about(path))?.get()),
				None => Ok(0.0),
			}
		};

		// A word mark, `d`, `m` or `s`, is a mark only at a word boundary: it needs white space after it when more of
		// the angle follows. The program captures a mark with the white space after it.
		for (mark, letter, followers) in [
			("degree_mark", 'd', &["minutes", "seconds", "hemisphere"][..]),
			("minute_mark", 'm', &["seconds", "hemisphere"][..]),
			("second_mark", 's', &["hemisphere"][..]),
		] {
			let Some(text) = captures.get(mark) else { continue };
			let bare = text.chars().count() == 1;

			if bare
				&& text.starts_with([letter, letter.to_ascii_uppercase()])
				&& followers.iter().any(|path| captures.get(path).is_some())
			{
				return Err(malformed(
					half,
					&format!("`{letter}` is a mark only before a word boundary"),
				));
			}
		}

		let (degrees, minutes, seconds) = (number("degrees")?, number("minutes")?, number("seconds")?);
		let magnitude = degrees + minutes / 60.0 + seconds / 3600.0;

		Decimal::new(magnitude).map_err(about("degrees"))?;

		let hemisphere = captures
			.get("hemisphere")
			.and_then(|text| text.chars().next())
			.map(|letter| letter.to_ascii_uppercase());
		let negative = captures.get("sign") == Some("-") || matches!(hemisphere, Some('S' | 'W'));

		Ok(Angle {
			degrees: if negative { -magnitude } else { magnitude },
			hemisphere,
		})
	}

	fn names_latitude(self) -> bool {
		matches!(self.hemisphere, Some('N' | 'S'))
	}

	fn names_longitude(self) -> bool {
		matches!(self.hemisphere, Some('E' | 'W'))
	}
}

/// Splits at the first comma or semicolon: the text before it and the text between it and the next one.
fn split_at_separator(text: &str) -> Option<(&str, &str)> {
	let mut parts = text.split([',', ';']);
	let first = parts.next()?;

	parts.next().map(|second| (first, second))
}

/// Splits as `^(.+?[NSEW])\s+(.+)$` does in either case: the text through the first hemisphere letter that white space
/// follows, and the rest. A dot stops at a line terminator.
fn split_at_hemisphere(text: &str) -> Option<(&str, &str)> {
	let characters: Vec<(usize, char)> = text.char_indices().collect();

	for (index, (start, character)) in characters.iter().copied().enumerate().skip(1) {
		if is_line_terminator(characters[index - 1].1) {
			return None;
		}

		if !matches!(character, 'N' | 'S' | 'E' | 'W' | 'n' | 's' | 'e' | 'w') {
			continue;
		}

		let after = start + character.len_utf8();
		let tail = text[after..].trim_start_matches(is_space);

		if tail.len() == text[after..].len() {
			continue;
		}

		if !tail.is_empty() && !tail.chars().any(is_line_terminator) {
			return Some((&text[..after], tail));
		}
	}

	None
}

/// Splits as `^(\S+)\s+(\S+)$` does.
fn split_at_space(text: &str) -> Option<(&str, &str)> {
	let end = text.find(is_space)?;
	let tail = text[end..].trim_start_matches(is_space);

	(end > 0 && !tail.is_empty() && !tail.contains(is_space)).then_some((&text[..end], tail))
}

/// `AnglePair`: the two angles of a degrees-minutes-seconds pair, as the module documentation reads them.
pub struct AnglePair;

impl Validator for AnglePair {
	type Output = PairPoint;

	const ID: &'static str = "AnglePair";

	const PAYLOAD: &'static [PayloadField] = PAIR_PAYLOAD;

	const REJECTIONS: &'static [&'static str] = &[
		"conflicting_hemispheres",
		"latitude_out_of_range",
		"longitude_out_of_range",
		"malformed_angle",
		"no_coordinate_mark",
		"not_a_decimal",
		"not_finite",
		"unsplittable_pair",
	];

	fn validate(captures: &Captures<'_>) -> Result<PairPoint, Rejection> {
		let text = captures.span().trim_matches(is_space);

		if !text.contains(|character| COORDINATE_MARKS.contains(character)) {
			return Err(Rejection::new(
				"no_coordinate_mark",
				None,
				"the text has no separator, decimal point, mark or hemisphere letter",
			));
		}

		let halves = if text.contains([',', ';']) {
			split_at_separator(text)
		} else {
			split_at_hemisphere(text).or_else(|| split_at_space(text))
		};
		let Some((first, second)) = halves else {
			return Err(Rejection::new(
				"unsplittable_pair",
				None,
				"no comma, semicolon or white space divides the text into two",
			));
		};
		let (first, second) = (Angle::read(first)?, Angle::read(second)?);

		if first.hemisphere.is_some() && second.hemisphere.is_some() {
			if first.names_latitude() && second.names_longitude() {
				return point(first.degrees, second.degrees, AxisOrder::LatLon);
			}

			if first.names_longitude() && second.names_latitude() {
				return point(second.degrees, first.degrees, AxisOrder::LonLat);
			}

			return Err(Rejection::new(
				"conflicting_hemispheres",
				None,
				"the two hemisphere letters name the same axis",
			));
		}

		if first.hemisphere.is_some() {
			return if first.names_latitude() {
				point(first.degrees, second.degrees, AxisOrder::LatLon)
			} else {
				point(second.degrees, first.degrees, AxisOrder::LonLat)
			};
		}

		if second.hemisphere.is_some() {
			return if second.names_longitude() {
				point(first.degrees, second.degrees, AxisOrder::LatLon)
			} else {
				point(second.degrees, first.degrees, AxisOrder::LonLat)
			};
		}

		// No letters: written order first, and the other order only when it alone is in range.
		match point(first.degrees, second.degrees, AxisOrder::LatLon) {
			Ok(found) => Ok(found),
			Err(refusal) => point(second.degrees, first.degrees, AxisOrder::LonLat).map_err(|_| refusal),
		}
	}
}

/// Whether a label names the latitude, as the labels `lat` and `latitude` do in any case. The other labels the grammar
/// admits, `lon`, `longitude` and `lng`, name the longitude.
fn names_latitude(label: &str) -> bool {
	label.len() >= 3 && label.as_bytes()[..3].eq_ignore_ascii_case(b"lat")
}

/// `LabeledPair`: two values with an axis label each, in either order.
pub struct LabeledPair;

impl Validator for LabeledPair {
	type Output = PairPoint;

	const ID: &'static str = "LabeledPair";

	const PAYLOAD: &'static [PayloadField] = PAIR_PAYLOAD;

	const REJECTIONS: &'static [&'static str] = &[
		"latitude_out_of_range",
		"longitude_out_of_range",
		"missing_capture",
		"not_a_decimal",
		"not_finite",
		"same_axis_labels",
	];

	fn validate(captures: &Captures<'_>) -> Result<PairPoint, Rejection> {
		let first_label = required(captures, "first_label")?;
		let second_label = required(captures, "second_label")?;
		let first = decimal(captures, "first_value")?.get();
		let second = decimal(captures, "second_value")?.get();

		if names_latitude(first_label) == names_latitude(second_label) {
			return Err(Rejection::new(
				"same_axis_labels",
				None,
				format!("the labels `{first_label}` and `{second_label}` name the same axis"),
			));
		}

		if names_latitude(first_label) {
			point(first, second, AxisOrder::LatLon)
		} else {
			point(second, first, AxisOrder::LonLat)
		}
	}
}

/// `SpacedPair`: two decimals divided by white space. It reads the pair as a decimal pair is read, and the grammar
/// holds no capture because it needs a decimal point in at least one number, which is a choice that would make a
/// capture twice.
pub struct SpacedPair;

impl Validator for SpacedPair {
	type Output = PairPoint;

	const ID: &'static str = "SpacedPair";

	const PAYLOAD: &'static [PayloadField] = PAIR_PAYLOAD;

	const REJECTIONS: &'static [&'static str] = &[
		"latitude_out_of_range",
		"longitude_out_of_range",
		"not_a_decimal",
		"not_finite",
		"unsplittable_pair",
	];

	fn validate(captures: &Captures<'_>) -> Result<PairPoint, Rejection> {
		let Some((first, second)) = split_at_space(captures.span().trim_matches(is_space)) else {
			return Err(Rejection::new(
				"unsplittable_pair",
				None,
				"white space does not divide the text into two numbers",
			));
		};

		read_pair(
			Decimal::parse(first).map_err(about("first"))?.get(),
			Decimal::parse(second).map_err(about("second"))?.get(),
		)
	}
}

/// `MapsSegment`: the `first` and `second` captures are the latitude and the longitude.
pub struct MapsSegment;

impl Validator for MapsSegment {
	type Output = PairPoint;

	const ID: &'static str = "MapsSegment";

	const PAYLOAD: &'static [PayloadField] = PAIR_PAYLOAD;

	const REJECTIONS: &'static [&'static str] = &[
		"latitude_out_of_range",
		"longitude_out_of_range",
		"missing_capture",
		"not_a_decimal",
		"not_finite",
	];

	fn validate(captures: &Captures<'_>) -> Result<PairPoint, Rejection> {
		point(
			decimal(captures, "first")?.get(),
			decimal(captures, "second")?.get(),
			AxisOrder::LatLon,
		)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn dms(text: &str) -> Result<PairPoint, Rejection> {
		AnglePair::validate(&Captures::of_span(text))
	}

	fn read(text: &str) -> (f64, f64, AxisOrder) {
		let point = dms(text).unwrap();

		(point.latitude.get(), point.longitude.get(), point.order)
	}

	#[test]
	fn degrees_minutes_seconds_read_with_hemisphere_letters() {
		let (latitude, longitude, order) = read("38°53'51.72\"N 77°2'11.40\"W");

		assert!((latitude - 38.8977).abs() < 1e-4 && (longitude + 77.0365).abs() < 1e-4);
		assert_eq!(order, AxisOrder::LatLon);
		assert_eq!(read("2.2945E, 48.8584N"), (48.8584, 2.2945, AxisOrder::LonLat));
		assert_eq!(read("48.8584N 2.2945E"), (48.8584, 2.2945, AxisOrder::LatLon));
		assert_eq!(read("33° 51′ 54″ S, 151° 12′ 36″ E").2, AxisOrder::LatLon);
	}

	#[test]
	fn minutes_and_seconds_are_independent_groups() {
		assert_eq!(read("12°30'N, 5E"), (12.5, 5.0, AxisOrder::LatLon));
		assert_eq!(read("12°30\"N, 5E").0, 12.0 + 30.0 / 3600.0);
		// The second apostrophe cannot continue the minutes, so the walk gives them back and reads seconds.
		assert_eq!(read("12°30''N, 5E").0, 12.0 + 30.0 / 3600.0);
		// A minute mark and no degree mark.
		assert_eq!(read("12 30' N, 5 E").0, 12.5);
	}

	#[test]
	fn a_word_mark_needs_a_word_boundary() {
		assert_eq!(read("12d 30m N, 5 E").0, 12.5);
		assert_eq!(dms("12d30m N, 5 E").unwrap_err().code, "malformed_angle");
		assert_eq!(read("12d, 5E").0, 12.0);
		// `s` is read as the seconds mark here, as the regular expression reads it, and not as the southern hemisphere.
		assert_eq!(read("12°30′20S, 5E").0, 12.0 + 30.0 / 60.0 + 20.0 / 3600.0);
	}

	#[test]
	fn the_axis_follows_the_letters_and_never_swaps_past_them() {
		assert_eq!(dms("40N, 50N").unwrap_err().code, "conflicting_hemispheres");
		assert_eq!(dms("100N, 50E").unwrap_err().code, "latitude_out_of_range");
		assert_eq!(read("-12 S, 5 W").0, -12.0);
		assert_eq!(read("100°, 40°"), (40.0, 100.0, AxisOrder::LonLat));
	}

	#[test]
	fn a_text_without_a_mark_or_a_split_is_a_typed_rejection() {
		assert_eq!(dms("12 34").unwrap_err().code, "no_coordinate_mark");
		assert_eq!(dms("12°").unwrap_err().code, "unsplittable_pair");
		assert_eq!(dms("12, abc°").unwrap_err().code, "malformed_angle");
		assert_eq!(dms("12 N 5").unwrap().order, AxisOrder::LatLon);
	}

	#[test]
	fn white_space_alone_divides_at_the_first_hemisphere_letter_or_between_two_tokens() {
		assert_eq!(read("12N 30E"), (12.0, 30.0, AxisOrder::LatLon));
		assert_eq!(read("12° 30°"), (12.0, 30.0, AxisOrder::LatLon));
		assert_eq!(split_at_hemisphere("12 N 30 E"), Some(("12 N", "30 E")));
		assert_eq!(split_at_space("12.5 30"), Some(("12.5", "30")));
		assert_eq!(split_at_space("12.5 30 5"), None);
	}

	#[test]
	fn a_third_number_after_a_second_separator_is_dropped() {
		assert_eq!(read("12°, 30°, 5°"), (12.0, 30.0, AxisOrder::LatLon));
	}
}
