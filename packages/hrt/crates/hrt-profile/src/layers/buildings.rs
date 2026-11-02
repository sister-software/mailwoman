// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Buildings.java (BSD-3-Clause, Protomaps).

//! The `buildings` layer from OpenStreetMap: building and building-part footprints with rounded corners and heights,
//! and address points at zoom 15. Footprints merge into blocks at zooms 11 and 12.
//!
//! The Overture building source of the Java layer is not ported here.

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

/// Landmarks a 3D model draws, as longitude, latitude and radius in meters. A footprint whose centroid lies within the
/// radius is left out, so its extruded prisms do not show through the model.
const MODELED_LANDMARKS: [[f64; 3]; 2] = [
	[139.745433, 35.658581, 45.0], // Tokyo Tower
	[139.810700, 35.710063, 45.0], // Tokyo Skytree
];

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
fn parse_height(height: Option<&str>, levels: Option<&str>, min_height: Option<&str>) -> (Option<f64>, Option<f64>) {
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
fn is_modeled_landmark(input: &Input<'_>) -> bool {
	use geos::Geom as _;
	let Ok(world) = input.source.world_geometry() else {
		return false;
	};
	let world = Geom::from(&world);
	let Some([min_x, min_y, max_x, max_y]) = world.envelope() else {
		return false;
	};
	let lon = |x: f64| x * 360.0 - 180.0;
	let lat = hrt_osm::coords::world_lat;
	// About 0.01 degrees, over twenty times the largest radius, keeps the shortcut clear of every landmark.
	let near = MODELED_LANDMARKS.iter().any(|[landmark_lon, landmark_lat, _]| {
		lon(min_x) - 0.01 <= *landmark_lon
			&& *landmark_lon <= lon(max_x) + 0.01
			&& lat(max_y) - 0.01 <= *landmark_lat
			&& *landmark_lat <= lat(min_y) + 0.01
	});
	if !near {
		return false;
	}
	let Some((x, y)) = hrt_render::snap::to_geos(&world_to_lon_lat(&world))
		.ok()
		.and_then(|shape| shape.get_centroid().ok())
		.and_then(|centroid| Some((centroid.get_x().ok()?, centroid.get_y().ok()?)))
	else {
		return false;
	};
	MODELED_LANDMARKS.iter().any(|[landmark_lon, landmark_lat, radius]| {
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

/// `Buildings.processOsm`: footprints of buildings and building parts, and address points.
pub fn process_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	let mut collector = Collector::new(input, config);
	let is_building = (input.has_tag("building") && input.tag("building") != Some("no"))
		|| (input.has_tag("building:part") && input.tag("building:part") != Some("no"));
	if input.can_be_polygon() && is_building && !is_modeled_landmark(input) {
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

/// `Buildings.postProcess`. At zoom 15, addresses with equal attributes keep their first point, without its street.
/// Below it the name attributes drop; at zooms 11 and 12 heights round to 20 meters and neighboring footprints merge.
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
	// The fork's Area.filterArea with no minimum area keeps every feature and removes its names.
	let mut features: Vec<TileFeature> = features
		.into_iter()
		.map(|mut feature| {
			feature
				.attributes
				.retain(|(key, _)| key != "name" && !key.starts_with("name:"));
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
	fn heights_take_comma_decimals_and_levels() {
		assert_eq!(sanitize_height("89,10"), "89.10");
		assert_eq!(sanitize_height("89,1 m"), "89.1 m");
		assert_eq!(sanitize_height("1,000"), "1,000");
		assert_eq!(parse_height(Some("12,5"), None, None), (Some(12.5), None));
		assert_eq!(parse_height(None, Some("4"), Some("3")), (Some(14.0), Some(3.0)));
		assert_eq!(parse_height(None, Some("0"), None), (Some(5.0), None));
	}

	#[test]
	fn heights_quantize_to_twenty_meters() {
		assert_eq!(quantize(3.0, 20), 20.0);
		assert_eq!(quantize(29.0, 20), 20.0);
		assert_eq!(quantize(30.0, 20), 40.0);
		assert_eq!(quantize(51.0, 20), 60.0);
	}
}
