// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The validator of the `geojson.object` shape: a GeoJSON text parsed for real.
//!
//! A finite automaton cannot check the nesting of brackets, so the grammar holds only the cheap structural test: the
//! text is an object that mentions a `"type"` member with the name of a GeoJSON object. This validator parses the text
//! with `serde_json`, which the engine's binary links already for its result JSON, and reads it as RFC 7946 describes.
//!
//! # What is checked
//!
//! * The text is JSON, and its top-level value is an object. A parse that fails, including one that exceeds
//!   `serde_json`'s nesting limit of 128, is `malformed_json`.
//! * The `type` member is one of the nine case-sensitive strings of section 1.4: `Point`, `MultiPoint`, `LineString`,
//!   `MultiLineString`, `Polygon`, `MultiPolygon`, `GeometryCollection`, `Feature` and `FeatureCollection`. Any other
//!   value, or a value that is not a string, is `unknown_geojson_type`. A type where its parent cannot hold it, such as
//!   a `Feature` inside a `GeometryCollection`, is `misplaced_geojson_type`.
//! * A geometry of any type but `GeometryCollection` has a `coordinates` member (section 3.1), a `GeometryCollection`
//!   has `geometries` (section 3.1.8), a `Feature` has `geometry`, which may be `null` (section 3.2), and a
//!   `FeatureCollection` has `features` (section 3.3). A missing one is `missing_member`.
//! * Every position is an array of two or more numbers, longitude first, with an optional altitude third (section
//!   3.1.1). A position that is not is `malformed_position`, and one out of range is `longitude_out_of_range` or
//!   `latitude_out_of_range`. Nothing is clamped or wrapped.
//!
//! The coordinate reference system is WGS 84 by section 4, so the ranges are the globe's. The `bbox` member and the
//! `properties` and `id` of a feature are not read.
//!
//! # Precision
//!
//! `serde_json` reads a number with its default algorithm, which is exact for a number of 15 significant digits or
//! fewer and may differ in the last bit from the nearest `f64` for a longer one. Its `float_roundtrip` feature makes
//! every number exact, and measured 43,616 bytes in the engine binary, so it is not enabled.
//!
//! # Limit
//!
//! The text is at most the family's input limit, 65,536 bytes, because the engine refuses a longer text before it
//! searches. A document past that limit is refused by the engine as `InputTooLong`, whatever its content.
//!
//! # Payload
//!
//! The payload holds the top-level `type`. For a `Point` it also holds the validated position: `latitude`, `longitude`
//! and the `altitude` when the position has a third element.

use serde::Serialize;
use serde_json::Value;

use crate::captures::Captures;
use crate::recognition::Rejection;
use crate::validators::{Decimal, FieldType, Latitude, Longitude, PayloadField, Validator};

/// The nine GeoJSON object types of RFC 7946 section 1.4.
const TYPES: [&str; 9] = [
	"Feature",
	"FeatureCollection",
	"GeometryCollection",
	"LineString",
	"MultiLineString",
	"MultiPoint",
	"MultiPolygon",
	"Point",
	"Polygon",
];

/// What a GeoJSON text is: its top-level type and, for a point, where it is.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GeoJSONObject {
	#[serde(rename = "type")]
	pub kind: &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub latitude: Option<Latitude>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub longitude: Option<Longitude>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub altitude: Option<Decimal>,
}

/// A position read from an array of numbers.
struct Position {
	latitude: Latitude,
	longitude: Longitude,
	altitude: Option<Decimal>,
}

fn refuse(code: &'static str, message: impl Into<String>) -> Rejection {
	Rejection::new(code, None, message)
}

fn position(value: &Value) -> Result<Position, Rejection> {
	let Some(numbers) = value.as_array().filter(|numbers| numbers.len() >= 2) else {
		return Err(refuse(
			"malformed_position",
			"a position is an array of two or more numbers",
		));
	};
	let number = |index: usize| {
		numbers[index].as_f64().ok_or_else(|| {
			refuse(
				"malformed_position",
				format!("element {index} of a position is not a number"),
			)
		})
	};
	let (longitude, latitude) = (number(0)?, number(1)?);

	Ok(Position {
		longitude: Longitude::new(longitude)?,
		latitude: Latitude::new(latitude)?,
		altitude: match numbers.get(2) {
			Some(_) => Some(Decimal::new(number(2)?)?),
			None => None,
		},
	})
}

/// Reads an array whose elements are read by `each`, `depth` levels of arrays deep.
fn nested(value: &Value, depth: usize) -> Result<(), Rejection> {
	if depth == 0 {
		return position(value).map(|_| ());
	}

	let Some(items) = value.as_array() else {
		return Err(refuse(
			"malformed_position",
			"coordinates are nested arrays of positions",
		));
	};

	items.iter().try_for_each(|item| nested(item, depth - 1))
}

fn member<'a>(object: &'a serde_json::Map<String, Value>, name: &str) -> Result<&'a Value, Rejection> {
	object
		.get(name)
		.ok_or_else(|| refuse("missing_member", format!("the object has no `{name}` member")))
}

/// The type of an object, as one of [`TYPES`].
fn type_of(object: &serde_json::Map<String, Value>) -> Result<&'static str, Rejection> {
	let value = member(object, "type")?;

	value
		.as_str()
		.and_then(|text| TYPES.iter().copied().find(|known| *known == text))
		.ok_or_else(|| refuse("unknown_geojson_type", format!("`{value}` is not a GeoJSON type")))
}

/// How the object a parent holds may be typed.
#[derive(Clone, Copy, PartialEq)]
enum Expected {
	Any,
	Geometry,
	Feature,
}

fn check(value: &Value, expected: Expected) -> Result<&'static str, Rejection> {
	let Some(object) = value.as_object() else {
		return Err(refuse("unknown_geojson_type", "a GeoJSON object is a JSON object"));
	};
	let kind = type_of(object)?;
	let is_geometry = !matches!(kind, "Feature" | "FeatureCollection");

	if (expected == Expected::Geometry && !is_geometry) || (expected == Expected::Feature && kind != "Feature") {
		return Err(refuse(
			"misplaced_geojson_type",
			format!("a `{kind}` cannot appear here"),
		));
	}

	match kind {
		"Point" => nested(member(object, "coordinates")?, 0)?,
		"MultiPoint" | "LineString" => nested(member(object, "coordinates")?, 1)?,
		"MultiLineString" | "Polygon" => nested(member(object, "coordinates")?, 2)?,
		"MultiPolygon" => nested(member(object, "coordinates")?, 3)?,
		"GeometryCollection" => {
			for geometry in array(member(object, "geometries")?, "geometries")? {
				check(geometry, Expected::Geometry)?;
			}
		}
		"Feature" => {
			let geometry = member(object, "geometry")?;

			if !geometry.is_null() {
				check(geometry, Expected::Geometry)?;
			}
		}
		_ => {
			for feature in array(member(object, "features")?, "features")? {
				check(feature, Expected::Feature)?;
			}
		}
	}

	Ok(kind)
}

fn array<'a>(value: &'a Value, name: &str) -> Result<&'a Vec<Value>, Rejection> {
	value
		.as_array()
		.ok_or_else(|| refuse("missing_member", format!("`{name}` is not an array")))
}

/// `GeoJSON`: the whole text parses as a GeoJSON object of RFC 7946.
pub struct GeoJSON;

impl Validator for GeoJSON {
	type Output = GeoJSONObject;

	const ID: &'static str = "GeoJSON";

	const PAYLOAD: &'static [PayloadField] = &[
		PayloadField {
			name: "type",
			kind: FieldType::Text,
			optional: false,
		},
		PayloadField {
			name: "latitude",
			kind: FieldType::Latitude,
			optional: true,
		},
		PayloadField {
			name: "longitude",
			kind: FieldType::Longitude,
			optional: true,
		},
		PayloadField {
			name: "altitude",
			kind: FieldType::Decimal,
			optional: true,
		},
	];

	const REJECTIONS: &'static [&'static str] = &[
		"latitude_out_of_range",
		"longitude_out_of_range",
		"malformed_json",
		"malformed_position",
		"misplaced_geojson_type",
		"missing_member",
		"not_finite",
		"unknown_geojson_type",
	];

	fn validate(captures: &Captures<'_>) -> Result<GeoJSONObject, Rejection> {
		let value: Value = serde_json::from_str(captures.span())
			.map_err(|error| refuse("malformed_json", format!("the text is not JSON: {error}")))?;
		let kind = check(&value, Expected::Any)?;
		let point = match kind {
			"Point" => value.get("coordinates").map(position).transpose()?,
			_ => None,
		};

		Ok(GeoJSONObject {
			kind,
			latitude: point.as_ref().map(|point| point.latitude),
			longitude: point.as_ref().map(|point| point.longitude),
			altitude: point.and_then(|point| point.altitude),
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn read(text: &str) -> Result<GeoJSONObject, Rejection> {
		GeoJSON::validate(&Captures::of_span(text))
	}

	fn code(text: &str) -> &'static str {
		read(text).unwrap_err().code
	}

	#[test]
	fn a_point_carries_its_validated_position() {
		let point = read(r#"{"type":"Point","coordinates":[2.2945,48.8584,35]}"#).unwrap();

		assert_eq!(point.kind, "Point");
		assert_eq!(point.latitude.unwrap().get(), 48.8584);
		assert_eq!(point.longitude.unwrap().get(), 2.2945);
		assert_eq!(point.altitude.unwrap().get(), 35.0);
		assert_eq!(
			serde_json::to_string(&read(r#"{"type":"Point","coordinates":[1,2]}"#).unwrap()).unwrap(),
			r#"{"type":"Point","latitude":2.0,"longitude":1.0}"#
		);
	}

	#[test]
	fn every_type_reads_and_only_a_point_carries_a_position() {
		for text in [
			r#"{"type":"MultiPoint","coordinates":[[1,2],[3,4]]}"#,
			r#"{"type":"LineString","coordinates":[[1,2],[3,4]]}"#,
			r#"{"type":"MultiLineString","coordinates":[[[1,2],[3,4]]]}"#,
			r#"{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}"#,
			r#"{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,0]]]]}"#,
			r#"{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[1,2]}]}"#,
			r#"{"type":"Feature","geometry":null,"properties":{}}"#,
			r#"{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]}}]}"#,
		] {
			let object = read(text).unwrap();

			assert!(object.latitude.is_none() && object.longitude.is_none(), "{text}");
		}
	}

	#[test]
	fn a_rejection_names_what_is_wrong() {
		assert_eq!(code(r#"{"type":"Point","coordinates":[1,2"#), "malformed_json");
		assert_eq!(code(r#"{"type":"Circle","coordinates":[1,2]}"#), "unknown_geojson_type");
		assert_eq!(code(r#"{"type":"point","coordinates":[1,2]}"#), "unknown_geojson_type");
		assert_eq!(code(r#"{"type":3}"#), "unknown_geojson_type");
		assert_eq!(code(r#"{"type":"Point"}"#), "missing_member");
		assert_eq!(code(r#"{"coordinates":[1,2]}"#), "missing_member");
		assert_eq!(code(r#"{"type":"Point","coordinates":[1]}"#), "malformed_position");
		assert_eq!(code(r#"{"type":"Point","coordinates":["1",2]}"#), "malformed_position");
		assert_eq!(
			code(r#"{"type":"Point","coordinates":[181,2]}"#),
			"longitude_out_of_range"
		);
		assert_eq!(
			code(r#"{"type":"Point","coordinates":[1,91]}"#),
			"latitude_out_of_range"
		);
		assert_eq!(
			code(r#"{"type":"LineString","coordinates":[[1,2],[3,95]]}"#),
			"latitude_out_of_range"
		);
		assert_eq!(
			code(r#"{"type":"LineString","coordinates":[1,2]}"#),
			"malformed_position"
		);
		assert_eq!(
			code(r#"{"type":"GeometryCollection","geometries":[{"type":"Feature","geometry":null}]}"#),
			"misplaced_geojson_type"
		);
		assert_eq!(
			code(r#"{"type":"FeatureCollection","features":[{"type":"Point","coordinates":[1,2]}]}"#),
			"misplaced_geojson_type"
		);
		assert_eq!(code("[1,2]"), "unknown_geojson_type");
	}

	#[test]
	fn nesting_past_the_parser_limit_is_malformed_json() {
		let deep = format!(
			r#"{{"type":"Feature","geometry":null,"properties":{{"a":{}{}}}}}"#,
			"[".repeat(200),
			"]".repeat(200)
		);

		assert_eq!(code(&deep), "malformed_json");
	}
}
