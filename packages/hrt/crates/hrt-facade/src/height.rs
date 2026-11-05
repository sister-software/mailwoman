// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Arnis `src/element_processing/buildings.rs` at commit d8e8b662 (github.com/louis-e/arnis,
// Apache-2.0): `floor_cycle_for`, `parse_building_height_tag`, `infer_building_height`, `calculate_building_height`,
// `takes_commercial_rhythm`, `multiply_scale`, `mapped_height_roof_rise` and `max_inferred_rise`. Modified: the
// inference tables read `packages/structures/data/facade/height-inference.json`.

//! How tall a building is in wall rows, how tall each storey is, and what to infer when the data says nothing.

use rand::Rng;
use serde::Deserialize;

use crate::category::{Outline, RoofType};
use crate::data;
use crate::rng::element_rng;
use crate::seed::Tags;

/// Extra rows on top of `levels * cycle`: one taller ground floor row plus the floor slab row.
pub const GROUND_FLOOR_BONUS: i32 = 2;

/// The tallest `height` tag taken at face value, in meters.
pub const MAX_PLAUSIBLE_HEIGHT_M: f64 = 1000.0;

pub fn multiply_scale(value: i32, scale_factor: f64) -> i32 {
	if scale_factor == 1.0 {
		value
	} else if scale_factor == 2.0 {
		value << 1
	} else if scale_factor == 4.0 {
		value << 2
	} else {
		let result = (value as f64) * scale_factor;
		result as i32
	}
}

/// A `height` tag in meters, or `None` for a value no building can have.
pub fn parse_building_height_tag(tags: &Tags) -> Option<f64> {
	let height = tags.get("height")?.trim_end_matches('m').trim().parse::<f64>().ok()?;
	(height.is_finite() && height <= MAX_PLAUSIBLE_HEIGHT_M).then_some(height)
}

/// Gross rows of one upper floor: 3 for residential-scale types, 4 for commercial and institutional, the mapped
/// storey height clamped to 3..=5 when both `height` and `building:levels` exist.
pub fn floor_cycle_for(building_type: &str, tags: &Tags, housing_group: bool) -> i32 {
	const RESIDENTIAL_SCALE: &[&str] = &[
		"house",
		"detached",
		"semidetached_house",
		"terrace",
		"bungalow",
		"villa",
		"cabin",
		"residential",
		"apartments",
		"dormitory",
		"farm",
		"hut",
		"shed",
		"static_caravan",
	];
	if tags.contains_key("building:part") {
		return if housing_group { 3 } else { 4 };
	}
	let levels = tags
		.get("building:levels")
		.and_then(|v| v.trim().parse::<f64>().ok())
		.filter(|l| *l >= 2.0);
	if let (Some(height), Some(levels)) = (parse_building_height_tag(tags), levels) {
		let cycle = ((height - GROUND_FLOOR_BONUS as f64) / levels).floor() as i32;
		return cycle.clamp(3, 5);
	}
	if RESIDENTIAL_SCALE.contains(&building_type) || building_type == "yes" {
		3
	} else {
		4
	}
}

/// Untagged towers read better on the taller commercial rhythm; a part keeps the cycle its group shares.
pub fn takes_commercial_rhythm(is_tall_building: bool, building_type: &str, floor_cycle: i32, tags: &Tags) -> bool {
	is_tall_building && building_type == "yes" && floor_cycle == 3 && !tags.contains_key("building:part")
}

/// An inferred storey count or hall height.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InferredHeight {
	Levels(f64),
	HallBlocks(i32),
}

fn pick_weighted_value(rng: &mut impl Rng, options: &[(i32, u32)]) -> i32 {
	let total: u32 = options.iter().map(|&(_, w)| w).sum();
	let mut roll = rng.random_range(0..total);
	for &(value, weight) in options {
		if roll < weight {
			return value;
		}
		roll -= weight;
	}
	options[options.len() - 1].0
}

/// The inference tables as `height-inference.json` holds them.
#[derive(Deserialize)]
pub struct HeightInference {
	pub tower: Vec<(i32, u32)>,
	pub arena_large: AreaTable,
	pub arena: AreaTable,
	pub by_type: Vec<TypeTable>,
	pub untyped: Vec<UntypedBand>,
	pub untyped_tiny: TinyRoll,
	pub untyped_large: LargeRoll,
}

#[derive(Deserialize)]
pub struct AreaTable {
	#[serde(default)]
	pub min_area: Option<usize>,
	pub hall: bool,
	pub table: Vec<(i32, u32)>,
}

#[derive(Deserialize)]
pub struct TypeTable {
	pub types: Vec<String>,
	#[serde(default)]
	pub area: Option<(usize, Option<usize>)>,
	pub hall: bool,
	pub table: Vec<(i32, u32)>,
}

#[derive(Deserialize)]
pub struct UntypedBand {
	pub area: (usize, Option<usize>),
	#[serde(default)]
	pub roll: Option<String>,
	#[serde(default)]
	pub hall: bool,
	#[serde(default)]
	pub table: Vec<(i32, u32)>,
}

#[derive(Deserialize)]
pub struct TinyRoll {
	pub hall_chance: f64,
	pub hall: Vec<(i32, u32)>,
	pub storeys: Vec<(i32, u32)>,
}

#[derive(Deserialize)]
pub struct LargeRoll {
	pub hall_below: u32,
	pub storeys_three_below: u32,
	pub hall: Vec<(i32, u32)>,
	pub three: Vec<(i32, u32)>,
	pub four: Vec<(i32, u32)>,
}

fn in_band(area: usize, band: (usize, Option<usize>)) -> bool {
	area >= band.0 && band.1.is_none_or(|end| area < end)
}

/// Storeys or a hall height for a building without any height data, seeded on the group seed.
pub fn infer_building_height(
	building_type: &str,
	tags: &Tags,
	footprint_area: usize,
	scale_factor: f64,
	group_seed: u64,
) -> InferredHeight {
	let tables = &data::tables().height_inference;
	let mut rng = element_rng(group_seed ^ 0x48E1_6F00_1EA5_0001);
	let area_m2 = if tags.contains_key("building:part") {
		400
	} else if scale_factor > 0.0 {
		(footprint_area as f64 / (scale_factor * scale_factor)) as usize
	} else {
		footprint_area
	};
	if tags.get("man_made").map(String::as_str) == Some("tower") {
		let blocks = pick_weighted_value(&mut rng, &tables.tower);
		return InferredHeight::HallBlocks(blocks);
	}
	let arena = matches!(building_type, "stadium" | "arena")
		|| (building_type == "yes" && tags.get("leisure").map(String::as_str) == Some("stadium"));
	let (is_hall, table): (bool, &[(i32, u32)]) =
		if arena && area_m2 >= tables.arena_large.min_area.unwrap_or(0) {
			(tables.arena_large.hall, &tables.arena_large.table)
		} else if arena {
			(tables.arena.hall, &tables.arena.table)
		} else if let Some(row) = tables.by_type.iter().find(|row| {
			row.types.iter().any(|t| t == building_type) && row.area.is_none_or(|band| in_band(area_m2, band))
		}) {
			(row.hall, &row.table)
		} else {
			let band = tables
				.untyped
				.iter()
				.find(|band| in_band(area_m2, band.area))
				.unwrap_or_else(|| tables.untyped.last().expect("the untyped bands are not empty"));
			match band.roll.as_deref() {
				Some("tiny") => {
					if rng.random_bool(tables.untyped_tiny.hall_chance) {
						(true, &tables.untyped_tiny.hall)
					} else {
						(false, &tables.untyped_tiny.storeys)
					}
				}
				Some(_) => {
					let roll = rng.random_range(0u32..100);
					if roll < tables.untyped_large.hall_below {
						(true, &tables.untyped_large.hall)
					} else if roll < tables.untyped_large.storeys_three_below {
						(false, &tables.untyped_large.three)
					} else {
						(false, &tables.untyped_large.four)
					}
				}
				None => (band.hall, &band.table),
			}
		};
	let value = pick_weighted_value(&mut rng, table);
	if is_hall {
		InferredHeight::HallBlocks(value)
	} else {
		InferredHeight::Levels(value as f64)
	}
}

/// The wall rows of a building from its tags, and whether it is tall (more than seven levels or over 28 m), with
/// the per-type inference as the fallback. Arnis `calculate_building_height`.
#[allow(clippy::too_many_arguments)]
pub fn calculate_building_height(
	tags: &Tags,
	building_type: &str,
	min_level: i32,
	scale_factor: f64,
	relation_levels: Option<i32>,
	floor_cycle: i32,
	footprint_area: usize,
	group_seed: u64,
) -> (i32, bool) {
	let mut building_height = ((10.0 * scale_factor) as i32).max(3);
	let mut is_tall_building = false;
	let mut has_source = false;
	if let Some(levels_str) = tags.get("building:levels") {
		if let Ok(levels) = levels_str.trim().parse::<f64>() {
			let lev = levels - min_level as f64;
			if lev >= 1.0 {
				let bonus = if min_level > 0 { 0.0 } else { GROUND_FLOOR_BONUS as f64 };
				building_height = (((lev * floor_cycle as f64 + bonus) * scale_factor) as i32).max(3);
				has_source = true;
				if levels > 7.0 {
					is_tall_building = true;
				}
			}
		}
	}
	let mut has_explicit_height = false;
	if let Some(height) = parse_building_height_tag(tags) {
		has_explicit_height = true;
		has_source = true;
		let mut is_elevated_part = false;
		let effective = if let Some(mh_str) = tags.get("min_height") {
			let mh = mh_str.trim_end_matches('m').trim().parse::<f64>().unwrap_or(0.0);
			is_elevated_part = mh > 0.0;
			(height - mh).max(1.0)
		} else if min_level > 0 {
			is_elevated_part = true;
			let offset = (min_level * floor_cycle + GROUND_FLOOR_BONUS) as f64;
			(height - offset).max(1.0)
		} else {
			height
		};
		let is_part = tags.contains_key("building:part");
		let wall_floor: f64 = if is_part { 1.0 } else { 3.0 };
		let effective = match (tags.get("roof:height"), tags.get("roof:shape")) {
			(Some(rh), Some(shape)) if shape != "flat" => {
				let rh = rh.trim_end_matches('m').trim().parse::<f64>().unwrap_or(0.0);
				(effective - rh.max(0.0)).max(wall_floor.min(effective))
			}
			_ => effective,
		};
		building_height = (effective * scale_factor) as i32;
		building_height = building_height.max(if is_elevated_part || is_part { 1 } else { 3 });
		if height > 28.0 {
			is_tall_building = true;
		}
	}
	if !has_explicit_height {
		if let Some(levels) = relation_levels {
			let bonus = if min_level > 0 { 0 } else { GROUND_FLOOR_BONUS };
			building_height = multiply_scale((levels - min_level).max(1) * floor_cycle + bonus, scale_factor).max(3);
			has_source = true;
			if levels > 7 {
				is_tall_building = true;
			}
		}
	}
	if !has_source {
		match infer_building_height(building_type, tags, footprint_area, scale_factor, group_seed) {
			InferredHeight::Levels(levels) => {
				let lev = (levels - min_level as f64).max(1.0);
				let bonus = if min_level > 0 { 0.0 } else { GROUND_FLOOR_BONUS as f64 };
				building_height = (((lev * floor_cycle as f64 + bonus) * scale_factor) as i32).max(3);
				if levels > 7.0 {
					is_tall_building = true;
				}
			}
			InferredHeight::HallBlocks(blocks) => {
				building_height = multiply_scale(blocks, scale_factor).max(3);
			}
		}
	}
	(building_height, is_tall_building)
}

/// The most rows a pitched roof the generator shapes itself rises: 9, or 14 for a steep church gable.
pub fn max_inferred_rise(steep: bool, scale_factor: f64) -> i32 {
	((if steep { 14.0 } else { 9.0 }) * scale_factor).round().max(2.0) as i32
}

/// The rows a pitched roof takes off a mapped `height` that already includes it, or `None` when the walls keep
/// the full height. Arnis `mapped_height_roof_rise`.
#[allow(clippy::too_many_arguments)]
pub fn mapped_height_roof_rise(
	tags: &Tags,
	outline: &Outline,
	roof_type: RoofType,
	generate_roof: bool,
	condition_keeps_roof: bool,
	wall_height: i32,
	steep: bool,
	scale_factor: f64,
) -> Option<i32> {
	let pitched = matches!(
		roof_type,
		RoofType::Gabled
			| RoofType::Hipped
			| RoofType::HalfHipped
			| RoofType::Gambrel
			| RoofType::Pyramidal
			| RoofType::Mansard
	);
	if !generate_roof
		|| !pitched
		|| !condition_keeps_roof
		|| parse_building_height_tag(tags).is_none()
		|| tags.contains_key("roof:height")
		|| tags.contains_key("roof:angle")
	{
		return None;
	}
	let mut diameter: f64 = 1.0;
	for (i, a) in outline.nodes.iter().enumerate() {
		for b in &outline.nodes[i + 1..] {
			let d = f64::from(a.0 - b.0).hypot(f64::from(a.1 - b.1));
			diameter = diameter.max(d);
		}
	}
	let short_half = outline.cells as f64 / diameter / 2.0;
	let slope_rise = if roof_type == RoofType::Mansard {
		4.0 * scale_factor + ((short_half - 2.0) / 2.0).max(0.0)
	} else {
		short_half * 0.85
	};
	let wall_share = if steep { 0.47 } else { 0.375 };
	let rise = slope_rise
		.min(f64::from(max_inferred_rise(steep, scale_factor)))
		.min(f64::from(wall_height) * wall_share)
		.round() as i32;
	(rise >= 1).then_some(rise)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tags(pairs: &[(&str, &str)]) -> Tags {
		pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
	}

	#[test]
	fn levels_and_heights_set_the_rows() {
		assert_eq!(
			calculate_building_height(&tags(&[("building:levels", "3")]), "house", 0, 1.0, None, 3, 100, 1),
			(11, false)
		);
		assert_eq!(
			calculate_building_height(&tags(&[("height", "30")]), "yes", 0, 1.0, None, 3, 100, 1),
			(30, true)
		);
		assert_eq!(
			floor_cycle_for("office", &tags(&[("height", "25"), ("building:levels", "5")]), false),
			4
		);
		assert_eq!(floor_cycle_for("office", &tags(&[]), false), 4);
		assert_eq!(floor_cycle_for("yes", &tags(&[]), false), 3);
	}

	#[test]
	fn inference_is_deterministic_and_in_range() {
		for seed in 0..50u64 {
			match infer_building_height("house", &tags(&[]), 120, 1.0, seed) {
				InferredHeight::Levels(l) => assert!((1.0..=3.0).contains(&l)),
				InferredHeight::HallBlocks(_) => panic!("a house is storeys"),
			}
		}
		assert_eq!(
			infer_building_height("garage", &tags(&[]), 30, 1.0, 7),
			InferredHeight::HallBlocks(3)
		);
	}
}
