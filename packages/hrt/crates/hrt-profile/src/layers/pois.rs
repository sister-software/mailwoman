// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Pois.java and feature/QrankDb.java (BSD-3-Clause, Protomaps).

//! The `pois` layer from OpenStreetMap: points and named areas classified into kinds, each placed at a zoom from its
//! kind, its area and height, or its QRank, and thinned by a label grid below zoom 15.
//!
//! The Overture places source of the Java layer is not ported here.

use std::collections::HashMap;
use std::io::{self, BufRead};
use std::path::Path;
use std::sync::LazyLock;

use hrt_render::geom::java_round;
use hrt_render::Geom;

use crate::expr::{
	at_least, computed_double_tag, from_tag, get_integer, get_string, rule, with, within_range, without, Expr, Index,
	Value,
};
use crate::names::set_osm_names;
use crate::parse::parse_double_or_null;
use crate::{feature_id, Collector, CollectorConfig, Emitted, Input};

pub const LAYER_NAME: &str = "pois";

/// QRank page-view ranks by Wikidata number, from the gzipped `qrank.csv` the fork reads; empty when none is given.
#[derive(Clone, Debug, Default)]
pub struct QrankDb(HashMap<i64, i64>);

impl QrankDb {
	/// Reads a gzipped `Entity,QRank` CSV of rows such as `Q42,1234`.
	pub fn from_gzip_csv(path: &Path) -> io::Result<Self> {
		let reader = io::BufReader::new(flate2::read::GzDecoder::new(std::fs::File::open(path)?));
		let mut ranks = HashMap::new();
		for line in reader.lines().skip(1) {
			let line = line?;
			let mut columns = line.split(',');
			let parse = |text: Option<&str>| text.and_then(|text| text.parse::<i64>().ok());
			let id = parse(columns.next().and_then(|entity| entity.get(1..)));
			let rank = parse(columns.next());
			match (id, rank) {
				(Some(id), Some(rank)) => ranks.insert(id, rank),
				_ => return Err(io::Error::other(format!("qrank row {line:?} is not Q<id>,<rank>"))),
			};
		}
		Ok(QrankDb(ranks))
	}

	/// `QrankDb.get(osmValue)`: the rank of the first Wikidata id in a `wikidata` tag, or 0.
	fn get(&self, wikidata: &str) -> i64 {
		let first = wikidata.split(';').next().unwrap_or("");
		first
			.get(1..)
			.and_then(|number| number.parse::<i64>().ok())
			.and_then(|id| self.0.get(&id).copied())
			.unwrap_or(0)
	}
}

/// The zooms a kind reaches by QRank: the first `(zoom, minimum rank)` grade the rank meets.
const QRANK_GRADING: [(&str, &[(i32, i64)]); 6] = [
	("station", &[(10, 50_000), (12, 20_000), (13, 10_000)]),
	("aerodrome", &[(10, 50_000), (12, 20_000), (13, 5_000), (14, 2_500)]),
	("park", &[(11, 20_000), (12, 10_000), (13, 5_000), (14, 2_500)]),
	("peak", &[(11, 20_000), (12, 10_000), (13, 5_000), (14, 2_500)]),
	("attraction", &[(12, 40_000), (13, 20_000), (14, 10_000)]),
	("university", &[(12, 40_000), (13, 20_000), (14, 10_000)]),
];

fn qrank_zoom(kind: &str, rank: i64) -> Option<i32> {
	let (_, grades) = QRANK_GRADING.iter().find(|(graded, _)| *graded == kind)?;
	grades
		.iter()
		.find(|(_, minimum)| rank >= *minimum)
		.map(|(zoom, _)| *zoom)
}

fn s(text: &str) -> Value {
	Value::from(text)
}

fn kind(value: Value) -> Vec<(&'static str, Value)> {
	vec![("pm:kind", value)]
}

fn min_zoom(zoom: i32) -> Vec<(&'static str, Value)> {
	vec![("pm:minzoom", Value::Int(zoom))]
}

fn or(conditions: Vec<Expr>) -> Expr {
	Expr::Or(conditions)
}

fn and(conditions: Vec<Expr>) -> Expr {
	Expr::And(conditions)
}

fn not(condition: Expr) -> Expr {
	Expr::Not(Box::new(condition))
}

fn usfs() -> Expr {
	with(&[
		"operator",
		"United States Forest Service",
		"US Forest Service",
		"U.S. Forest Service",
		"USDA Forest Service",
		"United States Department of Agriculture",
		"US National Forest Service",
		"United State Forest Service",
		"U.S. National Forest Service",
	])
}

static OSM_KINDS: LazyLock<Index> = LazyLock::new(|| {
	let from = |tag: &str| rule(vec![with(&[tag])], kind(from_tag(tag)));
	let mut rules = vec![
		// Everything is undefined at first.
		rule(
			vec![],
			vec![("pm:kind", s("pm:undefined")), ("pm:kindDetail", s("pm:undefined"))],
		),
		// An initial set of tags the layer keeps.
		rule(
			vec![or(vec![
				with(&["aeroway", "aerodrome"]),
				with(&["amenity"]),
				with(&["attraction"]),
				with(&["boundary", "national_park", "protected_area"]),
				with(&["craft"]),
				with(&["highway", "bus_stop"]),
				with(&["historic"]),
				with(&[
					"landuse",
					"cemetery",
					"recreation_ground",
					"winter_sports",
					"quarry",
					"park",
					"forest",
					"military",
					"village_green",
					"allotments",
				]),
				with(&["leisure"]),
				with(&["natural", "beach", "peak"]),
				with(&["railway", "station"]),
				with(&["shop"]),
				and(vec![with(&["tourism"]), without(&["historic", "district"])]),
			])],
			kind(s("other")),
		),
		// Boundary is the most generic, so it comes early; later rules keep nature_reserve over protected_area.
		from("boundary"),
		rule(
			vec![with(&["historic"]), without(&["historic", "yes"])],
			kind(from_tag("historic")),
		),
	];
	for tag in [
		"tourism",
		"shop",
		"highway",
		"railway",
		"natural",
		"leisure",
		"landuse",
		"aeroway",
		"craft",
		"attraction",
		"amenity",
	] {
		rules.push(from(tag));
	}
	rules.extend([
		// National forests.
		rule(
			vec![or(vec![
				with(&["landuse", "forest"]),
				and(vec![with(&["boundary", "national_park"]), usfs()]),
				and(vec![
					with(&["boundary", "national_park"]),
					with(&["protect_class", "6"]),
					with(&["protection_title", "National Forest"]),
				]),
				and(vec![
					with(&["boundary", "protected_area"]),
					with(&["protect_class", "6"]),
					usfs(),
				]),
			])],
			kind(s("forest")),
		),
		// National parks.
		rule(vec![with(&["boundary", "national_park"])], kind(s("park"))),
		rule(
			vec![
				with(&["boundary", "national_park"]),
				not(usfs()),
				without(&[
					"protection_title",
					"Conservation Area",
					"Conservation Park",
					"Environmental use",
					"Forest Reserve",
					"National Forest",
					"National Wildlife Refuge",
					"Nature Refuge",
					"Nature Reserve",
					"Protected Site",
					"Provincial Park",
					"Public Access Land",
					"Regional Reserve",
					"Resources Reserve",
					"State Forest",
					"State Game Land",
					"State Park",
					"Watershed Recreation Unit",
					"Wild Forest",
					"Wilderness Area",
					"Wilderness Study Area",
					"Wildlife Management",
					"Wildlife Management Area",
					"Wildlife Sanctuary",
				]),
				or(vec![
					with(&["protect_class", "2", "3"]),
					with(&[
						"operator",
						"United States National Park Service",
						"National Park Service",
						"US National Park Service",
						"U.S. National Park Service",
						"US National Park service",
					]),
					with(&["operator:en", "Parks Canada"]),
					with(&["designation", "national_park"]),
					with(&["protection_title", "National Park"]),
				]),
			],
			kind(s("national_park")),
		),
		// Remaining kinds.
		rule(vec![with(&["natural", "peak"])], kind(from_tag("natural"))),
		rule(vec![with(&["highway", "bus_stop"])], kind(from_tag("highway"))),
		rule(
			vec![with(&["tourism", "attraction", "camp_site", "hotel"])],
			kind(from_tag("tourism")),
		),
		rule(vec![with(&["shop", "grocery", "supermarket"])], kind(from_tag("shop"))),
		rule(
			vec![with(&["leisure", "golf_course", "marina", "stadium", "park"])],
			kind(from_tag("leisure")),
		),
		rule(vec![with(&["landuse", "military"])], kind(s("military"))),
		rule(
			vec![
				with(&["landuse", "military"]),
				with(&["military", "naval_base", "airfield"]),
			],
			kind(from_tag("military")),
		),
		rule(vec![with(&["landuse", "cemetery"])], kind(from_tag("landuse"))),
		rule(
			vec![with(&["aeroway", "aerodrome"])],
			vec![("pm:kind", s("aerodrome")), ("pm:kindDetail", from_tag("aerodrome"))],
		),
		// Details for some classes of POI.
		rule(vec![with(&["sport"])], vec![("pm:kindDetail", from_tag("sport"))]),
		rule(vec![with(&["religion"])], vec![("pm:kindDetail", from_tag("religion"))]),
		rule(vec![with(&["cuisine"])], vec![("pm:kindDetail", from_tag("cuisine"))]),
	]);
	Index::new(rules)
});

fn pm_kind(values: &[&str]) -> Expr {
	let mut arguments = vec!["pm:kind"];
	arguments.extend_from_slice(values);
	with(&arguments)
}

static POINT_ZOOMS: LazyLock<Index> = LazyLock::new(|| {
	Index::new(vec![
		// Every point is zoom 15 at first.
		rule(vec![], min_zoom(15)),
		rule(
			vec![or(vec![
				pm_kind(&["university", "college"]),
				pm_kind(&["cemetery"]),
				pm_kind(&["park"]),
				pm_kind(&["grocery", "supermarket"]),
			])],
			min_zoom(14),
		),
		rule(
			vec![or(vec![
				pm_kind(&["aerodrome"]),
				pm_kind(&["library", "post_office", "townhall"]),
				pm_kind(&["golf_course", "marina", "stadium"]),
				pm_kind(&["peak"]),
			])],
			min_zoom(13),
		),
		rule(vec![pm_kind(&["hospital"])], min_zoom(12)),
		rule(vec![pm_kind(&["national_park"])], min_zoom(11)),
		// Large international airports earlier.
		rule(
			vec![pm_kind(&["aerodrome"]), pm_kind(&["aerodrome"]), with(&["iata"])],
			min_zoom(11),
		),
		// Some unimportant point kinds much later.
		rule(vec![pm_kind(&["bus_stop"])], min_zoom(17)),
		rule(
			vec![or(vec![
				pm_kind(&[
					"clinic",
					"dentist",
					"doctors",
					"social_facility",
					"baby_hatch",
					"childcare",
					"car_sharing",
					"bureau_de_change",
					"emergency_phone",
					"karaoke",
					"karaoke_box",
					"money_transfer",
					"car_wash",
					"hunting_stand",
					"studio",
					"boat_storage",
					"gambling",
					"adult_gaming_centre",
					"sanitary_dump_station",
					"animal",
					"roller_coaster",
					"summer_toboggan",
					"carousel",
					"amusement_ride",
					"maze",
				]),
				pm_kind(&["memorial", "district"]),
				pm_kind(&["pitch", "playground", "slipway"]),
				pm_kind(&[
					"scuba_diving",
					"atv",
					"motorcycle",
					"snowmobile",
					"art",
					"bakery",
					"beauty",
					"bookmaker",
					"books",
					"butcher",
					"car",
					"car_parts",
					"car_repair",
					"clothes",
					"computer",
					"convenience",
					"fashion",
					"florist",
					"garden_centre",
					"gift",
					"golf",
					"greengrocer",
					"grocery",
					"hairdresser",
					"hifi",
					"jewelry",
					"lottery",
					"mobile_phone",
					"newsagent",
					"optician",
					"perfumery",
					"ship_chandler",
					"stationery",
					"tobacco",
					"travel_agency",
				]),
				pm_kind(&[
					"artwork",
					"hanami",
					"trail_riding_station",
					"bed_and_breakfast",
					"chalet",
					"guest_house",
					"hostel",
				]),
			])],
			min_zoom(16),
		),
		// Some unnamed point kinds much later.
		rule(
			vec![
				without(&["name"]),
				or(vec![
					pm_kind(&[
						"atm",
						"bbq",
						"bench",
						"bicycle_parking",
						"bicycle_rental",
						"bicycle_repair_station",
						"boat_storage",
						"bureau_de_change",
						"car_rental",
						"car_sharing",
						"car_wash",
						"charging_station",
						"customs",
						"drinking_water",
						"fuel",
						"harbourmaster",
						"hunting_stand",
						"karaoke_box",
						"life_ring",
						"money_transfer",
						"motorcycle_parking",
						"parking",
						"picnic_table",
						"post_box",
						"ranger_station",
						"recycling",
						"sanitary_dump_station",
						"shelter",
						"shower",
						"taxi",
						"telephone",
						"toilets",
						"waste_basket",
						"waste_disposal",
						"water_point",
						"watering_place",
						"bicycle_rental",
						"motorcycle_parking",
						"charging_station",
					]),
					pm_kind(&["landmark", "wayside_cross"]),
					pm_kind(&[
						"dog_park",
						"firepit",
						"fishing",
						"pitch",
						"playground",
						"slipway",
						"swimming_area",
					]),
					pm_kind(&[
						"alpine_hut",
						"information",
						"picnic_site",
						"viewpoint",
						"wilderness_hut",
					]),
				]),
			],
			min_zoom(16),
		),
	])
});

/// Area-graded rules for one kind group: `(lower, upper, zoom)` ranges of `pm:wayarea`, the last open above.
fn graded(kinds: &[&str], ranges: &[(f64, f64, i32)], above: (f64, i32)) -> Vec<crate::expr::Rule> {
	let mut rules: Vec<crate::expr::Rule> = ranges
		.iter()
		.map(|&(lower, upper, zoom)| {
			rule(
				vec![pm_kind(kinds), within_range("pm:wayarea", lower as i64, upper as i64)],
				min_zoom(zoom),
			)
		})
		.collect();
	rules.push(rule(
		vec![pm_kind(kinds), at_least("pm:wayarea", above.0 as i64)],
		min_zoom(above.1),
	));
	rules
}

static NAMED_POLYGON_ZOOMS: LazyLock<Index> = LazyLock::new(|| {
	let area = |lower: f64, upper: f64| within_range("pm:wayarea", lower as i64, upper as i64);
	let height = |lower: f64, upper: f64| within_range("pm:height", lower as i64, upper as i64);
	let mut rules = vec![
		// Every named polygon is zoom 15 at first.
		rule(vec![], min_zoom(15)),
		// Size-graded polygons, generic first, then per-kind adjustments.
		rule(vec![area(10.0, 500.0)], min_zoom(14)),
		rule(vec![area(500.0, 2000.0)], min_zoom(13)),
		rule(vec![area(2000.0, 1e4)], min_zoom(12)),
		rule(vec![at_least("pm:wayarea", 1e4 as i64)], min_zoom(11)),
		rule(vec![pm_kind(&["playground"])], min_zoom(17)),
		rule(vec![pm_kind(&["allotments"]), area(0.0, 10.0)], min_zoom(16)),
		rule(vec![pm_kind(&["allotments"]), at_least("pm:wayarea", 10)], min_zoom(15)),
		// Small but tall features have regional prominence, so they show early. Heights are in meters.
		rule(vec![area(10.0, 2000.0), height(10.0, 20.0)], min_zoom(13)),
		rule(vec![area(10.0, 2000.0), height(20.0, 100.0)], min_zoom(12)),
		rule(vec![area(10.0, 2000.0), at_least("pm:height", 100)], min_zoom(11)),
		// Medium tall buildings of these kinds stay later, so they do not crowd downtowns.
		rule(
			vec![
				pm_kind(&[
					"hotel",
					"hostel",
					"parking",
					"bank",
					"place_of_worship",
					"jewelry",
					"yes",
					"restaurant",
					"coworking_space",
					"clothes",
					"art",
					"school",
				]),
				area(10.0, 2000.0),
				height(20.0, 100.0),
			],
			min_zoom(13),
		),
		// Tall self-storage buildings.
		rule(vec![pm_kind(&["storage_rental"]), area(10.0, 2000.0)], min_zoom(14)),
		// Tall university buildings need a university area to show early.
		rule(vec![pm_kind(&["university"]), area(10.0, 2000.0)], min_zoom(13)),
	];
	// Schools and cemeteries.
	rules.extend(graded(
		&["cemetery", "school"],
		&[
			(0.0, 10.0, 16),
			(10.0, 100.0, 15),
			(100.0, 1000.0, 14),
			(1000.0, 5000.0, 13),
		],
		(5000.0, 12),
	));
	// National parks.
	rules.extend(graded(
		&["national_park"],
		&[
			(0.0, 250.0, 17),
			(250.0, 1000.0, 14),
			(1000.0, 5000.0, 13),
			(5000.0, 2e4, 12),
			(2e4, 1e5, 11),
			(1e5, 2.5e5, 10),
			(2.5e5, 2e6, 9),
			(2e6, 1e7, 8),
			(1e7, 2.5e7, 7),
			(2.5e7, 3e8, 6),
		],
		(3e8, 5),
	));
	// College and university areas.
	rules.extend(graded(
		&["college", "university"],
		&[
			(0.0, 5000.0, 15),
			(5000.0, 2e4, 14),
			(2e4, 5e4, 13),
			(5e4, 1e5, 12),
			(1e5, 1.5e5, 11),
			(1.5e5, 2.5e5, 10),
			(2.5e5, 5e6, 9),
			(5e6, 2e7, 8),
		],
		(2e7, 7),
	));
	// The fork's exception for one San Francisco university.
	rules.push(rule(
		vec![
			pm_kind(&["college", "university"]),
			with(&["name", "Academy of Art University"]),
		],
		min_zoom(14),
	));
	// Big green areas.
	rules.extend(graded(
		&["forest", "park", "protected_area", "nature_reserve", "village_green"],
		&[
			(0.0, 1.0, 17),
			(1.0, 10.0, 16),
			(10.0, 250.0, 15),
			(250.0, 1000.0, 14),
			(1000.0, 5000.0, 13),
			(5000.0, 1.5e4, 12),
			(1.5e4, 2.5e5, 11),
			(2.5e5, 1e6, 10),
			(1e6, 4e6, 9),
			(4e6, 1e7, 8),
		],
		(1e7, 7),
	));
	// The remaining area-graded kinds.
	rules.extend(graded(
		&["aerodrome", "golf_course", "military", "naval_base", "stadium", "zoo"],
		&[
			(250.0, 1000.0, 14),
			(1000.0, 5000.0, 13),
			(5000.0, 2e4, 12),
			(2e4, 1e5, 11),
			(1e5, 2.5e5, 10),
			(2.5e5, 5e6, 9),
			(5e6, 2e7, 8),
		],
		(2e7, 7),
	));
	Index::new(rules)
});

static ELEVATION: LazyLock<regex::Regex> = LazyLock::new(|| {
	// Java's \d and \s are ASCII, so the classes are spelled out.
	regex::Regex::new(r"^([+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))(?:[ \t\n\x0B\x0C\r]*m)?$").unwrap()
});

/// The fork's `parseElevation`: a number of meters with an optional `m`, rounded to an integer.
fn parse_elevation(elevation: Option<&str>) -> Option<i32> {
	let trimmed = elevation?.trim_matches(|c: char| c <= ' ');
	let captures = ELEVATION.captures(trimmed)?;
	let parsed = parse_double_or_null(Some(captures.get(1)?.as_str()))?;
	i32::try_from(java_round(parsed) as i64).ok()
}

/// `Pois.processOsm`.
pub fn process_osm(
	input: &mut Input<'_>,
	layer: u32,
	qrank: &QrankDb,
	features: &mut Vec<Emitted>,
	config: CollectorConfig,
) {
	let named_polygon = input.can_be_polygon() && input.has_tag("name");
	if !input.is_point() && !named_polygon {
		return;
	}
	let kind_matches = OSM_KINDS.matches(input);
	let kind = get_string(input, &kind_matches, "pm:kind", Some("pm:undefined")).unwrap_or_default();
	let kind_detail = get_string(input, &kind_matches, "pm:kindDetail", Some("pm:undefined")).unwrap_or_default();
	if kind == "pm:undefined" {
		return;
	}

	let rank = input.tag("wikidata").map_or(0, |wikidata| qrank.get(wikidata));
	let min_zoom = match qrank_zoom(&kind, rank) {
		Some(zoom) => zoom,
		None => {
			// The fork's computeExtraTags: way area in units of 70 square meters at the equator, and height.
			let (way_area, height) = if named_polygon {
				let area = input
					.source
					.world_geometry()
					.ok()
					.and_then(|world| Geom::from(&world).envelope())
					.map_or(0.0, |[min_x, min_y, max_x, max_y]| (max_x - min_x) * (max_y - min_y));
				let height = parse_double_or_null(input.tag("height")).unwrap_or(0.0);
				(area / super::world_area_for_square_meters(70.0), height)
			} else {
				(0.0, 0.0)
			};
			input.set_tag("pm:kind", Some(kind.clone()));
			input.set_tag("pm:wayarea", Some(computed_double_tag(way_area)));
			input.set_tag("pm:height", Some(computed_double_tag(height)));
			let zooms = if named_polygon {
				&NAMED_POLYGON_ZOOMS
			} else {
				&POINT_ZOOMS
			};
			let zoom_matches = zooms.matches(input);
			let mut zoom = get_integer(input, &zoom_matches, "pm:minzoom", Some(99)).unwrap_or(99);
			for key in ["pm:kind", "pm:wayarea", "pm:height"] {
				input.set_tag(key, None);
			}
			if named_polygon {
				// The area grading resets the airport dispensation, so it is applied again here.
				if kind == "aerodrome" {
					if input.has_tag("iata") {
						zoom = (zoom - 2).max(10);
					} else {
						zoom = zoom.max(12);
					}
				}
				let name = input.tag("name").unwrap_or("");
				// Wilderness areas within US national forests and parks come later.
				if kind == "nature_reserve" && name.contains("Wilderness") {
					zoom += 1;
				}
				// Very long names show only at later zooms.
				if zoom < 14 {
					let length = name.encode_utf16().count();
					if length > 45 {
						zoom += 2;
					} else if length > 30 {
						zoom += 1;
					}
				}
			}
			zoom
		}
	};
	let input = &*input;
	let mut collector = Collector::new(input, config);
	let feature = if named_polygon {
		collector.point_on_surface(layer)
	} else {
		collector.point(layer)
	};
	feature
		.set_id(feature_id(input.source))
		.set_attr("kind", kind.as_str())
		.set_attr("min_zoom", min_zoom + 1)
		.set_buffer_pixels(8.0)
		.set_zoom_range(min_zoom.min(15), 15)
		.set_attr("iata", input.tag("iata"))
		.set_attr("elevation", parse_elevation(input.tag("ele")));
	if kind_detail != "pm:undefined" {
		feature.set_attr("kind_detail", kind_detail.as_str());
	}
	set_osm_names(feature, input, 0);
	// Points sort by zoom so a client's label collisions come presorted.
	feature
		.set_sort_key(min_zoom * 1000)
		.set_point_label_grid_size_and_limit(14, 8.0, 1);
	features.extend(collector.finish());
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn elevations_round_and_take_an_optional_meter_suffix() {
		assert_eq!(parse_elevation(Some("569")), Some(569));
		assert_eq!(parse_elevation(Some(" 569.5 m")), Some(570));
		assert_eq!(parse_elevation(Some("-2.5")), Some(-2));
		assert_eq!(parse_elevation(Some(".5m")), Some(1));
		assert_eq!(parse_elevation(Some("569 ft")), None);
		assert_eq!(parse_elevation(None), None);
	}

	#[test]
	fn qrank_grades_pick_the_first_rank_met() {
		assert_eq!(qrank_zoom("aerodrome", 60_000), Some(10));
		assert_eq!(qrank_zoom("aerodrome", 6_000), Some(13));
		assert_eq!(qrank_zoom("aerodrome", 100), None);
		assert_eq!(qrank_zoom("cafe", 1_000_000), None);
		let db = QrankDb(HashMap::from([(42, 9_000)]));
		assert_eq!(db.get("Q42;Q7"), 9_000);
		assert_eq!(db.get("bad"), 0);
	}
}
