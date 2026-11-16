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
//! only way to hold a [`Latitude`] is to build one inside the range of latitudes, and no constructor takes an unchecked
//! value.
//!
//! # The schema of a validator
//!
//! A payload is what the validator builds, and it need not mirror the captures it read: the decimal pair reads two
//! captures and builds a latitude, a longitude and the axis order it chose. Each validator therefore declares the
//! fields and types of its payload and the codes of the rejections it returns ([`schema`]). The generator writes the
//! TypeScript payload and rejection types from that declaration, and a test per validator holds that what the
//! validator returns matches it.
//!
//! # The axis order rule
//!
//! A decimal pair is read in the order it was written, latitude first. When that reading fails a range and the other
//! order puts both numbers in range, the pair is read longitude first and the payload's `order` says so. A pair in range
//! in both orders is latitude first. The two names are `lat_lon` and `lon_lat`. A `geo:` URI never swaps,
//! because RFC 5870 fixes the order as latitude, longitude, altitude.

use std::fmt::Debug;

use serde::Serialize;

use crate::captures::Captures;
use crate::recognition::Rejection;

mod angles;
mod geojson;
mod identifiers;
mod spatial;
mod us_state_fips;

pub use angles::{AnglePair, LabeledPair, MapsSegment, SpacedPair};
pub use geojson::{GeoJSON, GeoJSONObject};
pub use identifiers::{
	CensusGEOID, CensusParts, GNISFeatureID, GNISIdentifier, Geohash, GeohashText, H3Cell, H3Index, WOFIdentifier,
	WhosOnFirstID,
};
pub use spatial::{DigipinValue, PlusCode, PlusCodeValue, DIGIPIN};
/// A validator bound to one `ValidatorID`.
pub trait Validator {
	/// The typed payload a validated span carries.
	type Output: Clone + Debug + PartialEq + Serialize;

	/// The `ValidatorID` text this type answers to. The generated declarations check it against the ID the grammar
	/// names, so a type under the wrong name fails the build.
	const ID: &'static str;

	/// The fields of the payload, which the generated TypeScript declares.
	const PAYLOAD: &'static [PayloadField];

	/// The codes of every rejection the validator returns. The engine's own codes ([`ENGINE_REJECTIONS`]) are not
	/// listed.
	const REJECTIONS: &'static [&'static str];

	/// Validates the captures of one accepted span and builds the payload.
	fn validate(captures: &Captures<'_>) -> Result<Self::Output, Rejection>;
}

/// The type of one payload field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
	Text,
	Integer,
	Decimal,
	Latitude,
	Longitude,
	Uncertainty,
	/// A full Open Location Code in upper case, validated by `PlusCode`.
	FullPlusCode,
	/// A short Open Location Code in upper case, validated by `PlusCode`.
	ShortPlusCode,
	/// A DIGIPIN as ten upper-case characters, validated by `DIGIPIN`.
	Digipin,
	AxisOrder,
	Boolean,
}

/// One field of a validator's payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct PayloadField {
	pub name: &'static str,
	#[serde(rename = "type")]
	pub kind: FieldType,
	/// Whether the key is absent from the serialized payload when the value is.
	pub optional: bool,
}

/// What a validator declares about its payload and its rejections.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Schema {
	pub payload: &'static [PayloadField],
	pub rejections: &'static [&'static str],
}

/// The rejection codes the engine returns for any validated shape, whatever its validator: the capture walk passed
/// its limit, or no parse of the program consumes a span its automaton accepted.
pub const ENGINE_REJECTIONS: &[&str] = &["capture_limit", "capture_mismatch"];

fn schema_of<V: Validator>() -> Schema {
	Schema {
		payload: V::PAYLOAD,
		rejections: V::REJECTIONS,
	}
}

/// The schema of the validator named `id`, or `None` when no validator answers to it.
pub fn schema(id: &str) -> Option<Schema> {
	match id {
		WGS84Pair::ID => Some(schema_of::<WGS84Pair>()),
		GeoURI::ID => Some(schema_of::<GeoURI>()),
		AnglePair::ID => Some(schema_of::<AnglePair>()),
		LabeledPair::ID => Some(schema_of::<LabeledPair>()),
		MapsSegment::ID => Some(schema_of::<MapsSegment>()),
		SpacedPair::ID => Some(schema_of::<SpacedPair>()),
		PlusCode::ID => Some(schema_of::<PlusCode>()),
		DIGIPIN::ID => Some(schema_of::<DIGIPIN>()),
		GeoJSON::ID => Some(schema_of::<GeoJSON>()),
		H3Cell::ID => Some(schema_of::<H3Cell>()),
		Geohash::ID => Some(schema_of::<Geohash>()),
		WhosOnFirstID::ID => Some(schema_of::<WhosOnFirstID>()),
		CensusGEOID::ID => Some(schema_of::<CensusGEOID>()),
		GNISFeatureID::ID => Some(schema_of::<GNISFeatureID>()),
		_ => None,
	}
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

/// A latitude in WGS84 degrees: finite, from -90 to 90 inclusive, both poles included.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Latitude(f64);

impl Latitude {
	/// Wraps `value` when it is a latitude.
	pub fn new(value: f64) -> Result<Self, Rejection> {
		Decimal::new(value)?;

		if (-90.0..=90.0).contains(&value) {
			Ok(Latitude(value))
		} else {
			Err(Rejection::new(
				"latitude_out_of_range",
				None,
				format!("{value} is outside the latitudes -90 to 90"),
			))
		}
	}

	pub fn get(self) -> f64 {
		self.0
	}
}

/// A longitude in WGS84 degrees: finite, from -180 to 180 inclusive, the antimeridian included on both sides.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Longitude(f64);

impl Longitude {
	/// Wraps `value` when it is a longitude.
	pub fn new(value: f64) -> Result<Self, Rejection> {
		Decimal::new(value)?;

		if (-180.0..=180.0).contains(&value) {
			Ok(Longitude(value))
		} else {
			Err(Rejection::new(
				"longitude_out_of_range",
				None,
				format!("{value} is outside the longitudes -180 to 180"),
			))
		}
	}

	pub fn get(self) -> f64 {
		self.0
	}
}

/// An uncertainty in meters: finite and not negative. Zero is a specific point, and RFC 5870 keeps it distinct from an
/// absent uncertainty.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Uncertainty(f64);

impl Uncertainty {
	/// Wraps `value` when it is an uncertainty.
	pub fn new(value: f64) -> Result<Self, Rejection> {
		Decimal::new(value)?;

		if value >= 0.0 {
			Ok(Uncertainty(value))
		} else {
			Err(Rejection::new(
				"negative_uncertainty",
				None,
				format!("{value} is a negative uncertainty"),
			))
		}
	}

	pub fn get(self) -> f64 {
		self.0
	}
}

/// The order a decimal pair was read in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AxisOrder {
	/// Latitude first, the order people write.
	LatLon,
	/// Longitude first, chosen only when the first number is not a latitude and the second is not a longitude.
	LonLat,
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

/// Names the capture a rejection is about.
pub(crate) fn about(path: &str) -> impl FnOnce(Rejection) -> Rejection + '_ {
	move |mut rejection| {
		rejection.capture = Some(path.to_string());
		rejection
	}
}

/// Reads a required capture as a [`Decimal`], naming the capture in a rejection.
pub fn decimal(captures: &Captures<'_>, path: &str) -> Result<Decimal, Rejection> {
	Decimal::parse(required(captures, path)?).map_err(about(path))
}

/// Reads a required capture as an [`Integer`], naming the capture in a rejection.
pub fn integer(captures: &Captures<'_>, path: &str) -> Result<Integer, Rejection> {
	Integer::parse(required(captures, path)?).map_err(about(path))
}

/// A decimal pair as a point: the latitude, the longitude, and the order the text was read in.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PairPoint {
	pub latitude: Latitude,
	pub longitude: Longitude,
	pub order: AxisOrder,
}

/// `WGS84Pair`: the `first` and `second` captures are a point on the globe, read latitude first or, when only that
/// order is in range, longitude first. See the module documentation for the rule.
///
/// A pair out of range in both orders is rejected for the first axis of the latitude-first reading that fails.
pub struct WGS84Pair;

impl Validator for WGS84Pair {
	type Output = PairPoint;

	const ID: &'static str = "WGS84Pair";

	const PAYLOAD: &'static [PayloadField] = &[
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

	const REJECTIONS: &'static [&'static str] = &[
		"latitude_out_of_range",
		"longitude_out_of_range",
		"missing_capture",
		"not_a_decimal",
		"not_finite",
	];

	fn validate(captures: &Captures<'_>) -> Result<PairPoint, Rejection> {
		read_pair(decimal(captures, "first")?.get(), decimal(captures, "second")?.get())
	}
}

/// Reads two numbers written in this order as a point, by the axis order rule of the module documentation.
pub(crate) fn read_pair(first: f64, second: f64) -> Result<PairPoint, Rejection> {
	match (Latitude::new(first), Longitude::new(second)) {
		(Ok(latitude), Ok(longitude)) => Ok(PairPoint {
			latitude,
			longitude,
			order: AxisOrder::LatLon,
		}),
		(latitude, longitude) => match (Latitude::new(second), Longitude::new(first)) {
			(Ok(latitude), Ok(longitude)) => Ok(PairPoint {
				latitude,
				longitude,
				order: AxisOrder::LonLat,
			}),
			_ => Err(match (latitude, longitude) {
				(Err(rejection), _) => about("first")(rejection),
				(_, Err(rejection)) => about("second")(rejection),
				(Ok(_), Ok(_)) => unreachable!("the first reading was in range"),
			}),
		},
	}
}

/// A `geo:` URI as a point: latitude and longitude, an optional altitude in meters and an optional uncertainty in
/// meters. The coordinate reference system is always WGS84, because any other is rejected.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GeoPoint {
	pub latitude: Latitude,
	pub longitude: Longitude,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub altitude: Option<Decimal>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub uncertainty: Option<Uncertainty>,
}

/// `GeoURI`: RFC 5870's WGS84 point. The `crs` parameter must be absent or `wgs84` in any letter case, the coordinates
/// must lie inside the latitudes and longitudes, and `crs` and `u` may appear only first and once.
///
/// Unknown parameters are valid syntax and are ignored. Longitude at a pole is not constrained beyond its range, as
/// section 3.4.2 requires.
pub struct GeoURI;

impl Validator for GeoURI {
	type Output = GeoPoint;

	const ID: &'static str = "GeoURI";

	const PAYLOAD: &'static [PayloadField] = &[
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
			name: "altitude",
			kind: FieldType::Decimal,
			optional: true,
		},
		PayloadField {
			name: "uncertainty",
			kind: FieldType::Uncertainty,
			optional: true,
		},
	];

	const REJECTIONS: &'static [&'static str] = &[
		"latitude_out_of_range",
		"longitude_out_of_range",
		"misplaced_parameter",
		"missing_capture",
		"negative_uncertainty",
		"not_a_decimal",
		"not_finite",
		"unsupported_crs",
	];

	fn validate(captures: &Captures<'_>) -> Result<GeoPoint, Rejection> {
		if let Some(crs) = captures.get("crs") {
			if !crs.eq_ignore_ascii_case("wgs84") {
				return Err(Rejection::new(
					"unsupported_crs",
					Some("crs"),
					format!("the coordinate reference system `{crs}` is not WGS84"),
				));
			}
		}

		// `crs` and `u` are read at their places in the grammar. A later parameter of either name is a repeat or sits
		// after another parameter, and RFC 5870 section 3.3 forbids both.
		if let Some(parameters) = captures.get("parameters") {
			for parameter in parameters.split(';').filter(|parameter| !parameter.is_empty()) {
				let name = parameter.split('=').next().unwrap_or(parameter);

				if name.eq_ignore_ascii_case("crs") || name.eq_ignore_ascii_case("u") {
					return Err(Rejection::new(
						"misplaced_parameter",
						Some("parameters"),
						format!("the parameter `{name}` repeats or follows another parameter"),
					));
				}
			}
		}

		let latitude = Latitude::new(decimal(captures, "latitude")?.get()).map_err(about("latitude"))?;
		let longitude = Longitude::new(decimal(captures, "longitude")?.get()).map_err(about("longitude"))?;
		let altitude = captures
			.get("altitude")
			.map(|text| Decimal::parse(text).map_err(about("altitude")))
			.transpose()?;
		let uncertainty = captures
			.get("uncertainty")
			.map(|text| {
				Decimal::parse(text)
					.and_then(|value| Uncertainty::new(value.get()))
					.map_err(about("uncertainty"))
			})
			.transpose()?;

		Ok(GeoPoint {
			latitude,
			longitude,
			altitude,
			uncertainty,
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::captures::{extract, CaptureProgram, ProgramShape};
	use crate::grammars::coordinates;

	/// The program of the coordinates family, built from its AST. It holds no pattern, so no lowering is needed.
	fn program() -> &'static CaptureProgram {
		let document = coordinates::family().build().unwrap();
		let mut program = CaptureProgram::default();

		for term in &document.terms {
			program.terms.insert(term.id.clone(), term.grammar.clone());
			program.term_sources.insert(term.id.clone(), term.source.clone());
		}

		for shape in &document.shapes {
			program.shapes.insert(
				shape.id.clone(),
				ProgramShape {
					captures: shape.captures.clone(),
					node: shape.grammar.clone(),
					validator: shape.validator.as_ref().map(|id| id.as_str().to_string()),
					source: shape.source.clone(),
				},
			);
		}

		Box::leak(Box::new(program))
	}

	fn captures_of<'a>(shape: &str, text: &'a str) -> Captures<'a> {
		extract(program(), shape, text, 0, text.len()).unwrap()
	}

	fn pair(text: &str) -> Result<PairPoint, Rejection> {
		WGS84Pair::validate(&captures_of("coordinate.decimal_pair", text))
	}

	fn geo(text: &str) -> Result<GeoPoint, Rejection> {
		GeoURI::validate(&captures_of("coordinate.geo_uri", text))
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
	fn latitudes_and_longitudes_validate_on_construction() {
		assert!(Latitude::new(90.0).is_ok() && Latitude::new(-90.0).is_ok());
		assert_eq!(Latitude::new(90.000001).unwrap_err().code, "latitude_out_of_range");
		assert_eq!(Latitude::new(f64::NAN).unwrap_err().code, "not_finite");
		assert!(Longitude::new(180.0).is_ok() && Longitude::new(-180.0).is_ok());
		assert_eq!(Longitude::new(-180.5).unwrap_err().code, "longitude_out_of_range");
		assert_eq!(Longitude::new(f64::INFINITY).unwrap_err().code, "not_finite");
		assert!(Uncertainty::new(0.0).is_ok());
		assert_eq!(Uncertainty::new(-1.0).unwrap_err().code, "negative_uncertainty");
	}

	#[test]
	fn a_pair_in_range_is_latitude_first() {
		let point = pair("40.7128, -74.0060").unwrap();

		assert_eq!(point.latitude.get(), 40.7128);
		assert_eq!(point.longitude.get(), -74.006);
		assert_eq!(point.order, AxisOrder::LatLon);
		assert_eq!(
			serde_json::to_string(&point).unwrap(),
			r#"{"latitude":40.7128,"longitude":-74.006,"order":"lat_lon"}"#
		);
		// In range in both orders, the written order wins.
		assert_eq!(pair("45, 90").unwrap().order, AxisOrder::LatLon);
	}

	#[test]
	fn a_pair_in_range_only_when_swapped_is_longitude_first() {
		let point = pair("100.5, 40.7128").unwrap();

		assert_eq!(point.latitude.get(), 40.7128);
		assert_eq!(point.longitude.get(), 100.5);
		assert_eq!(point.order, AxisOrder::LonLat);
		// `-74.006, 40.7128` is in range as written, so it is read as written.
		assert_eq!(pair("-74.006, 40.7128").unwrap().order, AxisOrder::LatLon);
	}

	#[test]
	fn a_pair_out_of_range_in_both_orders_names_the_first_failing_axis() {
		let rejection = pair("100, 200").unwrap_err();

		assert_eq!(rejection.code, "latitude_out_of_range");
		assert_eq!(rejection.capture.as_deref(), Some("first"));

		let rejection = pair("45, 200").unwrap_err();

		assert_eq!(rejection.code, "longitude_out_of_range");
		assert_eq!(rejection.capture.as_deref(), Some("second"));
	}

	#[test]
	fn a_pair_names_the_capture_it_cannot_read() {
		let rejection = pair(&format!("{}, 1", "9".repeat(400))).unwrap_err();

		assert_eq!(rejection.code, "not_finite");
		assert_eq!(rejection.capture.as_deref(), Some("first"));
	}

	#[test]
	fn a_geo_uri_reads_its_point_altitude_and_uncertainty() {
		let point = geo("geo:48.2010,16.3695,183;crs=wgs84;u=40;unknown=1").unwrap();

		assert_eq!(point.latitude.get(), 48.201);
		assert_eq!(point.longitude.get(), 16.3695);
		assert_eq!(point.altitude.unwrap().get(), 183.0);
		assert_eq!(point.uncertainty.unwrap().get(), 40.0);
		assert_eq!(
			serde_json::to_string(&geo("GEO:-90,180").unwrap()).unwrap(),
			r#"{"latitude":-90.0,"longitude":180.0}"#
		);
		assert_eq!(geo("geo:0,0;u=0").unwrap().uncertainty.unwrap().get(), 0.0);
	}

	#[test]
	fn a_geo_uri_with_another_crs_is_a_typed_rejection() {
		let rejection = geo("geo:48.2,16.3;crs=Moon-2011").unwrap_err();

		assert_eq!(rejection.code, "unsupported_crs");
		assert_eq!(rejection.capture.as_deref(), Some("crs"));
		assert!(geo("geo:48.2,16.3;crs=WGS84").is_ok());
	}

	#[test]
	fn a_geo_uri_out_of_range_is_a_typed_rejection_and_never_swapped() {
		let rejection = geo("geo:94,0").unwrap_err();

		assert_eq!(rejection.code, "latitude_out_of_range");
		assert_eq!(rejection.capture.as_deref(), Some("latitude"));
		assert_eq!(geo("geo:0,-180.1").unwrap_err().code, "longitude_out_of_range");
		// The swapped reading would be in range, and a URI's order is fixed.
		assert_eq!(geo("geo:100.5,40.7128").unwrap_err().code, "latitude_out_of_range");
	}

	#[test]
	fn a_repeated_or_late_crs_or_uncertainty_is_a_typed_rejection() {
		for text in [
			"geo:1,2;x=1;crs=wgs84",
			"geo:1,2;u=1;u=2",
			"geo:1,2;crs=wgs84;crs=wgs84",
			"geo:1,2;x=1;U=1",
		] {
			assert_eq!(geo(text).unwrap_err().code, "misplaced_parameter", "{text}");
		}
	}

	#[test]
	fn every_declared_rejection_code_is_the_only_kind_a_validator_returns() {
		for (shape, text, schema) in [
			("coordinate.decimal_pair", "100, 200", schema("WGS84Pair").unwrap()),
			("coordinate.decimal_pair", "1, 2", schema("WGS84Pair").unwrap()),
			("coordinate.geo_uri", "geo:1,2;crs=x", schema("GeoURI").unwrap()),
			("coordinate.geo_uri", "geo:95,2", schema("GeoURI").unwrap()),
		] {
			let rejection = match shape {
				"coordinate.decimal_pair" => pair(text).err(),
				_ => geo(text).err(),
			};

			if let Some(rejection) = rejection {
				assert!(schema.rejections.contains(&rejection.code), "{}", rejection.code);
			}
		}
	}

	#[test]
	fn a_payload_serializes_the_keys_its_schema_declares() {
		let value = serde_json::to_value(geo("geo:1,2,3;u=4").unwrap()).unwrap();
		let keys: Vec<&str> = schema("GeoURI")
			.unwrap()
			.payload
			.iter()
			.map(|field| field.name)
			.collect();

		assert_eq!(value.as_object().unwrap().len(), keys.len());

		for key in keys {
			assert!(value.get(key).is_some(), "{key}");
		}

		// An optional field's key is absent when its value is.
		let value = serde_json::to_value(geo("geo:1,2").unwrap()).unwrap();

		assert!(value.get("altitude").is_none() && value.get("uncertainty").is_none());

		let value = serde_json::to_value(pair("1, 2").unwrap()).unwrap();

		assert_eq!(
			value.as_object().unwrap().len(),
			schema("WGS84Pair").unwrap().payload.len()
		);
	}

	#[test]
	fn a_missing_capture_is_a_rejection_and_not_a_default() {
		let rejection = WGS84Pair::validate(&Captures::of_span("1,2")).unwrap_err();

		assert_eq!(rejection.code, "missing_capture");
		assert_eq!(rejection.capture.as_deref(), Some("first"));
	}

	#[test]
	fn an_unknown_validator_has_no_schema() {
		assert!(schema("NoSuchValidator").is_none());
	}
}
