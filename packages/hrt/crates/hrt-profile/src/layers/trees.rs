// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Trees.java (BSD-3-Clause, Protomaps).

//! The `trees` layer at zoom 15: for each OpenStreetMap tree, and for each tree placed every 7 meters along a tree row,
//! a point a renderer places a model at, plus a trunk octagon and a crown octagon for extrusion styles.
//!
//! The canopy-raster treetop source (`pm:treetops`, a Parquet file) of the Java layer is not ported here.

use std::f64::consts::PI;

use hrt_render::geom::{java_round, Geom, Xy};
use hrt_render::java_math;

use crate::parse::meters;
use crate::{Collector, CollectorConfig, Emitted, Input};

pub const LAYER_NAME: &str = "trees";

/// The height of a tree without a `height` tag: a typical Japanese street tree.
const DEFAULT_HEIGHT_METERS: f64 = 8.0;
/// The crown diameter of a tree without a `diameter_crown` tag.
const DEFAULT_CROWN_METERS: f64 = 5.0;
const ROW_SPACING_METERS: f64 = 7.0;
const TRUNK_RADIUS_METERS: f64 = 0.35;
/// The fraction of the height where the crown starts and the trunk ends.
const CROWN_BASE_FRACTION: f64 = 0.35;
const SIDES: usize = 8;
const EQUATOR_METERS: f64 = 40_075_016.686;
const MAX_ROW_TREES: usize = 2_000;

fn latitude(world_y: f64) -> f64 {
	java_math::atan(java_math::sinh(PI * (1.0 - 2.0 * world_y)))
}

/// A tag length between 0 and 150 meters, exclusive, else `fallback`.
fn positive(value: Option<f64>, fallback: f64) -> f64 {
	value.filter(|value| *value > 0.0 && *value < 150.0).unwrap_or(fallback)
}

/// Java's `Math.round(meters * 10) / 10.0`.
fn round(meters: f64) -> f64 {
	java_round(meters * 10.0) / 10.0
}

fn octagon(center: Xy, radius: f64) -> Geom {
	let mut ring: Vec<Xy> = (0..SIDES)
		.map(|i| {
			let angle = 2.0 * PI * i as f64 / SIDES as f64;
			[center[0] + radius * angle.cos(), center[1] + radius * angle.sin()]
		})
		.collect();
	ring.push(ring[0]);
	Geom::Polygon(hrt_render::Polygon {
		shell: ring,
		holes: Vec::new(),
	})
}

/// Positions every [`ROW_SPACING_METERS`] along a line in world coordinates, starting half a spacing in, at most
/// [`MAX_ROW_TREES`] in all.
fn along_line(coords: &[Xy]) -> Vec<Xy> {
	let mut positions = Vec::new();
	if coords.len() < 2 {
		return positions;
	}
	let spacing = ROW_SPACING_METERS / (EQUATOR_METERS * latitude(coords[0][1]).cos());
	let mut until_next = spacing / 2.0;
	for pair in coords.windows(2) {
		if positions.len() >= MAX_ROW_TREES {
			break;
		}
		let [from, to] = [pair[0], pair[1]];
		let length = java_math::hypot(from[0] - to[0], from[1] - to[1]);
		let mut traveled = 0.0;
		while traveled + until_next <= length && positions.len() < MAX_ROW_TREES {
			traveled += until_next;
			let t = traveled / length;
			positions.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
			until_next = spacing;
		}
		until_next -= length - traveled;
	}
	positions
}

fn emit_tree(collector: &mut Collector<'_>, layer: u32, center: Xy, height: f64, crown: f64, leaf_type: Option<&str>) {
	let meters_to_world = 1.0 / (EQUATOR_METERS * latitude(center[1]).cos());
	let crown_base = height * CROWN_BASE_FRACTION;
	// Needle-leaved trees are narrow for their height.
	let crown_radius = if leaf_type == Some("needleleaved") {
		crown * 0.35
	} else {
		crown * 0.5
	};

	collector
		.geometry(layer, Geom::Point(center))
		.set_attr("kind", "tree")
		.set_attr("height", round(height))
		.set_attr("crown_base", round(crown_base))
		.set_attr("crown_diameter", round(crown_radius * 2.0))
		.set_attr("leaf_type", leaf_type)
		.set_zoom_range(15, 15);
	collector
		.geometry(layer, octagon(center, TRUNK_RADIUS_METERS * meters_to_world))
		.set_attr("kind", "trunk")
		.set_attr("height", round(crown_base + 0.5))
		.set_attr("min_height", 0)
		.set_zoom_range(15, 15)
		.set_min_pixel_size(0.0);
	collector
		.geometry(layer, octagon(center, crown_radius * meters_to_world))
		.set_attr("kind", "crown")
		.set_attr("height", round(height))
		.set_attr("min_height", round(crown_base))
		.set_attr("leaf_type", leaf_type)
		.set_zoom_range(15, 15)
		.set_min_pixel_size(0.0);
}

/// `Trees.processOsm`: `natural=tree` points and `natural=tree_row` lines.
pub fn process_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	if !input.has_tag_in("natural", &["tree", "tree_row"]) {
		return;
	}
	let height = positive(meters(input.tag("height")), DEFAULT_HEIGHT_METERS);
	let crown = positive(meters(input.tag("diameter_crown")), DEFAULT_CROWN_METERS);
	let leaf_type = input.tag("leaf_type");

	let mut collector = Collector::new(input, config);
	if input.is_point() && input.tag("natural") == Some("tree") {
		if let Ok(hrt_osm::Geometry::Point(point)) = input.source.world_geometry() {
			emit_tree(&mut collector, layer, [point.x(), point.y()], height, crown, leaf_type);
		}
	} else if input.can_be_line() && input.tag("natural") == Some("tree_row") {
		if let Ok(line) = input.source.line() {
			let coords: Vec<Xy> = line.coords().map(|c| [c.x, c.y]).collect();
			for position in along_line(&coords) {
				emit_tree(&mut collector, layer, position, height, crown, leaf_type);
			}
		}
	}
	features.extend(collector.finish());
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_row_places_trees_every_seven_meters_from_half_a_spacing_in() {
		// A row along the equator, 30 meters long: trees at 3.5, 10.5, 17.5 and 24.5 meters.
		let meter = 1.0 / EQUATOR_METERS;
		let positions = along_line(&[[0.0, 0.5], [30.0 * meter, 0.5]]);
		let offsets: Vec<f64> = positions.iter().map(|p| (p[0] / meter * 10.0).round() / 10.0).collect();
		assert_eq!(offsets, [3.5, 10.5, 17.5, 24.5]);
	}

	#[test]
	fn heights_round_to_a_tenth_and_out_of_range_tags_fall_back() {
		assert_eq!(round(8.0 * CROWN_BASE_FRACTION), 2.8);
		assert_eq!(round(0.25), 0.3);
		assert_eq!(positive(Some(200.0), DEFAULT_HEIGHT_METERS), DEFAULT_HEIGHT_METERS);
		assert_eq!(positive(Some(-1.0), DEFAULT_HEIGHT_METERS), DEFAULT_HEIGHT_METERS);
		assert_eq!(positive(Some(12.5), DEFAULT_HEIGHT_METERS), 12.5);
	}
}
