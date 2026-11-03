// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Roads.java (BSD-3-Clause, Protomaps).

//! The `roads` layer from OpenStreetMap: highways with their kind, zoom range, route shields, names and street
//! cross-section attributes, and the non-highway lines (railways, aerialways, piers, ferries, aeroways).
//!
//! The Overture transportation source of the Java layer is not ported here.

use std::sync::LazyLock;

use hrt_e::Value as Attr;
use hrt_osm::Relation;
use hrt_render::snap::SnapCounts;
use hrt_render::Geom;

use crate::country::CountryCoder;
use crate::expr::{from_tag, get_integer, get_string, rule, with, Index, Value};
use crate::locales::{locale_for, order_shields, Shield};
use crate::merge::{decode, merge_line_strings};
use crate::names::set_osm_names;
use crate::parse::meters;
use crate::smoothing::smooth_world_line;
use crate::{feature_id, Collector, CollectorConfig, Emitted, Input, TileFeature};

pub const LAYER_NAME: &str = "roads";

fn s(text: &str) -> Value {
	Value::from(text)
}

fn i(number: i32) -> Value {
	Value::Int(number)
}

static OSM_KINDS: LazyLock<Index> = LazyLock::new(|| {
	Index::of(vec![
		rule(
			vec![],
			vec![
				("pm:kindDetail", from_tag("highway")),
				("pm:highway", from_tag("highway")),
			],
		),
		rule(vec![with(&["service"])], vec![("pm:kindDetail", from_tag("service"))]),
		rule(vec![with(&["highway", "motorway"])], vec![("pm:kind", s("highway"))]),
		rule(
			vec![with(&["highway", "motorway_link"])],
			vec![("pm:kind", s("highway"))],
		),
		rule(vec![with(&["highway", "trunk"])], vec![("pm:kind", s("major_road"))]),
		rule(
			vec![with(&["highway", "trunk_link"])],
			vec![("pm:kind", s("major_road"))],
		),
		rule(vec![with(&["highway", "primary"])], vec![("pm:kind", s("major_road"))]),
		rule(
			vec![with(&["highway", "primary_link"])],
			vec![("pm:kind", s("major_road"))],
		),
		rule(
			vec![with(&["highway", "secondary"])],
			vec![("pm:kind", s("major_road"))],
		),
		rule(
			vec![with(&["highway", "secondary_link"])],
			vec![("pm:kind", s("major_road"))],
		),
		rule(vec![with(&["highway", "tertiary"])], vec![("pm:kind", s("major_road"))]),
		rule(
			vec![with(&["highway", "tertiary_link"])],
			vec![("pm:kind", s("major_road"))],
		),
		rule(
			vec![with(&["highway", "residential", "unclassified", "road", "raceway"])],
			vec![("pm:kind", s("minor_road"))],
		),
		rule(
			vec![with(&["highway", "service"])],
			vec![("pm:kind", s("minor_road")), ("pm:kindDetail", s("service"))],
		),
		rule(
			vec![with(&["highway", "service"]), with(&["service"])],
			vec![
				("pm:kind", s("minor_road")),
				("pm:kindDetail", s("service")),
				("service", from_tag("service")),
			],
		),
		rule(
			vec![with(&["highway", "pedestrian", "track", "corridor"])],
			vec![("pm:kind", s("path"))],
		),
		rule(
			vec![with(&["highway", "path", "cycleway", "bridleway", "footway", "steps"])],
			vec![("pm:kind", s("path"))],
		),
		rule(
			vec![
				with(&["highway", "footway"]),
				with(&["footway", "sidewalk", "crossing"]),
			],
			vec![("pm:kind", s("path")), ("pm:kindDetail", from_tag("footway"))],
		),
		rule(
			vec![with(&["highway", "corridor"])],
			vec![("pm:kind", s("path")), ("pm:kindDetail", s("corridor"))],
		),
	])
});

static NON_HIGHWAYS: LazyLock<Index> = LazyLock::new(|| {
	Index::of(vec![
		rule(
			vec![with(&["railway"])],
			vec![
				("kind", s("rail")),
				("kindDetail", from_tag("railway")),
				("minZoom", i(11)),
			],
		),
		rule(vec![with(&["railway", "service"])], vec![("minZoom", i(13))]),
		rule(
			vec![with(&["railway", "service"]), with(&["service"])],
			vec![("minZoom", i(14))],
		),
		rule(
			vec![with(&[
				"railway\nfunicular\nlight_rail\nminiature\nmonorail\nnarrow_gauge\npreserved\nsubway\ntram",
			])],
			vec![("minZoom", i(14))],
		),
		rule(vec![with(&["railway", "disused"])], vec![("minZoom", i(15))]),
		rule(
			vec![with(&["railway"]), with(&["service\nyard\nsiding\ncrossover"])],
			vec![("minZoom", i(13))],
		),
		rule(
			vec![with(&["aerialway", "cable_car"])],
			vec![
				("kind", s("aerialway")),
				("kindDetail", s("cable_car")),
				("minZoom", i(11)),
			],
		),
		rule(
			vec![with(&["man_made", "pier"])],
			vec![("kind", s("path")), ("kindDetail", s("pier")), ("minZoom", i(13))],
		),
		rule(
			vec![with(&["route", "ferry"])],
			vec![("kind", s("ferry")), ("minZoom", i(11))],
		),
		rule(
			vec![with(&["aeroway", "taxiway"])],
			vec![("kind", s("aeroway")), ("kindDetail", s("taxiway")), ("minZoom", i(10))],
		),
		rule(
			vec![with(&["aeroway", "runway"])],
			vec![("kind", s("aeroway")), ("kindDetail", s("runway")), ("minZoom", i(9))],
		),
	])
});

fn zoom_uses(min: Option<i32>, name: Option<i32>, shield: Option<i32>) -> Vec<(&'static str, Value)> {
	let mut uses = Vec::new();
	if let Some(zoom) = min {
		uses.push(("pm:minzoom", i(zoom)));
	}
	if let Some(zoom) = name {
		uses.push(("pm:minzoomName", i(zoom)));
	}
	if let Some(zoom) = shield {
		uses.push(("pm:minzoomShield", i(zoom)));
	}
	uses
}

static HIGHWAY_ZOOMS: LazyLock<Index> = LazyLock::new(|| {
	let major = |highway: &str, min, name, shield| {
		rule(
			vec![with(&["pm:kind", "major_road"]), with(&["pm:highway", highway])],
			zoom_uses(Some(min), Some(name), Some(shield)),
		)
	};
	Index::new(vec![
		rule(vec![], zoom_uses(Some(14), Some(14), Some(12))),
		rule(
			vec![with(&["pm:kind", "highway"])],
			zoom_uses(Some(3), Some(11), Some(7)),
		),
		rule(
			vec![with(&["pm:kind", "highway"]), with(&["pm:highway", "motorway_link"])],
			zoom_uses(None, Some(11), Some(12)),
		),
		major("trunk", 6, 12, 8),
		major("trunk_link", 6, 12, 12),
		major("primary", 7, 12, 10),
		major("primary_link", 7, 13, 11),
		major("secondary", 9, 12, 11),
		major("secondary_link", 9, 14, 13),
		major("tertiary", 9, 13, 12),
		major("tertiary_link", 9, 14, 13),
		rule(vec![with(&["pm:kind", "minor_road"])], zoom_uses(Some(12), None, None)),
		rule(
			vec![with(&["pm:kind", "minor_road"]), with(&["pm:kindDetail", "service"])],
			zoom_uses(Some(13), None, None),
		),
		rule(vec![with(&["pm:kind", "path"])], zoom_uses(Some(12), None, None)),
		rule(
			vec![
				with(&["pm:kind", "path"]),
				with(&["pm:kindDetail", "path", "cycleway", "bridleway", "footway", "steps"]),
			],
			zoom_uses(Some(13), None, None),
		),
		rule(
			vec![
				with(&["pm:kind", "path"]),
				with(&["pm:kindDetail", "sidewalk", "crossing", "corridor"]),
			],
			zoom_uses(Some(14), None, None),
		),
		rule(vec![with(&["pm:kind", "ferry"])], zoom_uses(Some(11), None, None)),
		rule(vec![with(&["pm:kind", "rail"])], zoom_uses(Some(11), None, None)),
		rule(
			vec![
				with(&["pm:kind", "rail"]),
				with(&[
					"pm:kindDetail",
					"funicular",
					"light_rail",
					"monorail",
					"narrow_gauge",
					"subway",
					"tram",
					"unknown",
				]),
			],
			zoom_uses(Some(14), None, None),
		),
		// The fork's United States freeway grading, kept in its rule table as the Java layer keeps it.
		rule(
			vec![
				with(&["pm:country", "US"]),
				with(&["highway", "motorway", "motorway_link", "trunk", "trunk_link"]),
			],
			zoom_uses(Some(7), None, None),
		),
		rule(
			vec![with(&["pm:country", "US"]), with(&["_r_network_US:US"])],
			zoom_uses(Some(6), None, None),
		),
		rule(
			vec![with(&["pm:country", "US"]), with(&["_r_network_US:I"])],
			zoom_uses(Some(3), None, None),
		),
	])
});

/// `Roads.preprocessOsmRelation`: road route relations are kept for their network and ref.
pub fn keep_relation(relation: &Relation) -> bool {
	relation.tags.get("type") == Some("route") && relation.tags.get("route") == Some("road")
}

/// The fork's `parseLanes`: a one- or two-digit lane count from 1 to 16.
fn parse_lanes(value: Option<&str>) -> Option<i32> {
	let value = value?;
	if value.is_empty() || value.len() > 2 || !value.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	let lanes: i32 = value.parse().ok()?;
	(1..=16).contains(&lanes).then_some(lanes)
}

/// The fork's `sidewalkSides`.
fn sidewalk_sides(input: &Input<'_>) -> Option<&'static str> {
	let mut combined = input.tag("sidewalk");
	let mut both_yes = false;
	if combined.is_none() {
		combined = input.tag("sidewalk:both");
		both_yes = combined == Some("yes");
	}
	if let Some(combined) = combined {
		if both_yes {
			return Some("both");
		}
		return match combined {
			"both" => Some("both"),
			"left" => Some("left"),
			"right" => Some("right"),
			"no" => Some("no"),
			"yes" => Some("both"),
			"none" | "separate" => Some("no"),
			_ => None,
		};
	}
	let left = input.tag("sidewalk:left") == Some("yes");
	let right = input.tag("sidewalk:right") == Some("yes");
	if left && right {
		return Some("both");
	}
	if left || right {
		return Some(if left { "left" } else { "right" });
	}
	(input.has_tag("sidewalk:left") || input.has_tag("sidewalk:right")).then_some("no")
}

/// Converts a world-coordinate geometry to longitude and latitude, as Planetiler's `worldToLatLonCoords`.
fn world_to_lon_lat(geometry: &Geom) -> Geom {
	let point = |[x, y]: [f64; 2]| [x * 360.0 - 180.0, hrt_osm::coords::world_lat(y)];
	let seq = |seq: &Vec<[f64; 2]>| seq.iter().map(|&p| point(p)).collect::<Vec<_>>();
	let polygon = |p: &hrt_render::Polygon| hrt_render::Polygon {
		shell: seq(&p.shell),
		holes: p.holes.iter().map(seq).collect(),
	};
	match geometry {
		Geom::Point(p) => Geom::Point(point(*p)),
		Geom::MultiPoint(points) => Geom::MultiPoint(seq(points)),
		Geom::LineString(s) => Geom::LineString(seq(s)),
		Geom::LinearRing(s) => Geom::LinearRing(seq(s)),
		Geom::MultiLineString(lines) => Geom::MultiLineString(
			lines
				.iter()
				.map(|line| hrt_render::Line {
					seq: seq(&line.seq),
					ring: line.ring,
				})
				.collect(),
		),
		Geom::Polygon(p) => Geom::Polygon(polygon(p)),
		Geom::MultiPolygon(polygons) => Geom::MultiPolygon(polygons.iter().map(polygon).collect()),
		Geom::Collection(parts) => Geom::Collection(parts.iter().map(world_to_lon_lat).collect()),
	}
}

fn process_highways(
	input: &mut Input<'_>,
	layer: u32,
	countries: Option<&CountryCoder>,
	features: &mut Vec<Emitted>,
	config: CollectorConfig,
) {
	let Some(highway) = input.tag("highway").map(str::to_owned) else {
		return;
	};
	if input.has_tag_in(
		"highway",
		&[
			"proposed",
			"abandoned",
			"razed",
			"demolished",
			"removed",
			"construction",
			"elevator",
		],
	) {
		return;
	}

	// The country is looked up from the source's own longitude and latitude geometry.
	let code = countries.and_then(|countries| {
		let world = input.source.world_geometry().ok()?;
		countries
			.country_code(&world_to_lon_lat(&Geom::from(&world)))
			.map(str::to_owned)
	});
	if let Some(code) = &code {
		input.set_tag("pm:country", Some(code.clone()));
	}
	let locale = locale_for(code.as_deref());

	let mut relation_shields = Vec::new();
	let memberships: Vec<(Option<String>, Option<String>)> = input
		.source
		.relations
		.iter()
		.filter(|member| member.parent_path.is_empty() && keep_relation(member.relation))
		.map(|member| {
			(
				member.relation.tags.get("network").map(str::to_owned),
				member.relation.tags.get("ref").map(str::to_owned),
			)
		})
		.collect();
	for (network, reference) in memberships {
		if let Some(network) = network {
			let network = locale.normalize_network(&network);
			input.set_tag(&format!("_r_network_{network}"), Some("yes".into()));
			relation_shields.push(Shield {
				text: reference,
				network: Some(network),
			});
		}
	}
	let shields = order_shields(locale, &relation_shields);

	let matches = OSM_KINDS.matches(input);
	let kind = get_string(input, &matches, "pm:kind", Some("other")).unwrap_or_default();
	let kind_detail = get_string(input, &matches, "pm:kindDetail", Some("")).unwrap_or_default();

	input.set_tag("pm:kind", Some(kind.clone()));
	input.set_tag("pm:kindDetail", Some(kind_detail.clone()));
	input.set_tag("pm:highway", Some(highway.clone()));
	let zoom_matches = HIGHWAY_ZOOMS.matches(input);
	let mut min_zoom = get_integer(input, &zoom_matches, "pm:minzoom", Some(99)).unwrap_or(99);
	let min_zoom_shield = get_integer(input, &zoom_matches, "pm:minzoomShield", Some(99)).unwrap_or(99);
	let min_zoom_names = get_integer(input, &zoom_matches, "pm:minzoomName", Some(99)).unwrap_or(99);
	// The computed tags are visible to the zoom rules only, as on Java's SourceFeatureWithComputedTags.
	input.set_tag("pm:kind", None);
	input.set_tag("pm:kindDetail", None);
	input.set_tag("pm:highway", None);
	if input.has_tag_in("access", &["private", "no"]) {
		min_zoom = min_zoom.max(15);
	}

	let input = &*input;
	let mut collector = Collector::new(input, config);
	let line = input
		.source
		.line()
		.ok()
		.map(|line| Geom::from(&hrt_osm::Geometry::LineString(line)));
	let feature = match line {
		Some(line) => collector.geometry(layer, smooth_world_line(&line)),
		None => collector.line(layer),
	};
	feature
		.set_id(feature_id(input.source))
		.set_attr("kind", kind.as_str())
		.set_attr("min_zoom", min_zoom + 1)
		.set_attr_with_min_zoom("ref", input.tag("ref"), min_zoom_shield)
		.set_attr_with_min_zoom("oneway", input.tag("oneway"), 14)
		.set_attr_with_min_zoom("access", input.tag("access"), 15)
		.set_attr("pm:highway", highway.as_str())
		.set_attr("sort_rank", 400)
		.set_min_pixel_size(0.0)
		.set_pixel_tolerance(0.0)
		.set_min_zoom(min_zoom);
	for (index, shield) in shields.iter().enumerate() {
		feature.set_attr_with_min_zoom(
			&format!("network_{}", index + 1),
			shield.network.clone(),
			min_zoom_shield,
		);
		feature.set_attr_with_min_zoom(
			&format!("shield_text_{}", index + 1),
			shield.text.clone(),
			min_zoom_shield,
		);
	}
	if let Some(primary) = shields.first() {
		feature.set_attr_with_min_zoom("network", primary.network.clone(), min_zoom_shield);
		feature.set_attr_with_min_zoom("shield_text", primary.text.clone(), min_zoom_shield);
	}
	if !kind_detail.is_empty() {
		feature.set_attr("kind_detail", kind_detail.as_str());
	} else {
		feature.set_attr("kind_detail", highway.as_str());
	}
	if kind == "other" && input.has_tag("service") {
		feature.set_attr("service", input.tag("service"));
	}
	if input.has_tag_in(
		"highway",
		&[
			"motorway_link",
			"trunk_link",
			"primary_link",
			"secondary_link",
			"tertiary_link",
		],
	) {
		feature.set_attr("is_link", true);
	}
	if input.has_tag("bridge") && input.tag("bridge") != Some("no") {
		feature.set_attr_with_min_zoom("is_bridge", true, 12);
	} else if input.has_tag("tunnel") && input.tag("tunnel") != Some("no") {
		feature.set_attr_with_min_zoom("is_tunnel", true, 12);
	}
	for key in ["cycleway", "cycleway:both", "cycleway:left", "cycleway:right"] {
		if let Some(cycleway) = input.tag(key) {
			if cycleway != "no" && cycleway != "separate" {
				feature.set_attr_with_min_zoom("cycleway", cycleway, 14);
				break;
			}
		}
	}
	feature.set_attr_with_min_zoom("lanes", parse_lanes(input.tag("lanes")), 15);
	feature.set_attr_with_min_zoom("width", meters(input.tag("width")), 15);
	feature.set_attr_with_min_zoom("surface", input.tag("surface"), 15);
	feature.set_attr_with_min_zoom("sidewalk", sidewalk_sides(input), 15);
	if input.tag("footway") == Some("crossing") || input.tag("highway") == Some("crossing") {
		feature.set_attr_with_min_zoom("crossing", input.tag("crossing"), 15);
		feature.set_attr_with_min_zoom("crossing_markings", input.tag("crossing:markings"), 15);
	}
	feature.set_sort_key(min_zoom);
	set_osm_names(feature, input, min_zoom_names);
	features.extend(collector.finish());
}

fn process_non_highways(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	if input.has_tag("building") {
		return;
	}
	if input.has_tag_in(
		"railway",
		&[
			"abandoned",
			"razed",
			"demolished",
			"removed",
			"construction",
			"platform",
			"platform_edge",
			"proposed",
		],
	) {
		return;
	}
	let matches = NON_HIGHWAYS.matches(input);
	if matches.is_empty() {
		return;
	}
	let min_zoom = get_integer(input, &matches, "minZoom", Some(11)).unwrap_or(11);
	let kind = get_string(input, &matches, "kind", Some("other")).unwrap_or_default();
	let kind_detail = get_string(input, &matches, "kindDetail", Some("")).unwrap_or_default();

	let mut collector = Collector::new(input, config);
	let feature = collector
		.line(layer)
		.set_id(feature_id(input.source))
		.set_attr("kind", kind.as_str())
		.set_attr("min_zoom", min_zoom + 1)
		.set_attr("network", input.tag("network"))
		.set_attr("ref", input.tag("ref"))
		.set_attr("route", input.tag("route"))
		.set_attr("service", input.tag("service"))
		.set_attr("sort_rank", 400)
		.set_min_pixel_size(0.0)
		.set_pixel_tolerance(0.0)
		.set_zoom_range(min_zoom, 15);
	if !kind_detail.is_empty() {
		feature.set_attr("kind_detail", kind_detail.as_str());
	}
	if input.has_tag("bridge") && input.tag("bridge") != Some("no") {
		feature.set_attr_with_min_zoom("is_bridge", true, 12);
	} else if input.has_tag("tunnel") && input.tag("tunnel") != Some("no") {
		feature.set_attr_with_min_zoom("is_tunnel", true, 12);
	}
	if kind_detail == "pier" {
		feature.set_min_pixel_size(2.0);
	}
	feature.set_sort_key(min_zoom);
	set_osm_names(feature, input, 12);
	features.extend(collector.finish());
}

/// `Roads.processOsm`: highways, then non-highway lines, for any feature that can be a line.
pub fn process_osm(
	input: &mut Input<'_>,
	layer: u32,
	countries: Option<&CountryCoder>,
	features: &mut Vec<Emitted>,
	config: CollectorConfig,
) {
	if !input.can_be_line() {
		return;
	}
	process_highways(input, layer, countries, features, config);
	process_non_highways(input, layer, features, config);
}

/// The main road and link classes the fork's `LinkSimplify` runs on below zoom 12, in the fork's order.
const LINK_PAIRS: [(&str, &str); 4] = [
	("motorway", "motorway_link"),
	("trunk", "trunk_link"),
	("primary", "primary_link"),
	("secondary", "secondary_link"),
];

/// The fork's `LinkSimplify`, once for each `(main, link)` pair: a link line is kept only when each end touches the
/// main road's vertices or another link's end.
///
/// Each pair counts and drops only lines of its own two classes, so running the pairs one after another and running
/// them in one pass keep the same lines. The pass decodes each main or link line once.
fn link_simplify(features: Vec<TileFeature>, key: &str, pairs: &[(&str, &str)]) -> Vec<TileFeature> {
	// The vertex counts hash with FxHash. A low-zoom tile can hold millions of main-road vertices, and SipHash, the
	// standard map's hasher, takes several times longer per key.
	use rustc_hash::FxHashMap as HashMap;
	// The pair a line belongs to and whether it is that pair's link.
	let role = |feature: &TileFeature| -> Option<(usize, bool)> {
		if feature.geometry.geom_type != hrt_render::GeometryType::Line {
			return None;
		}
		feature.attributes.iter().find_map(|(k, v)| match v {
			Attr::String(value) if k == key => pairs.iter().enumerate().find_map(|(index, (main, link))| {
				if value == link {
					Some((index, true))
				} else if value == main {
					Some((index, false))
				} else {
					None
				}
			}),
			_ => None,
		})
	};
	let bits = |pair: usize, [x, y]: [f64; 2]| (pair, (x + 0.0).to_bits(), (y + 0.0).to_bits());
	let mut degrees: HashMap<(usize, u64, u64), u32> = HashMap::default();
	// A link's pair and its first and last points, which are absent for a link without points.
	type LinkEnds = (usize, Option<([f64; 2], [f64; 2])>);
	// Each feature's link ends, or `None` for a feature that is not a link.
	let mut link_ends: Vec<Option<LinkEnds>> = Vec::with_capacity(features.len());
	let mut coords = Vec::new();
	for feature in &features {
		let Some((pair, is_link)) = role(feature) else {
			link_ends.push(None);
			continue;
		};
		coords.clear();
		collect_coordinates(&decode(&feature.geometry), &mut coords);
		if is_link {
			let ends = coords.first().zip(coords.last()).map(|(&first, &last)| (first, last));
			if let Some((first, last)) = ends {
				*degrees.entry(bits(pair, first)).or_default() += 1;
				*degrees.entry(bits(pair, last)).or_default() += 1;
			}
			link_ends.push(Some((pair, ends)));
		} else {
			for &point in &coords {
				*degrees.entry(bits(pair, point)).or_default() += 1;
			}
			link_ends.push(None);
		}
	}
	features
		.into_iter()
		.zip(link_ends)
		.filter(|(_, ends)| match ends {
			None => true,
			Some((pair, Some((first, last)))) => {
				degrees[&bits(*pair, *first)] >= 2 && degrees[&bits(*pair, *last)] >= 2
			}
			Some((_, None)) => false,
		})
		.map(|(feature, _)| feature)
		.collect()
}

fn collect_coordinates(geom: &Geom, out: &mut Vec<[f64; 2]>) {
	match geom {
		Geom::Point(point) => out.push(*point),
		Geom::MultiPoint(points) => out.extend(points),
		Geom::LineString(seq) | Geom::LinearRing(seq) => out.extend(seq),
		Geom::MultiLineString(lines) => lines.iter().for_each(|line| out.extend(&line.seq)),
		Geom::Polygon(polygon) => {
			out.extend(&polygon.shell);
			polygon.holes.iter().for_each(|hole| out.extend(hole));
		}
		Geom::MultiPolygon(polygons) => polygons
			.iter()
			.for_each(|polygon| collect_coordinates(&Geom::Polygon(polygon.clone()), out)),
		Geom::Collection(parts) => parts.iter().for_each(|part| collect_coordinates(part, out)),
	}
}

/// `Roads.postProcess`: below zoom 12 off-ramps that do not connect are dropped, the temporary `pm:highway` attribute
/// is removed, and lines with equal attributes are merged.
pub fn post_process(zoom: u8, mut features: Vec<TileFeature>, _counts: &mut SnapCounts) -> Vec<TileFeature> {
	if zoom < 12 {
		features = link_simplify(features, "pm:highway", &LINK_PAIRS);
	}
	for feature in &mut features {
		feature.attributes.retain(|(key, _)| key != "pm:highway");
	}
	merge_line_strings(features, 0.5, 0.1, 4.0, false)
}

#[cfg(test)]
mod tests {
	use hrt_osm::{ElementKind, Geometry, Member, NodeStore, RelationMember, SourceFeature, Tags};

	use super::*;

	/// A border polygon around Colorado, standing in for the fork's `borders.json` United States feature.
	const COLORADO: &str = r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"iso1A2":"US"},
		"geometry":{"type":"MultiPolygon","coordinates":[[[[-109,37],[-102,37],[-102,41],[-109,41],[-109,37]]]]}}]}"#;

	fn tags(pairs: &[(&str, &str)]) -> Tags {
		Tags(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
	}

	/// Runs the layer on a line from (lon0, lat0) to (lon1, lat1) belonging to one road route relation per
	/// `(network, ref)` pair, as RoadsTest's `processWithRelationAndCoords` does.
	fn process(
		line: [f64; 4],
		way_tags: &[(&str, &str)],
		routes: &[(&str, Option<&str>)],
		countries: Option<&CountryCoder>,
	) -> Vec<Emitted> {
		use hrt_osm::coords::{world_x, world_y};
		let way_tags = tags(way_tags);
		let relations: Vec<Relation> = routes
			.iter()
			.enumerate()
			.map(|(index, (network, reference))| {
				let mut pairs = vec![("type", "route"), ("route", "road"), ("network", *network)];
				if let Some(reference) = reference {
					pairs.push(("ref", reference));
				}
				Relation {
					id: 10 + index as i64,
					tags: tags(&pairs),
					members: vec![Member {
						kind: ElementKind::Way,
						id: 2,
						role: "role".into(),
					}],
				}
			})
			.collect();
		let nodes = NodeStore::default();
		let geometry = Geometry::LineString(hrt_osm::LineString::from(vec![
			(world_x(line[0]), world_y(line[1])),
			(world_x(line[2]), world_y(line[3])),
		]));
		let mut source = SourceFeature::fixed(2, ElementKind::Way, ("osm", ""), &way_tags, geometry, &nodes);
		source.relations = relations
			.iter()
			.map(|relation| RelationMember {
				role: "role",
				relation,
				parent_path: Vec::new(),
			})
			.collect();
		let mut input = Input::new(&source);
		let mut out = Vec::new();
		process_osm(&mut input, 0, countries, &mut out, CollectorConfig::new(15));
		out
	}

	fn attr(emitted: &Emitted, key: &str) -> Option<Attr> {
		emitted
			.attributes_at(15)
			.into_iter()
			.find(|(k, _)| k == key)
			.map(|(_, value)| value)
	}

	fn text(value: &str) -> Option<Attr> {
		Some(Attr::String(value.to_owned()))
	}

	const DENVER_TO_BOULDER: [f64; 4] = [-104.97235, 39.73867, -105.260503, 40.010771];

	/// One RoadsTest arm: the route relations, the line, and the expected minimum zoom.
	type Arm<'a> = (&'a [(&'a str, Option<&'a str>)], [f64; 4], u8);

	#[test]
	fn highways_get_their_kind_and_zoom_by_country_and_route() {
		let countries = CountryCoder::from_geojson(COLORADO).unwrap();
		// RoadsTest.testHighways: highway, kind, kind_detail, generic minimum zoom, United States minimum zoom.
		let cases = [
			("motorway", "highway", 3, 7),
			("motorway_link", "highway", 3, 7),
			("trunk", "major_road", 6, 7),
			("trunk_link", "major_road", 6, 7),
			("primary", "major_road", 7, 7),
			("primary_link", "major_road", 7, 7),
			("secondary", "major_road", 9, 9),
			("secondary_link", "major_road", 9, 9),
			("tertiary", "major_road", 9, 9),
			("tertiary_link", "major_road", 9, 9),
			("residential", "minor_road", 12, 12),
			("service", "minor_road", 13, 13),
			("unclassified", "minor_road", 12, 12),
			("road", "minor_road", 12, 12),
			("raceway", "minor_road", 12, 12),
			("pedestrian", "path", 12, 12),
			("track", "path", 12, 12),
			("path", "path", 13, 13),
			("cycleway", "path", 13, 13),
			("bridleway", "path", 13, 13),
			("footway", "path", 13, 13),
			("steps", "path", 13, 13),
			("corridor", "path", 14, 14),
		];
		for (highway, kind, generic, us) in cases {
			let way = [("highway", highway)];
			let arms: [Arm; 4] = [
				(&[], [0.0, 0.0, 1.0, 1.0], generic),
				(&[("", None)], DENVER_TO_BOULDER, us),
				(&[("US:US", None)], DENVER_TO_BOULDER, 6),
				(&[("US:I", None)], DENVER_TO_BOULDER, 3),
			];
			for (routes, line, min_zoom) in arms {
				let out = process(line, &way, routes, Some(&countries));
				assert_eq!(out.len(), 1, "{highway} {routes:?}");
				assert_eq!(attr(&out[0], "kind"), text(kind), "{highway}");
				assert_eq!(attr(&out[0], "kind_detail"), text(highway), "{highway}");
				assert_eq!(out[0].feature.min_zoom, min_zoom, "{highway} {routes:?}");
			}
		}
	}

	#[test]
	fn excluded_and_unknown_highways() {
		for highway in [
			"proposed",
			"abandoned",
			"razed",
			"demolished",
			"removed",
			"construction",
			"elevator",
		] {
			assert!(process([0.0, 0.0, 1.0, 1.0], &[("highway", highway)], &[], None).is_empty());
		}
		let out = process([0.0, 0.0, 1.0, 1.0], &[("highway", "a"), ("service", "b")], &[], None);
		assert_eq!(attr(&out[0], "kind"), text("other"));
		assert_eq!(attr(&out[0], "kind_detail"), text("b"));
		assert_eq!(attr(&out[0], "service"), text("b"));
		assert_eq!(out[0].feature.min_zoom, 14);
	}

	#[test]
	fn us_shields_order_by_network_and_normalize_carriageways() {
		let countries = CountryCoder::from_geojson(COLORADO).unwrap();
		let out = process(
			DENVER_TO_BOULDER,
			&[("highway", "motorway")],
			&[
				("US:CO", Some("93")),
				("US:I:Express", Some("25")),
				("US:US", Some("36")),
			],
			Some(&countries),
		);
		assert_eq!(attr(&out[0], "network"), text("US:I"));
		assert_eq!(attr(&out[0], "shield_text"), text("25"));
		assert_eq!(attr(&out[0], "network_2"), text("US:US"));
		assert_eq!(attr(&out[0], "network_3"), text("US:CO"));
	}

	#[test]
	fn railways_and_sidewalks() {
		let out = process([0.0, 0.0, 1.0, 1.0], &[("railway", "a")], &[], None);
		assert_eq!(attr(&out[0], "kind"), text("rail"));
		assert_eq!(attr(&out[0], "kind_detail"), text("a"));
		assert_eq!(out[0].feature.min_zoom, 11);

		let out = process(
			[0.0, 0.0, 1.0, 1.0],
			&[("highway", "footway"), ("footway", "sidewalk")],
			&[],
			None,
		);
		assert_eq!(attr(&out[0], "kind_detail"), text("sidewalk"));
		assert_eq!(out[0].feature.min_zoom, 14);

		let out = process(
			[0.0, 0.0, 1.0, 1.0],
			&[
				("highway", "residential"),
				("sidewalk:left", "yes"),
				("lanes", "17"),
				("width", "7 m"),
			],
			&[],
			None,
		);
		assert_eq!(attr(&out[0], "sidewalk"), text("left"));
		assert_eq!(attr(&out[0], "lanes"), None);
		assert_eq!(attr(&out[0], "width"), Some(Attr::Double(7.0)));
	}
}
