// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Earth.java (BSD-3-Clause, Protomaps).

//! The `earth` layer: land from the prepared OpenStreetMap land polygons from zoom 6 and from Natural Earth below it,
//! cliffs, and island labels.
//!
//! The Overture land source of the Java layer is not ported here.

use hrt_render::snap::SnapCounts;

use crate::merge::merge_nearby_polygons;
use crate::names::set_osm_names;
use crate::{feature_id, Collector, CollectorConfig, Emitted, Input, TileFeature};

pub const LAYER_NAME: &str = "earth";

const BUFFER: f64 = 0.0625;
const MIN_AREA: f64 = 1.0;
const PIXEL_TOLERANCE: f64 = 0.2;

/// `Earth.processPreparedOsm`: each prepared land polygon, from zoom 6.
pub fn process_prepared_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	let mut collector = Collector::new(input, config);
	collector
		.polygon(layer)
		.set_id(1)
		.set_attr("kind", "earth")
		.set_pixel_tolerance(PIXEL_TOLERANCE)
		.set_min_zoom(6)
		.set_buffer_pixels(8.0);
	features.extend(collector.finish());
}

/// `Earth.processNe`: Natural Earth's 1:50m land through zoom 4 and its 1:10m land at zoom 5.
pub fn process_ne(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	let source_layer = input.source.source_layer;
	let (min_zoom, max_zoom) = match source_layer {
		"ne_50m_land" => (0, 4),
		"ne_10m_land" => (5, 5),
		_ => return,
	};
	let mut collector = Collector::new(input, config);
	collector
		.polygon(layer)
		.set_id(1)
		.set_attr("kind", "earth")
		.set_zoom_range(min_zoom, max_zoom)
		.set_pixel_tolerance(PIXEL_TOLERANCE)
		.set_min_pixel_size(1.0)
		.set_buffer_pixels(8.0);
	features.extend(collector.finish());
}

/// `Earth.processOsm`: cliffs drawn as lines, and island names placed at each island's innermost point.
pub fn process_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	let mut collector = Collector::new(input, config);
	if input.can_be_line() && !input.can_be_polygon() && input.tag("natural") == Some("cliff") {
		let min_zoom = 12;
		let feature = collector
			.line(layer)
			.set_id(feature_id(input.source))
			.set_attr("min_zoom", min_zoom + 1)
			.set_attr("kind", "cliff")
			.set_pixel_tolerance(PIXEL_TOLERANCE)
			.set_min_zoom(min_zoom);
		set_osm_names(feature, input, 0);
	}
	if input.can_be_polygon() && input.tag("place") == Some("island") {
		let feature = collector
			.innermost_point(layer, 0.1)
			.set_id(feature_id(input.source))
			.set_attr("kind", "island")
			.set_min_pixel_size(20.0)
			.set_min_zoom(6);
		set_osm_names(feature, input, 0);
	}
	features.extend(collector.finish());
}

/// `Earth.postProcess`: land polygons closer than half a pixel merge, and pieces under one square pixel drop.
pub fn post_process(features: Vec<TileFeature>, counts: &mut SnapCounts) -> Vec<TileFeature> {
	merge_nearby_polygons(features, MIN_AREA, MIN_AREA, 0.5, BUFFER, counts)
}

#[cfg(test)]
mod tests {
	use hrt_osm::{ElementKind, Geometry, NodeStore, SourceFeature, Tags};
	use hrt_render::Geom;

	use super::*;

	#[test]
	fn an_island_label_sits_at_the_innermost_point() {
		// A square island 0.4 across with a long tail 0.04 wide: the largest inscribed circle, radius about 0.2, is
		// centered in the square, while the centroid is pulled toward the tail.
		let shell = geo::LineString::from(vec![
			(0.0, 0.0),
			(0.4, 0.0),
			(0.4, 0.18),
			(2.0, 0.18),
			(2.0, 0.22),
			(0.4, 0.22),
			(0.4, 0.4),
			(0.0, 0.4),
			(0.0, 0.0),
		]);
		let tags = Tags(vec![("place".into(), "island".into()), ("name".into(), "L".into())]);
		let nodes = NodeStore::default();
		let source = SourceFeature::fixed(
			7,
			ElementKind::Way,
			("osm", ""),
			&tags,
			Geometry::Polygon(geo::Polygon::new(shell, vec![])),
			&nodes,
		);
		let mut out = Vec::new();
		process_osm(&Input::new(&source), 0, &mut out, CollectorConfig::new(15));
		assert_eq!(out.len(), 1);
		let Geom::Point([x, y]) = out[0].feature.geometry else {
			panic!("expected a point, got {:?}", out[0].feature.geometry);
		};
		// The tolerance is a tenth of the square root of the area, about 0.05, so the center may sit that far off.
		assert!(
			(x - 0.2).hypot(y - 0.2) < 0.06,
			"innermost point ({x}, {y}) should lie near the square's center (0.2, 0.2)"
		);
		assert_eq!(out[0].feature.min_zoom, 6);
	}
}
