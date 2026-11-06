// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from the basemaps fork's layers/Buildings.java (BSD-3-Clause, Protomaps).

//! The `buildings` layer: building and building-part footprints with rounded corners and heights, from OpenStreetMap or
//! from Overture's buildings theme, and OpenStreetMap address points at zoom 15. Footprints merge into blocks at zooms
//! 11 and 12.
//!
//! [`Footprints`] decides where footprints come from. With Overture footprints, OpenStreetMap building polygons are
//! skipped, so a building is drawn once.

use hrt_e::Value;
use hrt_render::geom::java_round;
use hrt_render::java_math;
use hrt_render::snap::SnapCounts;
use hrt_render::Geom;

use crate::merge::merge_nearby_polygons;
use crate::parse::{parse_double_or_null, parse_int_or_null};
use crate::smoothing::round_world_polygon;
use crate::{feature_id, Builder, Collector, CollectorConfig, Emitted, Input, TileFeature};

pub const LAYER_NAME: &str = "buildings";

const HEIGHT_KEY: &str = "height";
const MIN_HEIGHT_KEY: &str = "min_height";
/// The corner radius of a footprint, in meters; rounded corners give extruded walls a soft vertical edge.
const CORNER_METERS: f64 = 1.2;
const CORNER_PASSES: usize = 2;

/// The landmarks Earth draws from a model, `packages/structures/data/landmarks.json`. A footprint whose centroid lies
/// within a landmark's `suppressRadius` of its `anchor` is left out, so its extruded prisms do not show through the
/// model. Earth's `landmarkCovering` applies the same test.
const LANDMARKS_JSON: &str = include_str!("../../../../../structures/data/landmarks.json");

/// The largest suppression radius in meters the bounding-box shortcut in [`is_modeled_landmark`] allows.
const MAX_SUPPRESS_RADIUS: f64 = 250.0;

/// Each landmark's anchor longitude, latitude and suppression radius in meters.
///
/// # Panics
///
/// When the landmark list is not a JSON array of objects with a two-number `anchor` and a `suppressRadius` between 0
/// and [`MAX_SUPPRESS_RADIUS`]. The list is compiled in, so a malformed list fails every build that reads it.
fn parse_landmarks(json: &str) -> Vec<[f64; 3]> {
	let landmarks: serde_json::Value = serde_json::from_str(json).expect("the landmark list is JSON");
	let landmarks = landmarks.as_array().expect("the landmark list is an array");
	landmarks
		.iter()
		.map(|landmark| {
			let id = landmark["id"].as_str().unwrap_or("?");
			let anchor = landmark["anchor"].as_array().filter(|anchor| anchor.len() == 2);
			let lon = anchor.and_then(|anchor| anchor[0].as_f64());
			let lat = anchor.and_then(|anchor| anchor[1].as_f64());
			let radius = landmark["suppressRadius"].as_f64();
			match (lon, lat, radius) {
				(Some(lon), Some(lat), Some(radius)) if radius > 0.0 && radius <= MAX_SUPPRESS_RADIUS => {
					[lon, lat, radius]
				}
				_ => panic!("landmark {id} needs a [longitude, latitude] anchor and a suppressRadius in (0, 250]"),
			}
		})
		.collect()
}

fn modeled_landmarks() -> &'static [[f64; 3]] {
	static LANDMARKS: std::sync::OnceLock<Vec<[f64; 3]>> = std::sync::OnceLock::new();
	LANDMARKS.get_or_init(|| parse_landmarks(LANDMARKS_JSON))
}

/// Java's `\s`: the six ASCII whitespace characters.
fn is_java_space(c: char) -> bool {
	matches!(c, ' ' | '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r')
}

/// The fork's `sanitizeHeightValue`: the first comma followed by one or two digits and an optional unit at the end of
/// the text becomes a decimal point, as in `89,10` or `89,1 m`. Other commas, such as `1,000`, stay.
fn sanitize_height(value: &str) -> String {
	let unit_tail = |rest: &str| {
		let digits = rest.chars().take_while(char::is_ascii_digit).count();
		if !(1..=2).contains(&digits) {
			return false;
		}
		let after = rest[digits..].trim_start_matches(is_java_space);
		after.chars().all(|c| c.is_ascii_alphabetic())
	};
	match value
		.match_indices(',')
		.find(|(index, _)| unit_tail(&value[index + 1..]))
	{
		Some((index, _)) => format!("{}.{}", &value[..index], &value[index + 1..]),
		None => value.to_owned(),
	}
}

fn parse_height_value(value: Option<&str>) -> Option<f64> {
	parse_double_or_null(value.map(sanitize_height).as_deref())
}

/// The fork's `parseHeight`: the tagged height, else three meters per level plus two; and the minimum height.
pub(crate) fn parse_height(
	height: Option<&str>,
	levels: Option<&str>,
	min_height: Option<&str>,
) -> (Option<f64>, Option<f64>) {
	let height =
		parse_height_value(height).or_else(|| parse_double_or_null(levels).map(|levels| levels.max(1.0) * 3.0 + 2.0));
	(height, parse_height_value(min_height))
}

/// The fork's `quantizeVal`: rounds to a multiple of `step`, with values under one step raised to it.
fn quantize(value: f64, step: i32) -> f64 {
	if value < f64::from(step) {
		return f64::from(step);
	}
	f64::from((java_round(value / f64::from(step)) as i64 as i32).wrapping_mul(step))
}

/// The fork's `isModeledLandmark`: whether the footprint's longitude and latitude centroid lies within a landmark's
/// radius. Footprints whose bounds lie far from every landmark skip the centroid.
pub(crate) fn is_modeled_landmark(input: &Input<'_>) -> bool {
	let Ok(world) = input.source.world_geometry() else {
		return false;
	};
	let world = Geom::from(&world);
	let Some([min_x, min_y, max_x, max_y]) = world.envelope() else {
		return false;
	};
	let lon = |x: f64| x * 360.0 - 180.0;
	let lat = hrt_osm::coords::world_lat;
	// A margin of 0.01 degrees is at least 250 m of longitude up to 77 degrees of latitude, so a footprint whose
	// centroid lies within MAX_SUPPRESS_RADIUS of a landmark always passes the shortcut.
	let near = modeled_landmarks().iter().any(|[landmark_lon, landmark_lat, _]| {
		lon(min_x) - 0.01 <= *landmark_lon
			&& *landmark_lon <= lon(max_x) + 0.01
			&& lat(max_y) - 0.01 <= *landmark_lat
			&& *landmark_lat <= lat(min_y) + 0.01
	});
	if !near {
		return false;
	}
	let Some((x, y)) = lon_lat_centroid(input) else {
		return false;
	};
	modeled_landmarks().iter().any(|[landmark_lon, landmark_lat, radius]| {
		let dx = (x - landmark_lon) * 111_320.0 * landmark_lat.to_radians().cos();
		let dy = (y - landmark_lat) * 110_540.0;
		java_math::hypot(dx, dy) <= *radius
	})
}

fn world_to_lon_lat(geom: &Geom) -> Geom {
	let point = |[x, y]: [f64; 2]| [x * 360.0 - 180.0, hrt_osm::coords::world_lat(y)];
	let seq = |seq: &Vec<[f64; 2]>| seq.iter().map(|&p| point(p)).collect::<Vec<_>>();
	let polygon = |p: &hrt_render::Polygon| hrt_render::Polygon {
		shell: seq(&p.shell),
		holes: p.holes.iter().map(seq).collect(),
	};
	match geom {
		Geom::Polygon(p) => Geom::Polygon(polygon(p)),
		Geom::MultiPolygon(polygons) => Geom::MultiPolygon(polygons.iter().map(polygon).collect()),
		other => other.clone(),
	}
}

/// The fork's `roundedFootprint`: the source polygon with rounded corners, else the source polygon itself.
fn rounded_footprint<'c>(collector: &'c mut Collector<'_>, input: &Input<'_>, layer: u32) -> &'c mut Builder {
	match input.source.world_geometry() {
		Ok(world) => collector.geometry(
			layer,
			round_world_polygon(&Geom::from(&world), CORNER_METERS, CORNER_PASSES),
		),
		Err(_) => collector.polygon(layer),
	}
}

/// Where the layer's footprints come from, the fork's `overtureFootprints` and `footprints` flags.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Footprints {
	/// OpenStreetMap building and building-part polygons.
	#[default]
	Osm,
	/// Overture's buildings theme; OpenStreetMap contributes only address points.
	Overture,
	/// No footprints: the layer holds only the address points that house-number labels read.
	None,
}

/// `Buildings.processOsm`: footprints of buildings and building parts, and address points.
pub fn process_osm(
	input: &Input<'_>,
	layer: u32,
	footprints: Footprints,
	features: &mut Vec<Emitted>,
	config: CollectorConfig,
) {
	let mut collector = Collector::new(input, config);
	let is_building = (input.has_tag("building") && input.tag("building") != Some("no"))
		|| (input.has_tag("building:part") && input.tag("building:part") != Some("no"));
	if footprints == Footprints::Osm && input.can_be_polygon() && is_building && !is_modeled_landmark(input) {
		let (height, min_height) = parse_height(
			input.tag(HEIGHT_KEY),
			input.tag("building:levels"),
			input.tag(MIN_HEIGHT_KEY),
		);
		let part = input.has_tag("building:part");
		let (kind, min_zoom) = if part { ("building_part", 13) } else { ("building", 11) };
		let feature = rounded_footprint(&mut collector, input, layer)
			.set_id(feature_id(input.source))
			.set_attr("kind", kind)
			.set_attr_with_min_zoom("layer", parse_int_or_null(input.tag("layer")), 13)
			// Heights are quantized per zoom in post-processing.
			.set_attr(HEIGHT_KEY, height)
			.set_attr_with_min_zoom("roof_shape", input.tag("roof:shape"), 15)
			.set_attr_with_min_zoom("roof_height", parse_height_value(input.tag("roof:height")), 15)
			.set_attr("sort_rank", 400)
			.set_zoom_range(min_zoom, 15)
			.set_min_pixel_size(0.0)
			.set_min_pixel_size_overrides(12, 1.0);
		if part {
			feature
				.set_attr("kind_detail", input.tag("building:part"))
				.set_attr(MIN_HEIGHT_KEY, min_height);
		}
	}

	// Japanese addresses number the block rather than the house, so a block number alone also counts as an address.
	if input.has_tag("addr:housenumber") || input.has_tag("addr:block_number") {
		let feature = if input.is_point() {
			Some(collector.point(layer))
		} else if input.can_be_polygon() {
			Some(collector.centroid(layer))
		} else {
			None
		};
		if let Some(feature) = feature {
			feature
				.set_id(feature_id(input.source))
				.set_attr("addr_housenumber", input.tag("addr:housenumber"))
				.set_attr("addr_street", input.tag("addr:street"))
				.set_attr("addr_block_number", input.tag("addr:block_number"))
				.set_attr("kind", "address")
				.set_min_zoom(15);
		}
	}
	features.extend(collector.finish());
}

/// The footprint's centroid in longitude and latitude, as JTS computes it on `latLonGeometry()`.
pub(crate) fn lon_lat_centroid(input: &Input<'_>) -> Option<(f64, f64)> {
	use geos::Geom as _;
	let world = Geom::from(&input.source.world_geometry().ok()?);
	let centroid = hrt_render::snap::to_geos(&world_to_lon_lat(&world))
		.ok()?
		.get_centroid()
		.ok()?;
	Some((centroid.get_x().ok()?, centroid.get_y().ok()?))
}

/// `BuildingAttributes.HEIGHT_FROM_TAG` and `HEIGHT_FROM_FLOORS`: where a building's `height` came from.
const HEIGHT_FROM_TAG: &str = "height";
const HEIGHT_FROM_FLOORS: &str = "floors";

/// The side of a district cell in meters; the buildings in one cell share a district index.
const DISTRICT_CELL_METERS: f64 = 128.0;
const DISTRICT_COUNT: i64 = 16;

/// `BuildingAttributes.district`: a hash of the 128 m cell holding the point, from 0 to 15. A style picks a building's
/// palette entry from it, so a street reads as one fabric while neighboring districts differ.
pub(crate) fn district(lon: f64, lat: f64) -> i32 {
	// Java's `Math.cos` and Rust's agree to within an ulp, which moves a building only when it lies on a cell edge.
	let cell_x = (lon * 111_320.0 * lat.to_radians().cos() / DISTRICT_CELL_METERS).floor() as i64;
	let cell_y = (lat * 110_540.0 / DISTRICT_CELL_METERS).floor() as i64;
	let mut h =
		cell_x.wrapping_mul(0x9E37_79B9_7F4A_7C15_u64 as i64) ^ cell_y.wrapping_mul(0xC2B2_AE3D_27D4_EB4F_u64 as i64);
	h ^= ((h as u64) >> 31) as i64;
	h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9_u64 as i64);
	h ^= ((h as u64) >> 29) as i64;
	h.rem_euclid(DISTRICT_COUNT) as i32
}

/// The color names `BuildingAttributes` accepts, ported there from Arnis (Apache-2.0, `src/colors.rs`).
const NAMED_COLORS: &[(&str, &str)] = &[
	("aqua", "#00ffff"),
	("cyan", "#00ffff"),
	("beige", "#bbad8e"),
	("black", "#000000"),
	("blue", "#0000ff"),
	("brown", "#804000"),
	("darkgray", "#606060"),
	("darkgrey", "#606060"),
	("darkbrown", "#5a3214"),
	("darkred", "#8b0000"),
	("dimgray", "#696969"),
	("dimgrey", "#696969"),
	("firebrick", "#b22222"),
	("fuchsia", "#ff00ff"),
	("magenta", "#ff00ff"),
	("gold", "#ffd700"),
	("gray", "#808080"),
	("grey", "#808080"),
	("green", "#008000"),
	("ivory", "#fffff0"),
	("khaki", "#f0e68c"),
	("lightblue", "#add8e6"),
	("lightgray", "#d3d3d3"),
	("lightgrey", "#d3d3d3"),
	("lightgreen", "#90ee90"),
	("lightyellow", "#ffffe0"),
	("lime", "#00ff00"),
	("limestone", "#f6f0d0"),
	("maroon", "#800000"),
	("navy", "#000080"),
	("olive", "#808000"),
	("orange", "#ff8000"),
	("pink", "#ffc0cb"),
	("purple", "#800080"),
	("red", "#ff0000"),
	("salmon", "#fa8072"),
	("sandstone", "#d7bc8a"),
	("silver", "#c0c0c0"),
	("tan", "#d2b48c"),
	("teal", "#008080"),
	("white", "#ffffff"),
	("yellow", "#ffff00"),
];

/// `BuildingAttributes.normalizeColor`: a color as lowercase `#rrggbb`, or `None` when the text is neither a hex color
/// nor a known color name.
pub(crate) fn normalize_color(value: Option<&str>) -> Option<String> {
	// Java's `String.trim` removes every character up to U+0020 from both ends.
	let trimmed = value?.trim_matches(|c: char| c <= ' ').to_lowercase();
	let hex = |text: &str| text.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
	if let Some(digits) = trimmed.strip_prefix('#') {
		if digits.len() == 6 && hex(digits) {
			return Some(trimmed);
		}
		if digits.len() == 3 && hex(digits) {
			return Some(digits.chars().fold(String::from("#"), |mut out, c| {
				out.push(c);
				out.push(c);
				out
			}));
		}
	}
	let name: String = trimmed
		.chars()
		.filter(|&c| !is_java_space(c) && c != '_' && c != '-')
		.collect();
	NAMED_COLORS
		.iter()
		.find(|(known, _)| *known == name)
		.map(|(_, color)| (*color).to_owned())
}

/// The fork's `gersFeatureId`: a tile feature id from an Overture GERS id's first 52 bits, which stay exact as a
/// JavaScript number, so a map client can key feature state by it. An id that does not start with 13 hex digits gets
/// its Java `hashCode` as an unsigned number.
pub(crate) fn gers_feature_id(gers: Option<&str>) -> i64 {
	let Some(gers) = gers else {
		return 0;
	};
	let hex: String = gers.chars().filter(|&c| c != '-').collect();
	match hex.get(..13).filter(|head| head.chars().all(|c| c.is_ascii_hexdigit())) {
		Some(head) => i64::from_str_radix(head, 16).unwrap_or(0),
		None => {
			// Java's `String.hashCode` over UTF-16 code units, each read as an unsigned `char`.
			let hash = gers
				.encode_utf16()
				.fold(0i32, |h, unit| h.wrapping_mul(31).wrapping_add(i32::from(unit)));
			i64::from(hash as u32)
		}
	}
}

/// `Buildings.processOverture`: a footprint for each Overture building and building part. A building with parts is
/// left to its parts, because its own outline is the envelope of every part at the tallest part's height.
pub fn process_overture(
	input: &Input<'_>,
	layer: u32,
	footprints: Footprints,
	features: &mut Vec<Emitted>,
	config: CollectorConfig,
) {
	if footprints == Footprints::None || input.tag("theme") != Some("buildings") {
		return;
	}
	let part = match input.tag("type") {
		Some("building") => false,
		Some("building_part") => true,
		_ => return,
	};
	if (!part && input.tag("has_parts") == Some("true")) || is_modeled_landmark(input) {
		return;
	}
	// Overture gives height in meters and floors as `num_floors`; floors convert the same way as `building:levels`.
	let (height, min_height) = parse_height(input.tag("height"), input.tag("num_floors"), input.tag("min_height"));
	let height_source = if input.has_tag("height") {
		Some(HEIGHT_FROM_TAG)
	} else if input.has_tag("num_floors") {
		Some(HEIGHT_FROM_FLOORS)
	} else {
		None
	};
	let district = lon_lat_centroid(input).map(|(lon, lat)| district(lon, lat));
	let number = |key: &str| input.tag(key).and_then(|text| text.parse::<f64>().ok());
	let mut collector = Collector::new(input, config);
	let feature = rounded_footprint(&mut collector, input, layer)
		.set_id(gers_feature_id(input.tag("id")))
		.set_attr("kind", if part { "building_part" } else { "building" })
		// Heights are quantized per zoom in post-processing.
		.set_attr(HEIGHT_KEY, height)
		.set_attr_with_min_zoom("height_src", height_source, 13)
		.set_attr_with_min_zoom("district", district, 13)
		.set_attr_with_min_zoom("facade_color", normalize_color(input.tag("facade_color")), 13)
		.set_attr_with_min_zoom("roof_color", normalize_color(input.tag("roof_color")), 13)
		.set_attr_with_min_zoom("roof_material", input.tag("roof_material"), 15)
		.set_attr_with_min_zoom("facade_material", input.tag("facade_material"), 15)
		.set_attr_with_min_zoom("class", input.tag("class"), 15)
		.set_attr_with_min_zoom("roof_shape", input.tag("roof_shape"), 15)
		.set_attr_with_min_zoom("roof_height", number("roof_height"), 15)
		.set_attr("sort_rank", 400)
		.set_zoom_range(if part { 13 } else { 11 }, 15)
		.set_min_pixel_size(0.0)
		.set_min_pixel_size_overrides(12, 1.0);
	if part {
		feature.set_attr(MIN_HEIGHT_KEY, min_height);
	}
	features.extend(collector.finish());
}

/// `Buildings.postProcess`. At zoom 15, addresses with equal attributes keep their first point, without its street.
/// Below it the name attributes drop; below zoom 14 the feature id and `sort_rank` drop as well; at zooms 11 and 12
/// heights round to 20 meters and neighboring footprints merge.
pub fn post_process(zoom: u8, features: Vec<TileFeature>, counts: &mut SnapCounts) -> Vec<TileFeature> {
	if zoom == 15 {
		let mut buildings = Vec::with_capacity(features.len());
		let mut addresses: Vec<(Vec<(String, Value)>, TileFeature)> = Vec::new();
		for feature in features {
			if !feature.attributes.iter().any(|(key, _)| key == "addr_housenumber") {
				buildings.push(feature);
			} else if !addresses
				.iter()
				.any(|(attributes, _)| same_attributes(attributes, &feature.attributes))
			{
				addresses.push((feature.attributes.clone(), feature));
			}
		}
		buildings.extend(addresses.into_iter().map(|(_, mut feature)| {
			feature.attributes.retain(|(key, _)| key != "addr_street");
			feature
		}));
		return buildings;
	}
	// The fork's Area.filterArea with no minimum area keeps every feature and removes its names. Below zoom 14 the feature
	// id and `sort_rank` drop too: the map reads a footprint's id only to hide it under a city model, which draws from
	// zoom 14, and no style reads `sort_rank`. On a central Osaka z13 tile they were 26% of the decoded bytes.
	let mut features: Vec<TileFeature> = features
		.into_iter()
		.map(|mut feature| {
			let below_14 = zoom < 14;
			feature
				.attributes
				.retain(|(key, _)| key != "name" && !key.starts_with("name:") && !(below_14 && key == "sort_rank"));
			if below_14 {
				feature.id = 0;
			}
			feature
		})
		.collect();
	if zoom >= 13 {
		return features;
	}
	for (key, value) in features.iter_mut().flat_map(|feature| feature.attributes.iter_mut()) {
		if let Value::Double(height) = value {
			if (key == HEIGHT_KEY || key == MIN_HEIGHT_KEY) && *height > 0.0 {
				*height = quantize(*height, 20);
			}
		}
	}
	merge_nearby_polygons(features, 3.125, 3.125, 0.5, 0.5, counts)
}

/// Java `Map.equals`: the same keys with equal values, in any order.
fn same_attributes(a: &[(String, Value)], b: &[(String, Value)]) -> bool {
	a.len() == b.len() && a.iter().all(|entry| b.contains(entry))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn landmarks_come_from_the_structures_list() {
		let landmarks = modeled_landmarks();
		// Tokyo Tower's anchor and radius, as the list states them.
		assert!(landmarks.contains(&[139.745433, 35.658581, 45.0]));
		assert!(landmarks
			.iter()
			.all(|[_, _, radius]| *radius > 0.0 && *radius <= MAX_SUPPRESS_RADIUS));
	}

	#[test]
	#[should_panic(expected = "landmark wide needs")]
	fn landmarks_refuse_a_radius_past_the_shortcut_margin() {
		parse_landmarks(r#"[{"id": "wide", "anchor": [0, 0], "suppressRadius": 300}]"#);
	}

	#[test]
	fn heights_take_comma_decimals_and_levels() {
		assert_eq!(sanitize_height("89,10"), "89.10");
		assert_eq!(sanitize_height("89,1 m"), "89.1 m");
		assert_eq!(sanitize_height("1,000"), "1,000");
		assert_eq!(parse_height(Some("12,5"), None, None), (Some(12.5), None));
		assert_eq!(parse_height(None, Some("4"), Some("3")), (Some(14.0), Some(3.0)));
		assert_eq!(parse_height(None, Some("0"), None), (Some(5.0), None));
	}

	#[test]
	fn colors_normalize_from_hex_and_names() {
		assert_eq!(normalize_color(Some(" #A0B1C2 ")).as_deref(), Some("#a0b1c2"));
		assert_eq!(normalize_color(Some("#abc")).as_deref(), Some("#aabbcc"));
		assert_eq!(normalize_color(Some("Dark_Grey")).as_deref(), Some("#606060"));
		assert_eq!(normalize_color(Some("light green")).as_deref(), Some("#90ee90"));
		assert_eq!(normalize_color(Some("#abcd")), None);
		assert_eq!(normalize_color(Some("mauve")), None);
		assert_eq!(normalize_color(None), None);
	}

	#[test]
	fn gers_ids_keep_their_first_52_bits() {
		assert_eq!(
			gers_feature_id(Some("08b2f5a3-7c1e-4fff-0200-0a1b2c3d4e5f")),
			0x08b2f5a37c1e4
		);
		// Java's "abc".hashCode() is 96354.
		assert_eq!(gers_feature_id(Some("abc")), 96354);
		assert_eq!(gers_feature_id(None), 0);
	}

	#[test]
	fn districts_spread_over_sixteen_cells() {
		let mut seen = [false; 16];
		for step in 0..400 {
			let index = district(135.5 + f64::from(step) * 0.002, 34.68);
			seen[index as usize] = true;
		}
		assert!(seen.iter().all(|&hit| hit));
		// Two points in one 128 m cell share an index.
		assert_eq!(district(135.50001, 34.68001), district(135.50002, 34.68002));
	}

	#[test]
	fn heights_quantize_to_twenty_meters() {
		assert_eq!(quantize(3.0, 20), 20.0);
		assert_eq!(quantize(29.0, 20), 20.0);
		assert_eq!(quantize(30.0, 20), 40.0);
		assert_eq!(quantize(51.0, 20), 60.0);
	}
}
