// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Landcover.java (BSD-3-Clause, Protomaps).

//! The `landcover` layer through zoom 7: the Daylight landcover classes, and Natural Earth's Antarctic glaciers,
//! which Daylight's source imagery does not reach.
//!
//! The Overture land cover source of the Java layer is not ported here.

use hrt_render::snap::{to_geos, SnapCounts};
use hrt_render::Geom;

use crate::merge::merge_nearby_polygons;
use crate::{Collector, CollectorConfig, Emitted, Input, TileFeature};

pub const LAYER_NAME: &str = "landcover";

/// The Earth layer's simplification tolerance, which the fork's landcover reuses.
const PIXEL_TOLERANCE: f64 = 0.2;
/// The Earth layer's merge buffer, which the fork's landcover reuses.
const BUFFER: f64 = 0.0625;
/// Web Mercator world y of roughly 60 degrees south: below it lies Antarctica.
const ANTARCTIC_WORLD_Y: f64 = 0.7;

/// The basemap kind for a Daylight class; other classes keep their own name.
fn kind(daylight_class: &str) -> &str {
	match daylight_class {
		"urban" => "urban_area",
		"crop" => "farmland",
		"grass" => "grassland",
		"trees" => "forest",
		"snow" => "glacier",
		"shrub" => "scrub",
		other => other,
	}
}

/// The archive order of a Daylight class: the classes are disjoint, and this keeps their order consistent.
fn sort_key(daylight_class: &str) -> i32 {
	match daylight_class {
		"barren" => 0,
		"snow" => 1,
		"crop" => 2,
		"shrub" => 3,
		"grass" => 4,
		"trees" => 5,
		_ => 6,
	}
}

/// `Landcover.processNe`: Natural Earth's glaciated areas whose centroid lies in Antarctica, through zoom 7.
pub fn process_ne(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	use geos::Geom as _;
	if input.source.source_layer != "ne_10m_glaciated_areas" {
		return;
	}
	let centroid_y = input
		.source
		.world_geometry()
		.ok()
		.and_then(|world| to_geos(&Geom::from(&world)).ok())
		.and_then(|shape| shape.get_centroid().ok())
		.and_then(|centroid| centroid.get_y().ok());
	if centroid_y.is_none_or(|y| y <= ANTARCTIC_WORLD_Y) {
		return;
	}
	let mut collector = Collector::new(input, config);
	collector
		.polygon(layer)
		.set_id(1)
		.set_attr("kind", "glacier")
		.set_max_zoom(7)
		.set_min_pixel_size(1.0)
		.set_pixel_tolerance(PIXEL_TOLERANCE);
	features.extend(collector.finish());
}

/// `Landcover.processLandcover`: each Daylight landcover polygon through zoom 7, with an id and sort key per class.
pub fn process_daylight(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	let daylight_class = input.tag("class");
	let key = sort_key(daylight_class.unwrap_or(""));
	let mut collector = Collector::new(input, config);
	collector
		.polygon(layer)
		.set_id(1 + i64::from(key))
		.set_attr("kind", daylight_class.map(kind))
		.set_zoom_range(0, 7)
		.set_sort_key(key)
		.set_min_pixel_size(1.0)
		.set_pixel_tolerance(PIXEL_TOLERANCE);
	features.extend(collector.finish());
}

/// `Landcover.postProcess`: polygons closer than half a pixel merge, and pieces under one square pixel drop.
pub fn post_process(features: Vec<TileFeature>, counts: &mut SnapCounts) -> Vec<TileFeature> {
	merge_nearby_polygons(features, 1.0, 1.0, 0.5, BUFFER, counts)
}

#[cfg(test)]
mod tests {
	use hrt_e::Value as Attr;
	use hrt_osm::{ElementKind, Geometry, NodeStore, SourceFeature, Tags};

	use super::*;

	fn square(y: f64) -> Geometry {
		Geometry::Polygon(geo::Polygon::new(
			geo::LineString::from(vec![(0.1, y), (0.1, y + 0.01), (0.11, y + 0.01), (0.11, y), (0.1, y)]),
			vec![],
		))
	}

	#[test]
	fn daylight_classes_map_to_kinds_ids_and_sort_keys() {
		let tags = Tags(vec![("class".into(), "trees".into())]);
		let nodes = NodeStore::default();
		let source = SourceFeature::fixed(
			9,
			ElementKind::Other,
			("landcover", "landcover"),
			&tags,
			square(0.3),
			&nodes,
		);
		let mut out = Vec::new();
		process_daylight(&Input::new(&source), 0, &mut out, CollectorConfig::new(15));
		assert_eq!(out.len(), 1);
		assert_eq!(out[0].feature.id, 6);
		assert_eq!(out[0].feature.sort_key, 5);
		assert_eq!(out[0].feature.max_zoom, 7);
		assert_eq!(
			out[0].attributes_at(0),
			[("kind".to_owned(), Attr::String("forest".into()))]
		);
		assert_eq!(kind("barren"), "barren");
		assert_eq!(sort_key("water"), 6);
	}

	#[test]
	fn only_antarctic_glaciers_come_from_natural_earth() {
		let tags = Tags::default();
		let nodes = NodeStore::default();
		let glacier = |y| {
			let source = SourceFeature::fixed(
				1,
				ElementKind::Other,
				("ne", "ne_10m_glaciated_areas"),
				&tags,
				square(y),
				&nodes,
			);
			let mut out = Vec::new();
			process_ne(&Input::new(&source), 0, &mut out, CollectorConfig::new(15));
			out.len()
		};
		assert_eq!(glacier(0.8), 1);
		assert_eq!(glacier(0.3), 0);
	}
}
