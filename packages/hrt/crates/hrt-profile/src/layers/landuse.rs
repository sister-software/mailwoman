// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Landuse.java and feature/Area.java (BSD-3-Clause, Protomaps).

//! The `landuse` layer from OpenStreetMap: land-use, leisure, amenity and natural areas classified by one ordered rule
//! table, with small areas dropped below zoom 15 and neighbors merged at zoom 6 and below.
//!
//! The Overture land and land-use sources of the Java layer are not ported here.

use std::sync::LazyLock;

use hrt_render::snap::SnapCounts;

use crate::expr::{from_tag, get_string, rule, with, without, Index, Value};
use crate::merge::{decode, merge_nearby_polygons};
use crate::{feature_id, Collector, CollectorConfig, Emitted, Input, TileFeature};

pub const LAYER_NAME: &str = "landuse";

const US_FOREST_OPERATORS: &str = "
	operator
	United States Forest Service
	US Forest Service
	U.S. Forest Service
	USDA Forest Service
	United States Department of Agriculture
	US National Forest Service
	United State Forest Service
	U.S. National Forest Service
";

const PROTECTION_TITLES: &str = "
	protection_title
	Conservation Area
	Conservation Park
	Environmental use
	Forest Reserve
	National Forest
	National Wildlife Refuge
	Nature Refuge
	Nature Reserve
	Protected Site
	Provincial Park
	Public Access Land
	Regional Reserve
	Resources Reserve
	State Forest
	State Game Land
	State Park
	Watershed Recreation Unit
	Wild Forest
	Wilderness Area
	Wilderness Study Area
	Wildlife Management
	Wildlife Management Area
	Wildlife Sanctuary
";

const PARK_SERVICE_OPERATORS: &str = "
	operator
	United States National Park Service
	National Park Service
	US National Park Service
	U.S. National Park Service
	US National Park service
";

fn kind(value: &str) -> Vec<(&'static str, Value)> {
	vec![("kind", Value::from(value))]
}

fn kind_from(tag: &str) -> Vec<(&'static str, Value)> {
	vec![("kind", from_tag(tag))]
}

static INDEX: LazyLock<Index> = LazyLock::new(|| {
	let national_park = |condition: crate::expr::Expr| {
		rule(
			vec![
				with(&["boundary", "national_park"]),
				without(&[US_FOREST_OPERATORS]),
				without(&[PROTECTION_TITLES]),
				condition,
			],
			kind("national_park"),
		)
	};
	Index::new(vec![
		// Rice paddies are farmland tagged with their crop; Japanese maps draw them with their own symbol.
		rule(vec![with(&["landuse", "farmland", "paddy"]), with(&["crop", "rice"])], kind("paddy")),
		rule(vec![with(&["landuse", "vineyard", "plant_nursery"])], kind_from("landuse")),
		// Sports grounds; large parks around stadiums are often tagged sports_centre rather than park.
		rule(vec![with(&["leisure", "sports_centre", "stadium", "track"])], kind_from("leisure")),
		rule(
			vec![with(&["amenity\nhospital\nschool\nkindergarten\nuniversity\ncollege"])],
			kind_from("amenity"),
		),
		rule(
			vec![with(&[
				"landuse\nrecreation_ground\nindustrial\nrailway\ncemetery\ncommercial\ngrass\nfarmland\nresidential\nmilitary\nvillage_green\nallotments\nforest\nmeadow\ngrass",
			])],
			kind_from("landuse"),
		),
		rule(vec![with(&["aeroway\naerodrome\nrunway"])], kind_from("aeroway")),
		rule(
			vec![with(&["leisure\npark\ngarden\ngolf_course\ndog_park\nplayground\npitch\nnature_reserve"])],
			kind_from("leisure"),
		),
		rule(vec![with(&["man_made", "pier"])], kind("pier")),
		rule(
			vec![with(&["natural\nbeach\nwood\nglacier\ngrassland\nscrub\nsand\nwetland\nbare_rock"])],
			kind_from("natural"),
		),
		rule(vec![with(&["highway\npedestrian\nfootway"]), with(&["area", "yes"])], kind("pedestrian")),
		rule(vec![with(&["waterway", "dam"])], kind("dam")),
		rule(vec![with(&["railway", "platform"])], kind("platform")),
		rule(vec![with(&["tourism", "zoo"])], kind("zoo")),
		rule(
			vec![with(&["landuse", "military"]), with(&["military", "airfield", "naval_base"])],
			kind_from("military"),
		),
		rule(vec![with(&["landuse", "brownfield"])], kind("industrial")),
		rule(vec![with(&["landuse", "farmyard", "orchard"])], kind("farmland")),
		rule(vec![with(&["man_made", "bridge"])], kind("pedestrian")),
		rule(vec![with(&["area:aeroway", "taxiway", "runway"])], kind_from("area:aeroway")),
		rule(vec![with(&["place", "neighbourhood"])], kind("other")),
		rule(
			vec![
				with(&["boundary", "protected_area"]),
				with(&["protect_class", "6"]),
				with(&[US_FOREST_OPERATORS]),
			],
			kind("forest"),
		),
		rule(vec![with(&["boundary", "national_park"])], kind("park")),
		national_park(with(&["protect_class", "2", "3"])),
		national_park(with(&[PARK_SERVICE_OPERATORS])),
		national_park(with(&["operator:en", "Parks Canada"])),
		national_park(with(&["designation", "national_park"])),
		national_park(with(&["protection_title", "National Park"])),
	])
});

/// `Landuse.processOsm`: every area the rule table classifies, from zoom 2.
pub fn process_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	if !input.can_be_polygon() {
		return;
	}
	let matches = INDEX.matches(input);
	if matches.is_empty() {
		return;
	}
	let kind = get_string(input, &matches, "kind", Some("other")).unwrap_or_default();
	let mut collector = Collector::new(input, config);
	collector
		.polygon(layer)
		.set_id(feature_id(input.source))
		.set_attr("kind", kind.as_str())
		.set_attr("sort_rank", 189)
		.set_zoom_range(2, 15)
		.set_min_pixel_size(2.0);
	features.extend(collector.finish());
}

/// The fork's `Area.filterArea`: drops features whose bounding box covers less than `min_area` square pixels, and below
/// 30,000 / 4096² × 256² square pixels removes the `name` and `name:*` attributes of the features kept.
fn filter_area(features: Vec<TileFeature>, min_area: f64) -> Vec<TileFeature> {
	let strip_names = min_area < 30_000.0 / (4096.0 * 4096.0) * (256.0 * 256.0);
	features
		.into_iter()
		.filter_map(|mut feature| {
			let area = decode(&feature.geometry)
				.envelope()
				.map_or(0.0, |[min_x, min_y, max_x, max_y]| (max_x - min_x) * (max_y - min_y));
			if min_area > 0.0 && area < min_area {
				return None;
			}
			if strip_names {
				feature
					.attributes
					.retain(|(key, _)| key != "name" && !key.starts_with("name:"));
			}
			Some(feature)
		})
		.collect()
}

/// `Landuse.postProcess`: below zoom 15 small areas drop, and at zoom 6 and below neighbors merge.
pub fn post_process(zoom: u8, features: Vec<TileFeature>, counts: &mut SnapCounts) -> Vec<TileFeature> {
	if zoom == 15 {
		return features;
	}
	let tile_pixels = 256.0 * 256.0 / (4096.0 * 4096.0);
	let min_area = match zoom {
		0..=5 => 800.0 * tile_pixels,
		6 => 600.0 * tile_pixels,
		_ => 400.0 * tile_pixels,
	};
	let features = filter_area(features, min_area);
	if zoom <= 6 {
		return merge_nearby_polygons(features, 3.125, 3.125, 0.5, 0.5, counts);
	}
	features
}

#[cfg(test)]
mod tests {
	use hrt_e::Value as Attr;
	use hrt_osm::{ElementKind, Geometry, NodeStore, SourceFeature, Tags};

	use super::*;

	/// The kind LanduseTest's `processWith` would assert for a unit-square area with these tags, or `None` when the
	/// layer emits nothing.
	fn kind_of(tags: &[(&str, &str)]) -> Option<String> {
		let tags = Tags(tags.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
		let nodes = NodeStore::default();
		let square = geo::LineString::from(vec![(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]);
		let source = SourceFeature::fixed(
			1,
			ElementKind::Way,
			("osm", ""),
			&tags,
			Geometry::Polygon(geo::Polygon::new(square, vec![])),
			&nodes,
		);
		let mut out = Vec::new();
		process_osm(&Input::new(&source), 0, &mut out, CollectorConfig::new(15));
		out.first().and_then(|emitted| {
			emitted
				.attributes_at(15)
				.into_iter()
				.find(|(key, _)| key == "kind")
				.map(|(_, value)| match value {
					Attr::String(text) => text,
					other => format!("{other:?}"),
				})
		})
	}

	#[test]
	fn kinds_follow_the_rule_table() {
		let cases: [(&[(&str, &str)], &str); 15] = [
			(&[("aeroway", "aerodrome"), ("landuse", "industrial")], "aerodrome"),
			// The last matching rule wins, so the general landuse rule overrides the paddy rule for farmland, as in Java.
			(&[("landuse", "farmland"), ("crop", "rice")], "farmland"),
			(&[("landuse", "paddy"), ("crop", "rice")], "paddy"),
			(&[("landuse", "military")], "military"),
			(&[("landuse", "military"), ("military", "naval_base")], "naval_base"),
			(&[("landuse", "brownfield")], "industrial"),
			(&[("landuse", "orchard")], "farmland"),
			(&[("man_made", "bridge")], "pedestrian"),
			(&[("area", "yes"), ("highway", "footway")], "pedestrian"),
			(&[("place", "neighbourhood")], "other"),
			(&[("boundary", "national_park")], "park"),
			(
				&[
					("boundary", "national_park"),
					("operator", "United States Forest Service"),
					("protect_class", "2"),
				],
				"park",
			),
			(
				&[
					("boundary", "national_park"),
					("protection_title", "Conservation Area"),
					("operator:en", "Parks Canada"),
				],
				"park",
			),
			(
				&[
					("boundary", "protected_area"),
					("protect_class", "6"),
					("operator", "USDA Forest Service"),
				],
				"forest",
			),
			(&[("leisure", "park")], "park"),
		];
		for (tags, expected) in cases {
			assert_eq!(kind_of(tags).as_deref(), Some(expected), "{tags:?}");
		}
		assert_eq!(kind_of(&[("building", "yes")]), None);
	}

	#[test]
	fn small_areas_drop_and_names_go_below_zoom_15() {
		use hrt_render::{GeometryType, VectorGeometry};
		// A 4-pixel square at extent 4096 and scale 0 covers 4 × 4 / 16² = 0.0625 square pixels of a 256 tile, under
		// zoom 14's minimum of 400 / 4096² × 256² = 1.5625.
		let square = |side: u32| VectorGeometry {
			commands: vec![9, 0, 0, 26, side * 2, 0, 0, side * 2, (side * 2) - 1, 0, 15],
			geom_type: GeometryType::Polygon,
			scale: 0,
		};
		let feature = |side, name: &str| TileFeature {
			id: 1,
			geometry: square(side),
			attributes: vec![
				("kind".into(), Attr::String("park".into())),
				("name".into(), Attr::String(name.into())),
				("name:fr".into(), Attr::String(name.into())),
			],
		};
		let kept = post_process(
			14,
			vec![feature(4, "small"), feature(400, "large")],
			&mut SnapCounts::default(),
		);
		assert_eq!(kept.len(), 1);
		assert_eq!(kept[0].attributes, [("kind".to_owned(), Attr::String("park".into()))]);
		let at_15 = post_process(15, vec![feature(4, "small")], &mut SnapCounts::default());
		assert_eq!(at_15.len(), 1);
	}
}
