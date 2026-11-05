// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Arnis `src/element_processing/buildings.rs` at commit d8e8b662 (github.com/louis-e/arnis,
// Apache-2.0): `BuildingCategory`, `BuildingStylePreset`, `BuildingCondition`, `RoofType`, `WallDepthStyle`,
// `DetailTier` and `compute_detail_tier`. Modified: the presets read `packages/structures/data/facade/presets.json`;
// the footprint is an [`Outline`] rather than a `ProcessedWay`; the Overture class map from `src/overture/mod.rs`
// `overture_class_to_osm_building` joins this module.

//! What kind of building this is, and the preset its kind pins.

use serde::{Deserialize, Serialize};

use crate::block::Block;
use crate::data;
use crate::height::multiply_scale;
use crate::region::BuildingRegion;
use crate::seed::{self, StyleHint, Tags};

/// A building footprint in Arnis's terms: ring vertices in whole meters and the count of whole-meter cells inside.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outline {
	/// The outer ring, closed (first vertex repeated last), in meters east and south of a local origin.
	pub nodes: Vec<(i32, i32)>,
	/// Cells of one square meter the footprint covers, holes removed.
	pub cells: usize,
}

impl Outline {
	/// The axis-aligned extents of the ring: min x, max x, min z, max z.
	pub fn bounds(&self) -> (i32, i32, i32, i32) {
		self.nodes
			.iter()
			.fold((i32::MAX, i32::MIN, i32::MAX, i32::MIN), |(a, b, c, d), n| {
				(a.min(n.0), b.max(n.0), c.min(n.1), d.max(n.1))
			})
	}
}

/// Lifecycle state derived from OSM tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildingCondition {
	Normal,
	Construction,
	Disused,
	Abandoned,
	Ruined,
}

impl BuildingCondition {
	/// The strongest applicable state: Ruined over Abandoned over Disused over Construction over Normal.
	pub fn from_tags(tags: &Tags) -> Self {
		let building_value = tags.get("building").map(String::as_str);
		if matches!(building_value, Some("ruins" | "collapsed"))
			|| tags.get("historic").map(String::as_str) == Some("ruins")
			|| tags.get("ruins").map(String::as_str) == Some("yes")
			|| tags.contains_key("ruins:building")
		{
			return Self::Ruined;
		}
		if tags.get("abandoned").map(String::as_str) == Some("yes") || tags.contains_key("abandoned:building") {
			return Self::Abandoned;
		}
		if tags.contains_key("disused:building") {
			return Self::Disused;
		}
		if building_value == Some("construction") || tags.contains_key("construction:building") {
			return Self::Construction;
		}
		Self::Normal
	}
}

/// The roof shapes the decisions distinguish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoofType {
	Mansard,
	Gambrel,
	HalfHipped,
	Gabled,
	Round,
	Hipped,
	Skillion,
	Pyramidal,
	Dome,
	Cone,
	Onion,
	Flat,
}

/// The relief family of a facade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WallDepthStyle {
	None,
	SubtlePilasters,
	ModernPillars,
	InstitutionalBands,
	IndustrialBeams,
	HistoricOrnate,
	ReligiousButtress,
	SkyscraperFins,
	GlassCurtain,
}

/// Decorative budget from prominence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetailTier {
	Minimal,
	Standard,
	Enhanced,
	Landmark,
}

/// The building category, which decides the preset and most of the draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildingCategory {
	Residential,
	House,
	Farm,
	Commercial,
	Office,
	Hotel,
	Industrial,
	Warehouse,
	School,
	Hospital,
	Religious,
	TallBuilding,
	GlassySkyscraper,
	GlassCornerSkyscraper,
	GridSkyscraper,
	ContemporarySkyscraper,
	ModernSkyscraper,
	MasonrySkyscraper,
	Historic,
	Tower,
	Garage,
	Shed,
	Greenhouse,
	Default,
}

impl BuildingCategory {
	/// The category from tags and calculated properties. `is_tall_building` and `building_height` come from
	/// `calculate_building_height`; `group_seed` carries a part's style hint.
	pub fn from_element(
		tags: &Tags,
		outline: &Outline,
		is_tall_building: bool,
		building_height: i32,
		group_seed: u64,
		scale_factor: f64,
		region: BuildingRegion,
	) -> Self {
		if tags.get("man_made").map(|s| s.as_str()) == Some("tower") {
			return BuildingCategory::Tower;
		}
		if is_tall_building {
			let mut hint = seed::style_hint_from_seed(group_seed);
			if hint == StyleHint::None {
				hint = seed::building_style_hint(tags);
			}
			let clean_seed = seed::seed_without_hint(group_seed);
			if hint == StyleHint::Glass {
				return Self::glass_family_variant(clean_seed);
			}
			if region == BuildingRegion::Europe
				&& seed::part_covers_ground(tags)
				&& !Self::has_tower_proportions(tags, outline, building_height, scale_factor)
			{
				let typed = Self::from_building_type(building_type(tags));
				if typed.keeps_its_facade_when_tall() {
					return typed;
				}
			}
			match hint {
				StyleHint::Masonry => return BuildingCategory::MasonrySkyscraper,
				StyleHint::Contemporary => return BuildingCategory::ContemporarySkyscraper,
				StyleHint::Glass | StyleHint::None => {}
			}
			let is_true_skyscraper = building_height >= multiply_scale(120, scale_factor)
				&& Self::has_skyscraper_proportions(outline, building_height);
			if is_true_skyscraper {
				let hash = clean_seed.wrapping_mul(2654435761);
				return match hash % 100 {
					0..=17 => BuildingCategory::GlassySkyscraper,
					18..=29 => BuildingCategory::GlassCornerSkyscraper,
					30..=44 => BuildingCategory::GridSkyscraper,
					45..=69 => BuildingCategory::ContemporarySkyscraper,
					70..=84 => BuildingCategory::ModernSkyscraper,
					_ => BuildingCategory::TallBuilding,
				};
			}
			return BuildingCategory::TallBuilding;
		}
		let building_type = building_type(tags);
		let is_religious_building = matches!(
			building_type,
			"religious" | "church" | "cathedral" | "chapel" | "mosque" | "synagogue" | "temple"
		);
		let is_religious_amenity = tags.get("amenity").map(|s| s.as_str()) == Some("place_of_worship");
		if is_religious_building || is_religious_amenity {
			return BuildingCategory::Religious;
		}
		if tags.contains_key("historic") {
			return BuildingCategory::Historic;
		}
		Self::from_building_type(building_type)
	}

	/// The category of a `building` value.
	pub fn from_building_type(building_type: &str) -> Self {
		match building_type {
			"house" | "detached" | "semidetached_house" | "terrace" | "bungalow" | "villa" | "cabin" | "hut" => {
				BuildingCategory::House
			}
			"residential" | "apartments" | "dormitory" => BuildingCategory::Residential,
			"farm" | "farm_auxiliary" | "barn" | "stable" | "cowshed" | "sty" | "sheepfold" => BuildingCategory::Farm,
			"commercial" | "retail" | "supermarket" | "kiosk" | "shop" => BuildingCategory::Commercial,
			"office" => BuildingCategory::Office,
			"hotel" => BuildingCategory::Hotel,
			"industrial" | "factory" | "manufacture" | "hangar" => BuildingCategory::Industrial,
			"warehouse" | "storage_tank" => BuildingCategory::Warehouse,
			"school" | "kindergarten" | "college" | "university" => BuildingCategory::School,
			"hospital" => BuildingCategory::Hospital,
			"religious" | "church" | "cathedral" | "chapel" | "mosque" | "synagogue" | "temple" => {
				BuildingCategory::Religious
			}
			"tower" | "clock_tower" | "transformer_tower" => BuildingCategory::Tower,
			"castle" | "ruins" | "fort" | "bunker" => BuildingCategory::Historic,
			"garage" | "garages" | "carport" => BuildingCategory::Garage,
			"shed" => BuildingCategory::Shed,
			"greenhouse" | "glasshouse" => BuildingCategory::Greenhouse,
			"public" | "government" | "civic" => BuildingCategory::School,
			_ => BuildingCategory::Default,
		}
	}

	/// Categories whose facade still fits at eight to fourteen storeys.
	fn keeps_its_facade_when_tall(self) -> bool {
		matches!(
			self,
			BuildingCategory::Residential
				| BuildingCategory::Commercial
				| BuildingCategory::Office
				| BuildingCategory::Hotel
				| BuildingCategory::School
				| BuildingCategory::Hospital
				| BuildingCategory::Default
		)
	}

	/// Whether a tall building is a tower rather than a mid-rise block: more than fourteen storeys or 50 m, or
	/// 40 m and half again as tall as its footprint is long.
	fn has_tower_proportions(tags: &Tags, outline: &Outline, building_height: i32, scale: f64) -> bool {
		let levels = tags
			.get("building:levels")
			.and_then(|l| l.trim().parse::<f64>().ok())
			.map_or(
				(f64::from(building_height - crate::height::GROUND_FLOOR_BONUS) / (4.0 * scale)) as i32,
				|l| l.round() as i32,
			);
		if levels > 14 || f64::from(building_height) > 50.0 * scale {
			return true;
		}
		if f64::from(building_height) < 40.0 * scale || outline.nodes.len() < 3 {
			return false;
		}
		let (min_x, max_x, min_z, max_z) = outline.bounds();
		let longest_side = (max_x - min_x).max(max_z - min_z).max(1);
		f64::from(building_height) >= 1.5 * f64::from(longest_side)
	}

	/// A glass-family treatment from the shared seed: pure curtain, grid, or concrete corners.
	fn glass_family_variant(seed: u64) -> BuildingCategory {
		match (seed ^ 0x6C07_A55E).wrapping_mul(2654435761) % 3 {
			0 => BuildingCategory::GlassySkyscraper,
			1 => BuildingCategory::GridSkyscraper,
			_ => BuildingCategory::GlassCornerSkyscraper,
		}
	}

	fn has_skyscraper_proportions(outline: &Outline, building_height: i32) -> bool {
		if building_height < 40 || outline.nodes.len() < 3 {
			return false;
		}
		let (min_x, max_x, min_z, max_z) = outline.bounds();
		let longest_side = (max_x - min_x).max(max_z - min_z).max(1);
		building_height as f64 / longest_side as f64 >= 2.0
	}
}

/// The `building` value, else the `building:part` one, else `yes`.
pub fn building_type(tags: &Tags) -> &str {
	tags.get("building")
		.or_else(|| tags.get("building:part"))
		.map(|s| s.as_str())
		.unwrap_or("yes")
}

/// The OSM `building` value an Overture row's `class` and `subtype` stand for. Arnis
/// `overture_class_to_osm_building`.
pub fn overture_class_to_osm_building<'a>(subtype: Option<&'a str>, class: Option<&'a str>) -> &'a str {
	if let Some(class) = class {
		match class {
			"house" | "detached" => return "house",
			"apartments" | "apartment" => return "apartments",
			"residential" => return "residential",
			"commercial" => return "commercial",
			"retail" => return "retail",
			"office" => return "office",
			"industrial" => return "industrial",
			"warehouse" => return "warehouse",
			"garage" | "garages" => return "garage",
			"shed" => return "shed",
			"school" => return "school",
			"hospital" => return "hospital",
			"church" | "mosque" | "temple" | "synagogue" => return "church",
			"hotel" => return "hotel",
			"farm" | "barn" => return "farm",
			_ => {}
		}
	}
	if let Some(subtype) = subtype {
		match subtype {
			"residential" => return "residential",
			"commercial" => return "commercial",
			"industrial" => return "industrial",
			"agricultural" => return "farm",
			"civic" | "government" | "education" => return "public",
			"medical" => return "hospital",
			"religious" => return "church",
			"transportation" => return "transportation",
			"outbuilding" => return "shed",
			_ => {}
		}
	}
	"yes"
}

/// A partial style where an absent field means "decide in `resolve`".
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BuildingStylePreset {
	pub wall_block: Option<Block>,
	pub floor_block: Option<Block>,
	pub window_block: Option<Block>,
	pub accent_block: Option<Block>,
	pub roof_block: Option<Block>,
	pub use_horizontal_windows: Option<bool>,
	pub has_windows: Option<bool>,
	pub use_accent_roof_line: Option<bool>,
	pub use_accent_lines: Option<bool>,
	pub use_vertical_accent: Option<bool>,
	pub roof_type: Option<RoofType>,
	pub has_chimney: Option<bool>,
	pub generate_roof: Option<bool>,
	pub has_garage_door: Option<bool>,
	pub has_single_door: Option<bool>,
	pub wall_depth_style: Option<WallDepthStyle>,
	pub has_parapet: Option<bool>,
}

impl BuildingStylePreset {
	/// The preset of a category, from `presets.json`.
	pub fn for_category(category: BuildingCategory) -> Self {
		data::tables().presets.get(&category).cloned().unwrap_or_default()
	}
}

/// The decorative budget from footprint, height, category, tags and visibility. Arnis `compute_detail_tier`.
pub fn compute_detail_tier(
	tags: &Tags,
	category: BuildingCategory,
	footprint: usize,
	building_height: i32,
	street_facing: bool,
) -> DetailTier {
	let mut score: i32 = 0;
	score += (footprint as i32 / 40).min(25);
	score += building_height.saturating_mul(2).min(25);
	score += match category {
		BuildingCategory::Historic | BuildingCategory::Religious => 20,
		BuildingCategory::Commercial | BuildingCategory::Hotel | BuildingCategory::Office => 10,
		BuildingCategory::Garage | BuildingCategory::Shed | BuildingCategory::Greenhouse => -20,
		_ => 0,
	};
	if tags.contains_key("wikidata") {
		score += 15;
	}
	if tags
		.get("tourism")
		.is_some_and(|t| matches!(t.as_str(), "attraction" | "museum" | "gallery" | "viewpoint"))
	{
		score += 15;
	}
	if tags.get("heritage").is_some_and(|v| v != "no") {
		score += 20;
	}
	if tags.get("historic").is_some_and(|v| v != "no") {
		score += 15;
	}
	if tags.contains_key("building:architecture") || tags.contains_key("architecture") {
		score += 10;
	}
	if street_facing {
		score += 10;
	}
	if score <= 24 {
		DetailTier::Minimal
	} else if score <= 55 {
		DetailTier::Standard
	} else if score <= 80 {
		DetailTier::Enhanced
	} else {
		DetailTier::Landmark
	}
}

/// Whether a wall block reads as a tagged color or material the zoning keeps. Arnis `keeping_mapped_wall`'s test.
pub fn has_mapped_wall(tags: &Tags) -> bool {
	[
		"building:colour",
		"colour",
		"building:material",
		"building:facade:material",
		"facade:material",
	]
	.iter()
	.any(|k| tags.contains_key(*k))
}
