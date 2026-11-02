// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Water.java (BSD-3-Clause, Protomaps).

//! The `water` layer: OpenStreetMap water areas, waterway lines, water points and label points for named water areas;
//! Natural Earth oceans and lakes at zooms 0 to 5; and the prepared OpenStreetMap ocean polygons from zoom 6.

use std::sync::LazyLock;

use hrt_render::snap::SnapCounts;

use crate::expr::{from_tag, get_boolean, get_integer, get_string, rule, with, Expr, Index, Value};
use crate::merge::{merge_line_strings, merge_nearby_polygons};
use crate::names::set_osm_names;
use crate::parse::parse_int_or_null;
use crate::{feature_id, Collector, Input, TileFeature};

pub const LAYER_NAME: &str = "water";

/// The Earth layer's simplification tolerance, which the water layer shares.
pub const PIXEL_TOLERANCE: f64 = 0.2;
/// The Earth layer's minimum merged polygon area, in square tile pixels.
pub const MIN_AREA: f64 = 1.0;
/// The Earth layer's merge buffer, in tile pixels.
pub const BUFFER: f64 = 0.0625;

fn world_area_for_70k_square_meters() -> f64 {
	super::world_area_for_square_meters(70_000.0)
}

fn s(text: &str) -> Value {
	Value::from(text)
}

static OSM_INDEX: LazyLock<Index> = LazyLock::new(|| {
	Index::new(vec![
		rule(vec![with(&["natural", "reef"])], vec![("kind", s("reef"))]),
		rule(
			vec![with(&["natural", "reef"]), with(&["reef\ncoral\nrock\nsand"])],
			vec![("kindDetail", from_tag("reef"))],
		),
		rule(
			vec![with(&["waterway", "drain"])],
			vec![("kind", s("drain")), ("minZoom", Value::Int(15))],
		),
		rule(
			vec![with(&["waterway", "ditch"])],
			vec![("kind", s("ditch")), ("minZoom", Value::Int(15))],
		),
		rule(
			vec![with(&["waterway", "stream"])],
			vec![("kind", s("stream")), ("minZoom", Value::Int(13))],
		),
		rule(
			vec![with(&["waterway", "river"])],
			vec![("kind", s("river")), ("minZoom", Value::Int(9))],
		),
		rule(
			vec![with(&["waterway", "canal"])],
			vec![("kind", s("canal")), ("minZoom", Value::Int(10))],
		),
		rule(
			vec![with(&["waterway", "canal"]), with(&["boat", "yes"])],
			vec![("kind", s("canal")), ("minZoom", Value::Int(9))],
		),
		rule(
			vec![with(&["amenity", "swimming_pool"])],
			vec![("kind", s("swimming_pool"))],
		),
		rule(
			vec![with(&["leisure", "swimming_pool"])],
			vec![("kind", s("swimming_pool"))],
		),
		rule(vec![with(&["landuse", "reservoir"])], vec![("kind", s("lake"))]),
		rule(vec![with(&["landuse", "basin"])], vec![("kind", s("basin"))]),
		rule(
			vec![with(&["natural\nfjord\nstrait\nbay"])],
			vec![("kind", from_tag("natural")), ("keepPolygon", Value::Bool(false))],
		),
		rule(vec![with(&["natural", "water"])], vec![("kind", s("water"))]),
		rule(
			vec![
				with(&["natural", "water"]),
				with(&["water\nbasin\ncanal\nditch\ndrain\nlake\nriver\nstream"]),
			],
			vec![("kindDetail", from_tag("water"))],
		),
		rule(
			vec![
				with(&["natural", "water"]),
				with(&["water\nlagoon\noxbow\npond\nreservoir\nwastewater"]),
			],
			vec![("kindDetail", s("lake"))],
		),
		rule(vec![with(&["amenity", "fountain"])], vec![("kind", s("fountain"))]),
		rule(vec![with(&["waterway", "dock"])], vec![("kind", s("dock"))]),
		rule(vec![with(&["waterway", "riverbank"])], vec![("kind", s("riverbank"))]),
		rule(vec![with(&["covered", "yes"])], vec![("kind", Value::Null)]),
		rule(
			vec![with(&["place", "sea"]), Expr::Polygon],
			vec![("kind", s("sea")), ("keepPolygon", Value::Bool(false))],
		),
		rule(
			vec![
				with(&["place", "sea"]),
				Expr::Polygon,
				with(&["name:en\nNorth Sea\nAlboran Sea"]),
			],
			vec![("kind", Value::Null)],
		),
		rule(
			vec![
				with(&["place", "sea"]),
				Expr::Polygon,
				with(&["name:en\nCaspian Sea\nRed Sea\nPersian Gulf\nSea of Oman\nGulf of Aden\nGulf of Thailand\nSea of Japan"]),
			],
			vec![("minZoom", Value::Int(5))],
		),
		rule(
			vec![
				with(&["place", "sea"]),
				Expr::Polygon,
				with(&["name:en\nArabian Sea\nBay of Bengal\nBlack Sea"]),
			],
			vec![("minZoom", Value::Int(3))],
		),
		rule(
			vec![
				with(&["place", "sea"]),
				with(&["name:en\nNorth Sea\nBaltic Sea\nBlack Sea\nCaspian Sea"]),
			],
			vec![("nameOverride", from_tag("name:en"))],
		),
		rule(
			vec![with(&["place", "sea"]), Expr::Point],
			vec![("kind", s("sea")), ("minZoom", Value::Int(6))],
		),
		rule(
			vec![
				with(&["place", "sea"]),
				Expr::Point,
				with(&[
					"name:en\nNorth Atlantic Ocean\nSouth Atlantic Ocean\nCaribbean Sea\nGulf of Mexico\nMediterranean Sea\nNorth \
					 Sea\nPhilippine Sea\nTasman Sea\nFiji Sea\nSouth China Sea\nNorth Pacific Ocean\nSouth Pacific \
					 Ocean\nScotia Sea\nWeddell Sea\nIndian Ocean\nBering Sea\nGulf of Alaska\nGulf of Guinea",
				]),
			],
			vec![("minZoom", Value::Int(3))],
		),
		rule(
			vec![with(&["place", "ocean"])],
			vec![("kind", s("ocean")), ("minZoom", Value::Int(0))],
		),
	])
});

static NE_INDEX: LazyLock<Index> = LazyLock::new(|| {
	let from_min_zoom = || ("minZoom", from_tag("min_zoom"));
	Index::new(vec![
		rule(
			vec![with(&["featurecla", "Ocean"])],
			vec![from_min_zoom(), ("kind", s("ocean"))],
		),
		rule(
			vec![with(&["featurecla", "Playa"])],
			vec![from_min_zoom(), ("kind", s("playa"))],
		),
		rule(
			vec![with(&["featurecla", "Reservoir"])],
			vec![from_min_zoom(), ("kind", s("lake"))],
		),
		rule(
			vec![with(&["featurecla", "Lake"])],
			vec![from_min_zoom(), ("kind", s("lake"))],
		),
		rule(
			vec![with(&["featurecla", "Alkaline Lake"])],
			vec![from_min_zoom(), ("kind", s("lake"))],
		),
		rule(
			vec![crate::expr::without(&[
				"_source_layer\nne_50m_ocean\nne_50m_lakes\nne_10m_ocean\nne_10m_lakes",
			])],
			vec![("kind", Value::Null)],
		),
	])
});

/// `Water.processPreparedOsm`: an ocean polygon from the prepared OpenStreetMap water polygons, from zoom 6.
pub fn process_prepared_osm(
	input: &Input<'_>,
	layer: u32,
	features: &mut Vec<crate::Emitted>,
	config: crate::CollectorConfig,
) {
	let mut collector = Collector::new(input, config);
	collector
		.polygon(layer)
		.set_id(1)
		.set_attr("kind", "ocean")
		.set_attr("sort_rank", 200)
		.set_pixel_tolerance(PIXEL_TOLERANCE)
		.set_min_zoom(6)
		.set_buffer_pixels(8.0);
	features.extend(collector.finish());
}

/// `Water.processNe`: Natural Earth oceans and lakes, the 50m themes at zooms 0 to 4 and the 10m themes at zoom 5.
pub fn process_ne(
	input: &mut Input<'_>,
	layer: u32,
	features: &mut Vec<crate::Emitted>,
	config: crate::CollectorConfig,
) {
	let source_layer = input.source.source_layer;
	input.set_tag("_source_layer", Some(source_layer.to_owned()));
	let matches = NE_INDEX.matches(input);
	if matches.is_empty() {
		return;
	}
	let Some(kind) = get_string(input, &matches, "kind", None) else {
		return;
	};
	let min_zoom_text = get_string(input, &matches, "minZoom", None);
	let Some(min_zoom_text) = min_zoom_text.filter(|_| input.can_be_polygon()) else {
		return;
	};
	let Ok(min_zoom) = min_zoom_text.trim().parse::<f64>() else {
		return;
	};
	let min_zoom = hrt_render::geom::java_round(min_zoom) as i32;
	let fifty = source_layer.contains("_50m_");
	let (theme_min, theme_max) = if fifty { (0, 4) } else { (5, 5) };
	let input = &*input;
	let mut collector = Collector::new(input, config);
	collector
		.polygon(layer)
		.set_attr("kind", kind.as_str())
		.set_attr("sort_rank", 200)
		.set_pixel_tolerance(PIXEL_TOLERANCE)
		.set_zoom_range(theme_min.max(min_zoom), theme_max)
		.set_min_pixel_size(1.0)
		.set_buffer_pixels(8.0);
	features.extend(collector.finish());
}

/// `Water.processOsm`: emits the layer's features for one OpenStreetMap feature into `features`.
pub fn process_osm(
	input: &mut Input<'_>,
	layer: u32,
	features: &mut Vec<crate::Emitted>,
	config: crate::CollectorConfig,
) {
	let matches = OSM_INDEX.matches(input);
	if matches.is_empty() {
		return;
	}
	let Some(kind) = get_string(input, &matches, "kind", None) else {
		return;
	};
	let name_override = get_string(input, &matches, "nameOverride", None);
	let kind_detail = get_string(input, &matches, "kindDetail", None);
	let keep_polygon = get_boolean(input, &matches, "keepPolygon", Some(true)).unwrap_or(true);
	let line_min_zoom = get_integer(input, &matches, "minZoom", Some(12)).unwrap_or(12);
	let point_min_zoom = get_integer(input, &matches, "minZoom", Some(15)).unwrap_or(15);
	let explicit_min_zoom = get_integer(input, &matches, "minZoom", None);
	if let Some(name) = name_override {
		input.set_tag("name", Some(name));
	}
	let input = &*input;
	let extra_attr_min_zoom = 14;
	let mut collector = Collector::new(input, config);

	if input.can_be_polygon() && keep_polygon {
		collector
			.polygon(layer)
			.set_attr("kind", kind.as_str())
			.set_attr("kind_detail", kind_detail.clone())
			.set_attr("sort_rank", 200)
			.set_attr_with_min_zoom("bridge", input.tag("bridge"), extra_attr_min_zoom)
			.set_attr_with_min_zoom("tunnel", input.tag("tunnel"), extra_attr_min_zoom)
			.set_attr_with_min_zoom("layer", parse_int_or_null(input.tag("layer")), extra_attr_min_zoom)
			.set_pixel_tolerance(PIXEL_TOLERANCE)
			.set_min_zoom(6)
			.set_min_pixel_size(1.0)
			.set_buffer_pixels(8.0);
	}

	if input.can_be_line() && !input.can_be_polygon() {
		let feature = collector
			.line(layer)
			.set_id(feature_id(input.source))
			.set_attr("kind", kind.as_str())
			.set_attr("min_zoom", line_min_zoom + 1)
			.set_attr_with_min_zoom("layer", parse_int_or_null(input.tag("layer")), extra_attr_min_zoom)
			.set_attr("sort_rank", 200)
			.set_sort_key(line_min_zoom)
			.set_min_pixel_size(0.0)
			.set_pixel_tolerance(0.0)
			.set_min_zoom(line_min_zoom);
		set_osm_names(feature, input, 0);
	}

	if input.is_point() {
		let feature = collector
			.point(layer)
			.set_id(feature_id(input.source))
			.set_attr("kind", kind.as_str())
			.set_attr("min_zoom", point_min_zoom + 1)
			.set_sort_key(point_min_zoom)
			.set_min_zoom(point_min_zoom);
		set_osm_names(feature, input, 0);
	}

	if input.has_tag("name") && input.can_be_polygon() {
		let way_area = collector.source_area() / world_area_for_70k_square_meters();
		let mut name_min_zoom = 15;
		for zoom in 6..15 {
			if way_area > 4f64.powf(15.0 - f64::from(zoom)) {
				name_min_zoom = zoom;
				break;
			}
		}
		let name_min_zoom = explicit_min_zoom.unwrap_or(name_min_zoom);
		let feature = collector
			.point_on_surface(layer)
			.set_attr("kind", kind.as_str())
			.set_attr("kind_detail", kind_detail)
			.set_attr("min_zoom", name_min_zoom + 1)
			.set_min_zoom(name_min_zoom)
			.set_attr("sort_rank", 200)
			.set_sort_key(name_min_zoom)
			.set_buffer_pixels(128.0);
		set_osm_names(feature, input, 0);
	}

	features.extend(collector.finish());
}

/// `Water.postProcess`: lines merged end to end, then nearby polygons unioned.
pub fn post_process(features: Vec<TileFeature>, counts: &mut SnapCounts) -> Vec<TileFeature> {
	let features = merge_line_strings(features, 0.5, PIXEL_TOLERANCE, 4.0, false);
	merge_nearby_polygons(features, MIN_AREA, MIN_AREA, 0.5, BUFFER, counts)
}

/// The OpenStreetMap cases of the fork's `WaterTest`, under the same names.
#[cfg(test)]
mod tests {
	use hrt_e::Value as Attr;
	use hrt_osm::{ElementKind, Geometry, NodeStore, SourceFeature, Tags};

	use super::*;
	use crate::{CollectorConfig, Emitted};

	fn process(geometry: Geometry, tags: &[(&str, &str)]) -> Vec<Emitted> {
		let tags = Tags(tags.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
		let nodes = NodeStore::default();
		let source = SourceFeature::fixed(0, ElementKind::Other, ("osm", ""), &tags, geometry, &nodes);
		let mut input = Input::new(&source);
		let mut out = Vec::new();
		process_osm(&mut input, 0, &mut out, CollectorConfig::new(15));
		out
	}

	fn square() -> Geometry {
		Geometry::Polygon(geo::Polygon::new(
			geo::LineString::from(vec![(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]),
			vec![],
		))
	}

	fn assert_kinds(zoom: u8, expected: &[&str], actual: &[Emitted]) {
		assert_eq!(actual.len(), expected.len(), "feature count: {actual:?}");
		for (kind, emitted) in expected.iter().zip(actual) {
			let attributes = emitted.attributes_at(zoom);
			assert!(
				attributes.contains(&("kind".to_owned(), Attr::String((*kind).to_owned()))),
				"expected kind {kind} at z{zoom}, got {attributes:?}"
			);
		}
	}

	#[test]
	fn prepared_osm() {
		let tags = Tags::default();
		let nodes = NodeStore::default();
		let source = SourceFeature::fixed(
			1,
			ElementKind::Other,
			("osm_water", "water_polygons"),
			&tags,
			square(),
			&nodes,
		);
		let input = Input::new(&source);
		let mut out = Vec::new();
		process_prepared_osm(&input, 0, &mut out, CollectorConfig::new(15));
		assert_kinds(15, &["ocean"], &out);
		assert_eq!(out[0].feature.id, 1);
	}

	#[test]
	fn simple() {
		assert_kinds(
			15,
			&["swimming_pool"],
			&process(square(), &[("leisure", "swimming_pool")]),
		);
	}

	#[test]
	fn kind_fountain() {
		assert_kinds(15, &["fountain"], &process(square(), &[("amenity", "fountain")]));
	}

	#[test]
	fn kind_river() {
		let line = Geometry::LineString(geo::LineString::from(vec![(0.0, 0.0), (1.0, 1.0)]));
		let features = process(line, &[("waterway", "river")]);
		assert_kinds(9, &["river"], &features);
		assert_eq!(features[0].feature.min_zoom, 9);
	}

	#[test]
	fn kind_dam() {
		let line = Geometry::LineString(geo::LineString::from(vec![(0.0, 0.0), (1.0, 1.0)]));
		assert_kinds(15, &[], &process(line, &[("waterway", "dam")]));
	}

	#[test]
	fn ocean_label() {
		let point = Geometry::Point(geo::Point::new(1.0, 1.0));
		let features = process(point, &[("place", "ocean"), ("name", "a")]);
		assert_kinds(12, &["ocean"], &features);
		assert_eq!(features[0].feature.min_zoom, 0);
	}
}
