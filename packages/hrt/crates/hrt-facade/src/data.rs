// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The decision tables, read once from the JSON files under `packages/structures/data/facade/`, which are compiled
//! into the crate. Every table is a transcription of an Arnis constant; the file comments name the source.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::block::Block;
use crate::category::{BuildingCategory, BuildingStylePreset};
use crate::facade::WindowArchetype;
use crate::height::HeightInference;
use crate::region::{BuildingRegion, MaterialRegion, RegionTables};
use crate::seed::ArchEra;
use crate::walls::WallTypology;

const BLOCK_PALETTE: &str = include_str!("../../../../structures/data/facade/block-palette.json");
const COLOR_NAMES: &str = include_str!("../../../../structures/data/facade/color-names.json");
const MATERIALS: &str = include_str!("../../../../structures/data/facade/materials.json");
const REGIONS: &str = include_str!("../../../../structures/data/facade/regions.json");
const PRESETS: &str = include_str!("../../../../structures/data/facade/presets.json");
const HEIGHT_INFERENCE: &str = include_str!("../../../../structures/data/facade/height-inference.json");
const WALL_POOLS: &str = include_str!("../../../../structures/data/facade/wall-pools.json");
const GLASS_POOLS: &str = include_str!("../../../../structures/data/facade/glass-pools.json");
const TRIM_RULES: &str = include_str!("../../../../structures/data/facade/trim-rules.json");
const ROOF_POOLS: &str = include_str!("../../../../structures/data/facade/roof-pools.json");
const ARCHETYPES: &str = include_str!("../../../../structures/data/facade/archetypes.json");
const CHANCES: &str = include_str!("../../../../structures/data/facade/chances.json");

/// Every table the crate reads.
pub struct Tables {
	pub palette: PaletteTables,
	/// `palette.match_palette` converted to Oklab once.
	pub palette_lab: Vec<(f32, f32, f32)>,
	pub color_names: HashMap<String, [u8; 3]>,
	pub materials: MaterialTables,
	pub regions: RegionTables,
	pub presets: HashMap<BuildingCategory, BuildingStylePreset>,
	pub height_inference: HeightInference,
	pub wall_pools: WallPoolTables,
	pub glass: GlassTables,
	pub trim: TrimTables,
	pub roof_pools: RoofPoolTables,
	pub archetypes: ArchetypeTables,
	pub chances: Chances,
}

/// The tables, parsed on first use.
///
/// # Panics
///
/// When a data file does not parse. The files are compiled in, so a malformed one fails every build that reads it.
pub fn tables() -> &'static Tables {
	static TABLES: OnceLock<Tables> = OnceLock::new();
	TABLES.get_or_init(|| {
		let palette: PaletteTables = from("block-palette.json", read("block-palette.json", BLOCK_PALETTE));
		let palette_lab = palette
			.match_palette
			.iter()
			.map(|row| crate::color::oklab_components(&row.rgb_tuple()))
			.collect();
		Tables {
			palette_lab,
			palette,
			color_names: from("color-names.json", read("color-names.json", COLOR_NAMES)),
			materials: from("materials.json", read("materials.json", MATERIALS)),
			regions: from("regions.json", read("regions.json", REGIONS)),
			presets: from("presets.json", read("presets.json", PRESETS)),
			height_inference: from("height-inference.json", read("height-inference.json", HEIGHT_INFERENCE)),
			wall_pools: from("wall-pools.json", read("wall-pools.json", WALL_POOLS)),
			glass: from("glass-pools.json", read("glass-pools.json", GLASS_POOLS)),
			trim: from("trim-rules.json", read("trim-rules.json", TRIM_RULES)),
			roof_pools: from("roof-pools.json", read("roof-pools.json", ROOF_POOLS)),
			archetypes: from("archetypes.json", read("archetypes.json", ARCHETYPES)),
			chances: from("chances.json", read("chances.json", CHANCES)),
		}
	})
}

/// A data file as JSON, without its `$comment`.
fn read(name: &str, text: &str) -> serde_json::Value {
	let mut value: serde_json::Value = serde_json::from_str(text)
		.unwrap_or_else(|error| panic!("packages/structures/data/facade/{name} is JSON: {error}"));
	if let Some(object) = value.as_object_mut() {
		object.remove("$comment");
	}
	value
}

/// A data file's JSON as its table type.
fn from<T: serde::de::DeserializeOwned>(name: &str, value: serde_json::Value) -> T {
	serde_json::from_value(value)
		.unwrap_or_else(|error| panic!("packages/structures/data/facade/{name} has the expected shape: {error}"))
}

#[derive(Deserialize)]
pub struct PaletteTables {
	pub blocks: Vec<BlockColor>,
	pub match_palette: Vec<MatchRow>,
	pub facade_tones: Vec<ToneRow>,
	pub render_tones: Vec<RgbRow>,
	pub roof_shades: Vec<RgbRow>,
	pub glass: Vec<GlassRow>,
}

#[derive(Deserialize, Clone)]
pub struct BlockColor {
	pub block: Block,
	pub rgb: [u8; 3],
	pub source: String,
}

#[derive(Deserialize)]
pub struct MatchRow {
	pub block: Block,
	pub rgb: [u8; 3],
	pub flags: String,
}

impl MatchRow {
	pub fn rgb_tuple(&self) -> (u8, u8, u8) {
		(self.rgb[0], self.rgb[1], self.rgb[2])
	}

	/// The `block_palette.rs` usage flags: M model, W wall, R roof, F facade.
	pub fn usage_flags(&self) -> u8 {
		self.flags.chars().fold(0, |acc, c| {
			acc | match c {
				'M' => crate::walls::USE_MODEL,
				'W' => crate::walls::USE_WALL,
				'R' => crate::walls::USE_ROOF,
				'F' => crate::walls::USE_FACADE,
				_ => 0,
			}
		})
	}
}

#[derive(Deserialize)]
pub struct ToneRow {
	pub block: Block,
	pub rgb: [u8; 3],
	pub mask: String,
}

impl ToneRow {
	pub fn rgb_tuple(&self) -> (u8, u8, u8) {
		(self.rgb[0], self.rgb[1], self.rgb[2])
	}
}

#[derive(Deserialize)]
pub struct RgbRow {
	pub block: Block,
	pub rgb: [u8; 3],
}

impl RgbRow {
	pub fn rgb_tuple(&self) -> (u8, u8, u8) {
		(self.rgb[0], self.rgb[1], self.rgb[2])
	}
}

#[derive(Deserialize)]
pub struct GlassRow {
	pub block: Block,
	pub tint: [u8; 3],
	pub backing: Block,
	pub alpha: f64,
}

#[derive(Deserialize)]
pub struct MaterialTables {
	pub ornate_styles: Vec<String>,
	pub brutalist_styles: Vec<String>,
	pub modern_styles: Vec<String>,
	pub masonry_materials: Vec<String>,
	pub masonry_cladding: Vec<String>,
	pub concrete_materials: Vec<String>,
	pub panel_materials: Vec<String>,
	pub wall_block_for_material: Vec<WordsBlocks>,
	pub roof_block_for_material: Vec<WordsBlocks>,
	pub facade_tone_families: Vec<WordsFamily>,
	pub roof_material_families: Vec<WordsFamily>,
	pub sheet_metal: Vec<String>,
	/// `building=*` values that keep castle masonry.
	pub fortification_buildings: Vec<String>,
	/// `historic=*` values that keep castle masonry.
	pub fortification_historic: Vec<String>,
}

#[derive(Deserialize)]
pub struct WordsBlocks {
	pub words: Vec<String>,
	pub blocks: Vec<Block>,
}

#[derive(Deserialize)]
pub struct WordsFamily {
	pub words: Vec<String>,
	pub family: String,
}

#[derive(Deserialize)]
pub struct WallPoolTables {
	pub pools: HashMap<String, Vec<(Block, u8)>>,
	pub pool_for: Vec<PoolFor>,
	pub category_palettes: CategoryPalettes,
	pub era_allow: EraAllow,
	pub nordic_wood_additions: Vec<Block>,
	pub climate_weights: HashMap<String, HashMap<Block, u8>>,
	pub climate_residential_scaled: ClimateScaled,
}

/// `"*"` or a list.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum StarOr<T> {
	Star(String),
	List(Vec<T>),
}

impl<T: PartialEq> StarOr<T> {
	fn matches(&self, value: &T) -> bool {
		match self {
			StarOr::Star(_) => true,
			StarOr::List(list) => list.contains(value),
		}
	}
}

#[derive(Deserialize)]
pub struct PoolFor {
	pub region: StarOr<MaterialRegion>,
	pub typology: StarOr<WallTypology>,
	pub pool: Option<String>,
}

impl PoolFor {
	pub fn matches(&self, region: MaterialRegion, typology: WallTypology) -> bool {
		self.region.matches(&region) && self.typology.matches(&typology)
	}
}

#[derive(Deserialize)]
pub struct CategoryPalettes {
	pub residential: Vec<Block>,
	pub commercial: Vec<Block>,
	pub industrial: Vec<Block>,
	pub religious: Vec<Block>,
	pub institutional: Vec<Block>,
	pub farm: Vec<Block>,
	pub historic: Vec<Block>,
	pub garage: Vec<Block>,
	pub shed: Vec<Block>,
	pub greenhouse: Vec<Block>,
	pub tower: Vec<Block>,
	pub modern_skyscraper: Vec<Block>,
	pub contemporary: Vec<Block>,
	pub masonry_warm: Vec<Block>,
	pub masonry_gray: Vec<Block>,
	pub glassy: Vec<Block>,
	pub fallback: Vec<Block>,
	pub castle: Vec<Block>,
	pub accent: Vec<Block>,
	pub skyscraper_floor: Vec<Block>,
	pub floor: Vec<Block>,
	pub glassy_accent: Vec<Block>,
	pub modern_accent: Vec<Block>,
}

#[derive(Deserialize)]
pub struct EraAllow {
	pub traditional_pre_war: Vec<Block>,
	pub post_war_panel: Vec<Block>,
	pub contemporary: Vec<Block>,
	pub historic_ornate: Vec<Block>,
}

#[derive(Deserialize)]
pub struct ClimateScaled {
	pub boreal: Vec<Block>,
	pub polar: Vec<Block>,
}

#[derive(Deserialize)]
pub struct GlassTables {
	pub window_pools: HashMap<String, Vec<Block>>,
	pub pool_for_category: HashMap<BuildingCategory, String>,
	pub backing: HashMap<String, [Block; 3]>,
	pub spandrel_panel: HashMap<String, Block>,
	pub curtain_frame: HashMap<String, Block>,
}

#[derive(Deserialize)]
pub struct TrimTables {
	pub trim: Vec<TrimRule>,
	pub accent: Vec<TrimRule>,
	pub base_course: Vec<TrimRule>,
	pub coping: Vec<TrimRule>,
	pub slab_of: Vec<TrimRule>,
	pub deco_spandrel: DecoSpandrel,
	pub shop_frame: ShopFrame,
	pub roof_distinct_from_wall: WallTones,
}

#[derive(Deserialize)]
pub struct TrimRule {
	#[serde(default)]
	pub walls: Vec<Block>,
	#[serde(default)]
	pub blocks: Vec<Block>,
	#[serde(default)]
	pub default: bool,
	#[serde(default)]
	pub glass: bool,
	#[serde(default)]
	pub glass_and_glass_accent: bool,
	#[serde(default)]
	pub seeded: bool,
	#[serde(default)]
	pub accent: bool,
	#[serde(default)]
	pub wall: bool,
}

#[derive(Deserialize)]
pub struct DecoSpandrel {
	pub dark_or_masonry: Vec<Block>,
	pub warm_stone: Vec<Block>,
	pub default: Vec<Block>,
}

#[derive(Deserialize)]
pub struct ShopFrame {
	pub default: Vec<Block>,
	pub europe: Vec<Block>,
}

#[derive(Deserialize)]
pub struct WallTones {
	pub brick_tone: Vec<Block>,
	pub red_tone: Vec<Block>,
	pub orange_tone: Vec<Block>,
	pub mid_grey: Vec<Block>,
}

#[derive(Deserialize)]
pub struct RoofPoolTables {
	pub pools: HashMap<String, Vec<(Block, u8)>>,
	pub pool_for_region: HashMap<MaterialRegion, RegionRoofPool>,
	pub tile_families: Vec<Block>,
	pub concrete_tile: Vec<Block>,
	pub slate_family: Vec<Block>,
	pub copper_family: Vec<Block>,
	pub painted_sheet: Vec<Block>,
	pub tile_brown: Block,
	pub district_roof_share: f64,
	pub district_roof_share_elsewhere: f64,
	pub membranes: HashMap<String, Vec<[Block; 3]>>,
	pub membrane_shares: HashMap<MaterialRegion, Vec<(String, u32)>>,
}

#[derive(Deserialize)]
pub struct RegionRoofPool {
	#[serde(default)]
	pub house: Option<String>,
	pub other: String,
}

#[derive(Deserialize)]
pub struct ArchetypeTables {
	pub rhythms: HashMap<WindowArchetype, [i32; 3]>,
	pub shop: [i32; 3],
	pub closed_retail: [i32; 3],
	pub weights: Vec<WeightRow>,
}

#[derive(Deserialize)]
pub struct WeightRow {
	pub categories: StarOr<BuildingCategory>,
	#[serde(default)]
	pub region: Option<BuildingRegion>,
	#[serde(default)]
	pub era: Option<ArchEraName>,
	#[serde(default)]
	pub dwelling: Option<bool>,
	#[serde(default)]
	pub masonry_wall: Option<bool>,
	#[serde(default)]
	pub banded_office: Option<bool>,
	#[serde(default)]
	pub table: Vec<(WindowArchetype, u32)>,
	#[serde(default)]
	pub fixed: Option<WindowArchetype>,
}

/// `ArchEra` as the data files spell it.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArchEraName {
	Unknown,
	HistoricOrnate,
	TraditionalPreWar,
	PostWarPanel,
	Contemporary,
}

impl ArchEraName {
	fn matches(self, era: ArchEra) -> bool {
		matches!(
			(self, era),
			(ArchEraName::Unknown, ArchEra::Unknown)
				| (ArchEraName::HistoricOrnate, ArchEra::HistoricOrnate)
				| (ArchEraName::TraditionalPreWar, ArchEra::TraditionalPreWar)
				| (ArchEraName::PostWarPanel, ArchEra::PostWarPanel)
				| (ArchEraName::Contemporary, ArchEra::Contemporary)
		)
	}
}

impl WeightRow {
	pub fn matches(
		&self,
		category: BuildingCategory,
		region: BuildingRegion,
		era: ArchEra,
		dwelling: bool,
		masonry_wall: bool,
		banded_office: bool,
	) -> bool {
		self.categories.matches(&category)
			&& self.region.is_none_or(|r| r == region)
			&& self.era.is_none_or(|e| e.matches(era))
			&& self.dwelling.is_none_or(|d| d == dwelling)
			&& self.masonry_wall.is_none_or(|m| m == masonry_wall)
			&& self.banded_office.is_none_or(|b| b == banded_office)
	}
}

#[derive(Deserialize)]
pub struct Chances {
	pub european_roof_share: EuropeanRoofShare,
	pub european_mansard_share: f64,
	pub apartment_block_weights: ApartmentBlockWeights,
	pub prewar_mansard_chance: f64,
	pub industrial_skillion_chance: f64,
	pub accent_roof_line_chance: f64,
	pub accent_lines_glassy_chance: f64,
	pub accent_lines_chance: f64,
	pub vertical_accent_chance: f64,
	pub chimney_chance: f64,
	pub contemporary_residential_pillars_chance: f64,
	pub flat_parapet_share: FlatParapetShare,
	pub ground_floor: GroundFloorChances,
	pub top_treatment_chance: f64,
	pub attic_chance: f64,
	pub surrounds_chance: SurroundsChance,
	pub piano_nobile_chance: PianoNobileChance,
	pub rustication_prewar_chance: f64,
	pub base_course_chance: f64,
	pub podium_chance: f64,
	pub curtain_wide_chance: f64,
	pub prewar_paired_chance: f64,
	pub masonry_glass_gray_chance: f64,
	pub membrane_green_share: MembraneGreenShare,
	pub membrane_na_bands: MembraneBands,
	pub membrane_eu_bands: MembraneEuBands,
}

#[derive(Deserialize)]
pub struct EuropeanRoofShare {
	pub historic_ornate: f64,
	pub traditional_pre_war: f64,
	pub post_war_panel_commercial: f64,
	pub post_war_panel: f64,
	pub contemporary_commercial: f64,
	pub contemporary: f64,
	pub unknown_attached: f64,
	pub unknown_large: f64,
	pub unknown: f64,
}

#[derive(Deserialize)]
pub struct ApartmentBlockWeights {
	pub old: [u32; 2],
	pub other: [u32; 2],
}

#[derive(Deserialize)]
pub struct FlatParapetShare {
	pub north_america: f64,
	pub europe: f64,
	pub other: f64,
	pub low_factor: f64,
}

#[derive(Deserialize)]
pub struct GroundFloorChances {
	pub commercial_corner: f64,
	pub commercial: f64,
	pub office: f64,
	pub residential: ResidentialShopChance,
	pub residential_corner_bonus: f64,
}

#[derive(Deserialize)]
pub struct ResidentialShopChance {
	pub north_america: f64,
	pub europe: f64,
	pub other: f64,
}

#[derive(Deserialize)]
pub struct SurroundsChance {
	pub historic: f64,
	pub traditional_pre_war: f64,
	pub unknown: f64,
}

#[derive(Deserialize)]
pub struct PianoNobileChance {
	pub historic: f64,
	pub hotel: f64,
	pub european_ornate: f64,
}

#[derive(Deserialize)]
pub struct MembraneGreenShare {
	pub contemporary: f64,
	pub unknown: f64,
	pub post_war_panel: f64,
	pub other: f64,
}

#[derive(Deserialize)]
pub struct MembraneBands {
	pub industrial: [u32; 3],
	pub prewar: [u32; 3],
	pub contemporary: [u32; 3],
	pub other: [u32; 3],
}

#[derive(Deserialize)]
pub struct MembraneEuBands {
	pub eu_grey_below: u32,
	pub ballast_below: u32,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn every_table_parses_and_every_block_has_a_color() {
		let tables = tables();
		assert_eq!(tables.palette.blocks.len(), crate::block::BLOCK_COUNT);
		for (index, row) in tables.palette.blocks.iter().enumerate() {
			assert_eq!(
				usize::from(row.block.index()),
				index,
				"{:?} sits at its palette index",
				row.block
			);
		}
		assert_eq!(tables.wall_pools.pools.len(), 54);
		assert_eq!(tables.roof_pools.pools.len(), 27);
		assert_eq!(tables.presets.len(), 24);
		assert_eq!(tables.regions.rules.len(), 16);
		assert!(tables.chances.podium_chance > 0.0);
	}
}
