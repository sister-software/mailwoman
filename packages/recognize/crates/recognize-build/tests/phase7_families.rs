// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The `coordinates` spellings beyond the decimal pair, the `spatial` family and the `identifiers` family through the
//! engine: each shape finds its text, reports the payload its validator builds, and finds nothing in an ordinary
//! address.

mod support;

use recognize_core::{Engine, ValidationResult};

use support::engine_for;

fn engine() -> Engine {
	engine_for(recognize_core::grammars::families())
}

/// The validation of the recognition of `shape` that covers `start..end`, or `None` when there is none.
fn validation(engine: &Engine, text: &str, shape: &str, start: usize, end: usize) -> Option<ValidationResult> {
	engine
		.recognize(text)
		.unwrap()
		.into_iter()
		.find(|recognition| {
			recognition.candidate.shape == shape
				&& recognition.candidate.start == start
				&& recognition.candidate.end == end
		})
		.map(|recognition| recognition.validation)
}

fn payload(engine: &Engine, text: &str, shape: &str) -> serde_json::Value {
	match validation(engine, text, shape, 0, text.len()) {
		Some(ValidationResult::Validated(payload)) => serde_json::to_value(payload).unwrap(),
		other => panic!("{shape} on {text:?}: {other:?}"),
	}
}

fn rejection(engine: &Engine, text: &str, shape: &str) -> &'static str {
	match validation(engine, text, shape, 0, text.len()) {
		Some(ValidationResult::Rejected(rejection)) => rejection.code,
		other => panic!("{shape} on {text:?}: {other:?}"),
	}
}

fn shapes(engine: &Engine, text: &str) -> Vec<String> {
	engine
		.recognize(text)
		.unwrap()
		.into_iter()
		.map(|recognition| recognition.candidate.shape.to_string())
		.collect()
}

#[test]
fn the_coordinate_spellings_read_to_one_payload() {
	let engine = engine();
	let paris = serde_json::json!({ "latitude": 48.8584, "longitude": 2.2945, "order": "lat_lon" });

	for (text, shape) in [
		("48.8584 2.2945", "coordinate.decimal_pair_spaced"),
		("48.8584N 2.2945E", "coordinate.dms_pair_spaced"),
		("48.8584N, 2.2945E", "coordinate.dms_pair"),
		("lat 48.8584 lon 2.2945", "coordinate.labeled_pair"),
		("@48.8584,2.2945,17z", "coordinate.maps_segment"),
	] {
		assert_eq!(payload(&engine, text, shape), paris, "{text}");
	}
}

#[test]
fn a_pair_with_a_decimal_point_is_a_whole_input_candidate_and_a_bare_pair_is_not() {
	let engine = engine();

	for text in [
		"12 34",
		"350 5th Ave",
		"Apt 4 12 Main St",
		"1200 N 400 W Salt Lake City",
	] {
		let found = shapes(&engine, text);

		assert!(
			!found.iter().any(|shape| shape == "coordinate.decimal_pair_spaced"),
			"{text}"
		);
	}

	assert!(shapes(&engine, "x 48.85 2.29")
		.iter()
		.all(|shape| shape != "coordinate.decimal_pair_spaced"));
}

#[test]
fn a_degree_pair_is_found_inside_a_longer_text_and_a_house_number_is_not() {
	let engine = engine();
	let text = "see 38°53'51.72\"N, 77°2'11.40\"W for the place";
	let start = text.find("38").unwrap();
	let end = text.find(" for").unwrap();

	assert!(matches!(
		validation(&engine, text, "coordinate.dms_pair", start, end),
		Some(ValidationResult::Validated(_))
	));

	// A Salt Lake City address is a candidate whose latitude is out of range, and the others are no candidate.
	assert_eq!(
		rejection(&engine, "1200 N, 400 W", "coordinate.dms_pair"),
		"latitude_out_of_range"
	);

	for address in ["350 5th Ave, New York, NY 10118", "Apt 4, 12 Main St"] {
		assert!(
			!shapes(&engine, address)
				.iter()
				.any(|shape| shape == "coordinate.dms_pair"),
			"{address}"
		);
	}
}

#[test]
fn a_labeled_pair_needs_a_word_boundary() {
	let engine = engine();

	assert!(shapes(&engine, "flat 5 lon 6")
		.iter()
		.all(|shape| shape != "coordinate.labeled_pair"));
	assert_eq!(
		rejection(&engine, "lat 1 lat 2", "coordinate.labeled_pair"),
		"same_axis_labels"
	);
}

#[test]
fn plus_codes_are_found_whole_and_embedded_and_odd_counts_are_rejected() {
	let engine = engine();

	assert_eq!(
		payload(&engine, "764mvfq6+92p", "plus_code.token"),
		serde_json::json!({ "code": "764MVFQ6+92P", "full": true })
	);
	assert_eq!(
		rejection(&engine, "VFQ+92P", "plus_code.token"),
		"invalid_prefix_length"
	);

	let text = "Managua, VFQ6+92P, Nicaragua";

	assert!(matches!(
		validation(&engine, text, "plus_code.token", 9, 17),
		Some(ValidationResult::Validated(_))
	));
	assert!(shapes(&engine, "X764MVFQ6+92P")
		.iter()
		.all(|shape| shape != "plus_code.token"));
}

#[test]
fn a_compact_digipin_is_whole_input_only_and_the_display_form_is_embedded() {
	let engine = engine();

	assert_eq!(
		payload(&engine, "39J49LL8T4", "digipin.compact"),
		serde_json::json!({ "code": "39J49LL8T4" })
	);
	assert!(shapes(&engine, "call 2345678923 now")
		.iter()
		.all(|shape| shape != "digipin.compact"));
	assert!(matches!(
		validation(&engine, "at 39J-49L-L8T4 now", "digipin.display", 3, 15),
		Some(ValidationResult::Validated(_))
	));
}

#[test]
fn a_geojson_text_is_parsed_and_a_near_miss_is_rejected_by_type() {
	let engine = engine();

	assert_eq!(
		payload(
			&engine,
			r#"{"type":"Point","coordinates":[2.2945,48.8584]}"#,
			"geojson.object"
		),
		serde_json::json!({ "type": "Point", "latitude": 48.8584, "longitude": 2.2945 })
	);
	assert_eq!(
		rejection(&engine, r#"{"type":"Point","coordinates":[2.2945,}"#, "geojson.object"),
		"malformed_json"
	);
	assert!(shapes(&engine, r#"{"type":"Circle"}"#)
		.iter()
		.all(|shape| shape != "geojson.object"));
	assert!(shapes(&engine, "just text")
		.iter()
		.all(|shape| shape != "geojson.object"));
}

#[test]
fn identifiers_read_with_their_prefix_and_a_bare_gnis_number_reads_as_none() {
	let engine = engine();

	assert_eq!(
		payload(&engine, "wof:85633793", "wof.reference"),
		serde_json::json!({ "id": 85_633_793 })
	);
	assert_eq!(
		payload(&engine, "gnis:1234567", "gnis.reference"),
		serde_json::json!({ "id": 1_234_567 })
	);
	assert_eq!(
		payload(&engine, "gh:EZS42", "geohash.prefixed"),
		serde_json::json!({ "hash": "ezs42" })
	);
	assert!(shapes(&engine, "1234567")
		.iter()
		.all(|shape| !shape.starts_with("gnis.")));
	assert!(shapes(&engine, "ezs42").iter().all(|shape| shape != "geohash.prefixed"));
}

#[test]
fn a_geoid_is_a_whole_input_candidate_with_a_checked_state() {
	let engine = engine();

	assert_eq!(
		payload(&engine, "06037", "census.geoid_county"),
		serde_json::json!({ "level": "county", "state": "06", "county": "037" })
	);
	assert_eq!(rejection(&engine, "99037", "census.geoid_county"), "unknown_state_fips");
	// Embedded, a run of five digits is a postcode and not a county.
	assert!(shapes(&engine, "Beverly Hills 90210")
		.iter()
		.all(|shape| !shape.starts_with("census.")));
}
