// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Places.java (BSD-3-Clause, Protomaps).

//! The `places` layer from OpenStreetMap: country, region, locality and neighborhood points with their zoom range,
//! population rank, and a sort key that orders labels for the label grid.
//!
//! The Overture divisions source of the Java layer is not ported here.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::LazyLock;

use crate::builder::ZoomThresholds;
use crate::country::CountryCoder;
use crate::expr::{at_least, from_tag, get_integer, get_string, rule, with, without, Index, Value};
use crate::names::{set_osm_names, set_osm_refs};
use crate::sort_key::SortKey;
use crate::{feature_id, Collector, CollectorConfig, Emitted, Input};

pub const LAYER_NAME: &str = "places";

/// Population thresholds for the population rank, which counts the thresholds a population reaches.
const POPULATION_BREAKS: [i64; 18] = [
	0,
	200,
	1_000,
	2_000,
	5_000,
	10_000,
	20_000,
	50_000,
	100_000,
	200_000,
	500_000,
	1_000_000,
	5_000_000,
	10_000_000,
	20_000_000,
	50_000_000,
	100_000_000,
	1_000_000_000,
];

/// The countries whose states and provinces are labeled as regions.
const REGION_COUNTRIES: &str = "pm:country\nUS\nCA\nBR\nIN\nCN\nAU";

fn uses(pairs: &[(&'static str, Value)]) -> Vec<(&'static str, Value)> {
	pairs.to_vec()
}

fn s(text: &str) -> Value {
	Value::from(text)
}

fn i(number: i32) -> Value {
	Value::Int(number)
}

static OSM_KINDS: LazyLock<Index> = LazyLock::new(|| {
	let place = |values: &[&str]| {
		let mut arguments = vec!["place"];
		arguments.extend_from_slice(values);
		with(&arguments)
	};
	let locality_with_fallback = |value: &str, kind_detail: bool, fallback: i32| {
		let mut kind = vec![("pm:kind", s("locality"))];
		if kind_detail {
			kind.push(("pm:kindDetail", from_tag("place")));
		}
		[
			rule(vec![place(&[value])], kind),
			rule(
				vec![place(&[value]), without(&["population"])],
				uses(&[("pm:populationFallback", i(fallback))]),
			),
		]
	};
	let mut rules = vec![
		rule(vec![], uses(&[("pm:kind", s("pm:undefined"))])),
		rule(
			vec![with(&["population"])],
			uses(&[("pm:population", from_tag("population"))]),
		),
		rule(vec![place(&["country"])], uses(&[("pm:kind", s("country"))])),
		rule(
			vec![place(&["state", "province"]), with(&[REGION_COUNTRIES])],
			uses(&[("pm:kind", s("region"))]),
		),
		rule(
			vec![place(&["city", "town"])],
			uses(&[("pm:kind", s("locality")), ("pm:kindDetail", from_tag("place"))]),
		),
		rule(
			vec![place(&["city"]), without(&["population"])],
			uses(&[("pm:populationFallback", i(5_000))]),
		),
		rule(
			vec![place(&["town"]), without(&["population"])],
			uses(&[("pm:populationFallback", i(10_000))]),
		),
		// Neighborhood-scale places.
		rule(
			vec![place(&["neighbourhood", "suburb"])],
			uses(&[("pm:kind", s("neighbourhood"))]),
		),
		rule(
			vec![place(&["suburb"])],
			uses(&[("pm:kind", s("neighbourhood")), ("pm:kindDetail", s("suburb"))]),
		),
		rule(vec![place(&["quarter"])], uses(&[("pm:kind", s("macrohood"))])),
	];
	// Smaller places detailed in OSM.
	rules.extend(locality_with_fallback("village", true, 2_000));
	rules.extend(locality_with_fallback("locality", false, 1_000));
	rules.extend(locality_with_fallback("hamlet", false, 200));
	rules.extend(locality_with_fallback("isolated_dwelling", false, 100));
	rules.extend(locality_with_fallback("farm", false, 50));
	rules.extend(locality_with_fallback("allotments", false, 1_000));
	Index::new(rules)
});

static ZOOMS: LazyLock<Index> = LazyLock::new(|| {
	let kind = |value: &str| with(&["pm:kind", value]);
	let detail = |value: &str| with(&["pm:kindDetail", value]);
	let locality = |value: &str, rank: i32, min: i32, population: i64, min_with_population: i32| {
		[
			rule(
				vec![kind("locality"), detail(value)],
				uses(&[("pm:kindRank", i(rank)), ("pm:minzoom", i(min))]),
			),
			rule(
				vec![kind("locality"), detail(value), at_least("pm:population", population)],
				uses(&[("pm:minzoom", i(min_with_population))]),
			),
		]
	};
	let mut rules = vec![
		// The defaults.
		rule(vec![], uses(&[("pm:minzoom", i(12)), ("pm:maxzoom", i(15))])),
		rule(
			vec![kind("country")],
			uses(&[("pm:kindRank", i(0)), ("pm:minzoom", i(5)), ("pm:maxzoom", i(8))]),
		),
		rule(
			vec![kind("region")],
			uses(&[("pm:minzoom", i(8)), ("pm:maxzoom", i(11))]),
		),
		rule(
			vec![kind("region"), with(&[REGION_COUNTRIES])],
			uses(&[("pm:kindRank", i(1))]),
		),
		rule(
			vec![kind("locality")],
			uses(&[("pm:kindRank", i(4)), ("pm:minzoom", i(11)), ("pm:maxzoom", i(15))]),
		),
		rule(
			vec![kind("locality"), with(&["pm:populationFallback"])],
			uses(&[("pm:minzoom", i(12))]),
		),
		rule(
			vec![kind("locality"), detail("city")],
			uses(&[("pm:kindRank", i(2)), ("pm:minzoom", i(7))]),
		),
		rule(
			vec![kind("locality"), detail("city"), with(&["pm:populationFallback"])],
			uses(&[("pm:minzoom", i(8))]),
		),
		rule(
			vec![kind("locality"), detail("town")],
			uses(&[("pm:kindRank", i(2)), ("pm:minzoom", i(7))]),
		),
		rule(
			vec![kind("locality"), detail("town"), with(&["pm:populationFallback"])],
			uses(&[("pm:minzoom", i(9))]),
		),
	];
	rules.extend(locality("village", 3, 10, 2_000, 11));
	rules.extend(locality("hamlet", 5, 11, 200, 12));
	rules.extend(locality("isolated_dwelling", 6, 13, 100, 14));
	rules.extend(locality("farm", 7, 13, 50, 14));
	rules.extend(locality("allotments", 8, 13, 100, 14));
	rules.extend([
		rule(
			vec![kind("macrohood")],
			uses(&[("pm:kindRank", i(10)), ("pm:minzoom", i(10))]),
		),
		rule(
			vec![kind("neighbourhood")],
			uses(&[("pm:kindRank", i(11)), ("pm:minzoom", i(12))]),
		),
		rule(
			vec![kind("neighbourhood"), detail("suburb")],
			uses(&[("pm:kindRank", i(9)), ("pm:minzoom", i(12))]),
		),
	]);
	Index::new(rules)
});

/// A Wikidata id's curated label zooms and rank, from the fork's `places.csv`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WikidataConfig {
	pub min_zoom: i32,
	pub max_zoom: i32,
	pub rank_max: i32,
}

/// The curated places, by Wikidata id.
#[derive(Clone, Debug, Default)]
pub struct WikidataConfigs(HashMap<String, WikidataConfig>);

impl WikidataConfigs {
	/// Reads `places.csv`: a header, then `wikidata,minzoom,maxzoom,rankmax` rows.
	pub fn from_csv(text: &str) -> io::Result<Self> {
		let mut configs = HashMap::new();
		for line in text.lines().skip(1) {
			let columns: Vec<&str> = line.split(',').collect();
			let number = |index: usize| -> io::Result<i32> {
				columns
					.get(index)
					.and_then(|value| value.parse().ok())
					.ok_or_else(|| io::Error::other(format!("places.csv row {line:?} lacks column {index}")))
			};
			configs.insert(
				columns[0].to_owned(),
				WikidataConfig {
					min_zoom: number(1)?,
					max_zoom: number(2)?,
					rank_max: number(3)?,
				},
			);
		}
		Ok(WikidataConfigs(configs))
	}

	pub fn from_path(path: &Path) -> io::Result<Self> {
		Self::from_csv(&std::fs::read_to_string(path)?)
	}
}

/// The fork's `getSortKey`: curated minimum zoom first, then kind rank, larger populations, and shorter names.
fn sort_key(min_zoom: f64, kind_rank: i32, population: i64, name: Option<&str>) -> i32 {
	let name_length = name.map_or(0, |name| name.encode_utf16().count() as i32);
	SortKey::order_by_int((min_zoom * 10.0) as i32, 0, 150)
		.then_by_int(kind_rank, 0, 12)
		.then_by_log(population as f64, 40_000_000.0, 1.0, 65)
		.then_by_int(name_length, 0, 31)
		.get()
}

/// `Places.processOsm`: every named `place` point the rule table classifies.
pub fn process_osm(
	input: &mut Input<'_>,
	layer: u32,
	countries: Option<&CountryCoder>,
	wikidata: &WikidataConfigs,
	features: &mut Vec<Emitted>,
	config: CollectorConfig,
) {
	if !input.is_point() || !input.has_tag("name") || !input.has_tag("place") {
		return;
	}
	if let (Some(countries), Ok(hrt_osm::Geometry::Point(point))) = (countries, input.source.world_geometry()) {
		let lon_lat = hrt_render::Geom::Point([point.x() * 360.0 - 180.0, hrt_osm::coords::world_lat(point.y())]);
		if let Some(code) = countries.country_code(&lon_lat) {
			input.set_tag("pm:country", Some(code.to_owned()));
		}
	}

	let matches = OSM_KINDS.matches(input);
	let kind = get_string(input, &matches, "pm:kind", Some("pm:undefined")).unwrap_or_default();
	let kind_detail = get_string(input, &matches, "pm:kindDetail", Some("")).unwrap_or_default();
	let tagged_population = get_integer(input, &matches, "pm:population", Some(0)).unwrap_or(0);
	let population_fallback = get_integer(input, &matches, "pm:populationFallback", Some(0)).unwrap_or(0);
	if kind == "pm:undefined" {
		return;
	}

	// The zoom rules read these computed tags, as Java's SourceFeatureWithComputedTags shows them.
	input.set_tag("pm:kind", Some(kind.clone()));
	input.set_tag("pm:kindDetail", Some(kind_detail.clone()));
	input.set_tag("pm:population", Some(tagged_population.to_string()));
	input.set_tag(
		"pm:populationFallback",
		(population_fallback > 0).then(|| population_fallback.to_string()),
	);
	// Sorting uses the fallback when the place has no population.
	let population = if tagged_population == 0 && population_fallback > 0 {
		population_fallback
	} else {
		tagged_population
	};

	let zoom_matches = ZOOMS.matches(input);
	let mut min_zoom = get_integer(input, &zoom_matches, "pm:minzoom", Some(99)).unwrap_or(99);
	let mut max_zoom = get_integer(input, &zoom_matches, "pm:maxzoom", Some(99)).unwrap_or(99);
	let kind_rank = get_integer(input, &zoom_matches, "pm:kindRank", Some(99)).unwrap_or(99);
	let mut population_rank = POPULATION_BREAKS
		.iter()
		.rposition(|threshold| i64::from(population) >= *threshold)
		.map_or(0, |index| index as i32 + 1);
	if let Some(curated) = input.tag("wikidata").and_then(|id| wikidata.0.get(id)) {
		if kind == "country" || kind == "region" {
			min_zoom = curated.min_zoom;
			max_zoom = curated.max_zoom;
		}
		if kind == "locality" {
			min_zoom = curated.min_zoom;
			population_rank = curated.rank_max;
		}
	}
	for key in ["pm:kind", "pm:kindDetail", "pm:population", "pm:populationFallback"] {
		input.set_tag(key, None);
	}

	let input = &*input;
	let mut collector = Collector::new(input, config);
	let key = sort_key(f64::from(min_zoom), kind_rank, i64::from(population), input.tag("name"));
	let feature = collector
		.point(layer)
		.set_id(feature_id(input.source))
		.set_attr("kind", kind.as_str())
		.set_attr("kind_detail", input.tag("place"))
		.set_attr("min_zoom", min_zoom + 1)
		.set_attr("capital", input.tag("capital"))
		.set_attr("population", population)
		.set_attr("population_rank", population_rank)
		.set_zoom_range(min_zoom, max_zoom);
	if input.has_tag("wikidata") {
		feature.set_attr("wikidata", input.tag("wikidata"));
	}
	feature
		.set_sort_key(key)
		.set_attr("sort_key", key)
		.set_buffer_pixels(24.0)
		.set_point_label_grid_pixel_size(ZoomThresholds::from_max_zoom_thresholds(&[(14, 24.0), (15, 16.0)], 0.0))
		.set_point_label_grid_limit(ZoomThresholds::from_max_zoom_thresholds(
			&[(11, 1.0), (14, 2.0), (15, 3.0)],
			0.0,
		))
		// A label grid needs a buffer as wide as its cells, so neighboring tiles agree on each cell's winners.
		.set_buffer_pixel_overrides(12, 64.0);
	set_osm_names(feature, input, 0);
	set_osm_refs(feature, input, 0);
	features.extend(collector.finish());
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn curated_places_parse_from_csv() {
		let configs =
			WikidataConfigs::from_csv("wikidata,minzoom,maxzoom,rankmax\nQ228,4,9,-1\nQ878,3,8,-1\n").unwrap();
		assert_eq!(
			configs.0.get("Q228"),
			Some(&WikidataConfig {
				min_zoom: 4,
				max_zoom: 9,
				rank_max: -1
			})
		);
	}

	#[test]
	fn sort_keys_order_by_zoom_rank_population_and_name() {
		let big_city = sort_key(7.0, 2, 1_000_000, Some("Paris"));
		let small_city = sort_key(7.0, 2, 10_000, Some("Paris"));
		let later_zoom = sort_key(8.0, 2, 1_000_000, Some("Paris"));
		assert!(big_city < small_city);
		assert!(small_city < later_zoom);
		assert!(sort_key(7.0, 2, 10_000, Some("Nice")) < sort_key(7.0, 2, 10_000, Some("Nizza")));
	}
}
