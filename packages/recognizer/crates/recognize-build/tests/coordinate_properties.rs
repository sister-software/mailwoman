// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Property tests for the coordinates family: generated in-range pairs validate, generated out-of-range pairs are
//! rejected with the right reason, and adversarial text never panics, never fails to terminate and never yields a span
//! that splits a codepoint.

mod support;

use std::sync::OnceLock;

use proptest::prelude::*;
use recognize_core::{Engine, SearchError, ValidationResult};

use support::engine_for;

fn engine() -> &'static Engine {
	static ENGINE: OnceLock<Engine> = OnceLock::new();

	ENGINE.get_or_init(|| engine_for(recognize_core::grammars::families()))
}

/// The validation of the recognition of `shape` that covers the whole of `text`.
fn whole(text: &str, shape: &str) -> ValidationResult {
	engine()
		.recognize(text)
		.unwrap()
		.into_iter()
		.find(|recognition| {
			recognition.candidate.shape == shape
				&& (recognition.candidate.start, recognition.candidate.end) == (0, text.len())
		})
		.unwrap_or_else(|| panic!("no whole `{shape}` in {text:?}"))
		.validation
}

fn payload(validation: ValidationResult) -> serde_json::Value {
	match validation {
		ValidationResult::Validated(payload) => serde_json::to_value(payload).unwrap(),
		other => panic!("expected a validated payload, got {other:?}"),
	}
}

fn rejection(validation: ValidationResult) -> (String, Option<String>) {
	match validation {
		ValidationResult::Rejected(rejection) => (rejection.code.to_string(), rejection.capture),
		other => panic!("expected a rejection, got {other:?}"),
	}
}

fn separator() -> impl Strategy<Value = &'static str> {
	prop_oneof![
		Just(","),
		Just(", "),
		Just(" , "),
		Just(";"),
		Just("\t;\t"),
		Just(" ,\n ")
	]
}

proptest! {
	#![proptest_config(ProptestConfig::with_cases(96))]

	#[test]
	fn an_in_range_pair_is_validated_latitude_first(
		latitude in -90.0f64..=90.0,
		longitude in -180.0f64..=180.0,
		separator in separator(),
		places in 0usize..7,
	) {
		let (first, second) = (format!("{latitude:.places$}"), format!("{longitude:.places$}"));
		let text = format!("{first}{separator}{second}");
		let value = payload(whole(&text, "coordinate.decimal_pair"));

		prop_assert_eq!(value["order"].as_str(), Some("lat_lon"));
		prop_assert_eq!(value["latitude"].as_f64(), first.parse::<f64>().ok());
		prop_assert_eq!(value["longitude"].as_f64(), second.parse::<f64>().ok());
	}

	#[test]
	fn a_pair_out_of_range_on_both_axes_is_rejected_for_its_latitude(
		latitude in 90.001f64..5000.0,
		longitude in 180.001f64..5000.0,
		negate_first in any::<bool>(),
		negate_second in any::<bool>(),
	) {
		let sign = |negate: bool| if negate { "-" } else { "" };
		let text = format!("{}{latitude:.3}, {}{longitude:.3}", sign(negate_first), sign(negate_second));
		let (code, capture) = rejection(whole(&text, "coordinate.decimal_pair"));

		prop_assert_eq!(code, "latitude_out_of_range");
		prop_assert_eq!(capture.as_deref(), Some("first"));
	}

	#[test]
	fn a_longitude_out_of_range_beside_a_latitude_is_rejected_for_its_longitude(
		latitude in -90.0f64..=90.0,
		longitude in 180.001f64..5000.0,
		negate in any::<bool>(),
	) {
		let text = format!("{latitude:.4}, {}{longitude:.3}", if negate { "-" } else { "" });
		let (code, capture) = rejection(whole(&text, "coordinate.decimal_pair"));

		prop_assert_eq!(code, "longitude_out_of_range");
		prop_assert_eq!(capture.as_deref(), Some("second"));
	}

	#[test]
	fn a_pair_in_range_only_when_swapped_is_read_longitude_first(
		longitude in 90.001f64..=180.0,
		latitude in -90.0f64..=90.0,
	) {
		let text = format!("{longitude:.3}, {latitude:.3}");
		let value = payload(whole(&text, "coordinate.decimal_pair"));

		prop_assert_eq!(value["order"].as_str(), Some("lon_lat"));
		prop_assert_eq!(value["longitude"].as_f64(), format!("{longitude:.3}").parse::<f64>().ok());
	}

	#[test]
	fn an_in_range_geo_uri_is_validated(
		latitude in -90.0f64..=90.0,
		longitude in -180.0f64..=180.0,
		altitude in proptest::option::of(-9000.0f64..9000.0),
		uncertainty in proptest::option::of(0.0f64..1000.0),
		scheme in prop_oneof![Just("geo"), Just("GEO"), Just("Geo")],
		wgs84 in proptest::option::of(prop_oneof![Just("wgs84"), Just("WGS84"), Just("Wgs84")]),
	) {
		let mut text = format!("{scheme}:{latitude:.5},{longitude:.5}");

		if let Some(altitude) = altitude {
			text.push_str(&format!(",{altitude:.2}"));
		}

		if let Some(label) = wgs84 {
			text.push_str(&format!(";crs={label}"));
		}

		if let Some(uncertainty) = uncertainty {
			text.push_str(&format!(";u={uncertainty:.1}"));
		}

		let value = payload(whole(&text, "coordinate.geo_uri"));

		prop_assert_eq!(value["latitude"].as_f64(), format!("{latitude:.5}").parse::<f64>().ok());
		prop_assert_eq!(value.get("altitude").is_some(), altitude.is_some());
		prop_assert_eq!(value.get("uncertainty").is_some(), uncertainty.is_some());
	}

	#[test]
	fn a_geo_uri_out_of_range_or_in_another_system_is_rejected_with_its_reason(
		latitude in 90.001f64..9000.0,
		longitude in 180.001f64..9000.0,
		label in "[A-Za-z][A-Za-z0-9-]{0,12}",
	) {
		let (code, _) = rejection(whole(&format!("geo:{latitude:.3},0"), "coordinate.geo_uri"));

		prop_assert_eq!(code, "latitude_out_of_range");

		let (code, _) = rejection(whole(&format!("geo:0,{longitude:.3}"), "coordinate.geo_uri"));

		prop_assert_eq!(code, "longitude_out_of_range");

		if !label.eq_ignore_ascii_case("wgs84") {
			let (code, capture) = rejection(whole(&format!("geo:0,0;crs={label}"), "coordinate.geo_uri"));

			prop_assert_eq!(code, "unsupported_crs");
			prop_assert_eq!(capture.as_deref(), Some("crs"));
		}
	}

	#[test]
	fn adversarial_text_never_panics_and_never_splits_a_codepoint(
		text in proptest::collection::vec(
			prop_oneof![
				4 => proptest::char::range('0', '9'),
				3 => prop::sample::select(vec!['+', '-', '.', ',', ';', ' ', '\t', ':', '=', '%', 'e', 'E', 'g', 'o', 'u', 'c', 'r', 's']),
				// Non-ASCII digits, fullwidth forms, combining marks, CJK, astral symbols and the replacement character.
				2 => prop::sample::select(vec!['٣', '٤', '１', '２', '\u{0301}', '東', '京', '💥', '\u{fffd}', '\u{200d}', '\u{2212}', '〒']),
			],
			0..120,
		)
	) {
		let text: String = text.into_iter().collect();

		check_text(&text)?;
	}

	#[test]
	fn long_runs_of_digits_and_signs_never_panic(
		unit in prop::sample::select(vec!["9", "-", "+", ".", "0,", "1;", "-+", "geo:", ";u=", ",-"]),
		repeats in 1usize..600,
		tail in prop::sample::select(vec!["", ", 1", ",1", ";", "x"]),
	) {
		check_text(&format!("{}{tail}", unit.repeat(repeats)))?;
		check_text(&format!("1,{}{tail}", unit.repeat(repeats)))?;
		check_text(&format!("geo:1,{}{tail}", unit.repeat(repeats)))?;
	}
}

/// Searches, validates and traces `text`, and checks every span is a slice of it on codepoint boundaries.
fn check_text(text: &str) -> Result<(), TestCaseError> {
	let engine = engine();

	match engine.recognize(text) {
		Ok(recognitions) => {
			for recognition in &recognitions {
				let (start, end) = (recognition.candidate.start, recognition.candidate.end);

				prop_assert!(start < end && end <= text.len());
				prop_assert!(text.is_char_boundary(start) && text.is_char_boundary(end));
				prop_assert_eq!(recognition.text, &text[start..end]);
			}

			let traces = engine
				.trace(text, |_| true, &["coordinate.decimal_pair", "coordinate.geo_uri"])
				.unwrap();

			for trace in &traces {
				for span in trace
					.span
					.into_iter()
					.chain(trace.steps.iter().filter_map(|step| step.span))
				{
					prop_assert!(span.start <= span.end && span.end <= text.len());
					prop_assert!(text.is_char_boundary(span.start) && text.is_char_boundary(span.end));
				}
			}
		}
		// A text past a family's limit is refused with a typed error and not searched.
		Err(SearchError::InputTooLong { .. }) => {}
		Err(other) => prop_assert!(false, "unexpected search error: {other}"),
	}

	Ok(())
}
