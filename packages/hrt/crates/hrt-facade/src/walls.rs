// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Arnis `src/element_processing/buildings.rs`, `src/block_palette.rs` and `src/block_definitions.rs`
// at commit d8e8b662 (github.com/louis-e/arnis, Apache-2.0): the wall block choice, from a tagged material or
// color, from a regional pool narrowed per district, or from a category palette, and the glass, accent and
// backing that go with it. Modified: every table reads the files under `packages/structures/data/facade/`; the
// draws and their order are unchanged.

//! What a wall is made of, what its windows are glazed with, and what reads behind a glass skin.

use rand::Rng;

use crate::block::{is_dark_wall, is_glass_wall, is_light_stone, is_rare_wall_block, is_warm_stone, Block};
use crate::category::BuildingCategory;
use crate::climate::Climate;
use crate::color::{color_text_to_rgb_tuple, norm_tag, oklab_components, oklab_distance_lab, RGBTuple};
use crate::data::{self, Tables};
use crate::region::MaterialRegion;
use crate::rng::element_rng;
use crate::seed::{self, ArchEra, Tags};
use crate::style::RoofContext;

/// Facade materials a tagged colour is matched within.
pub const BRICKWORK: u8 = 1;
pub const STONEWORK: u8 = 2;
pub const RENDERED: u8 = 4;
pub const CONCRETE_WORK: u8 = 8;

/// `block_palette.rs` usage flags.
pub const USE_MODEL: u8 = 1;
pub const USE_WALL: u8 = 2;
pub const USE_ROOF: u8 = 4;
pub const USE_FACADE: u8 = 8;

fn material_tag(tags: &Tags) -> Option<&String> {
	tags.get("building:material")
		.or_else(|| tags.get("building:facade:material"))
		.or_else(|| tags.get("facade:material"))
}

fn colour_tag(tags: &Tags) -> Option<RGBTuple> {
	tags.get("building:colour")
		.or_else(|| tags.get("colour"))
		.and_then(|c| color_text_to_rgb_tuple(c))
}

/// The wall block an OSM material or colour tag asks for, or `None` without one.
pub fn determine_wall_block_from_tags(tags: &Tags, category: BuildingCategory, rng: &mut impl Rng) -> Option<Block> {
	if category == BuildingCategory::GlassySkyscraper {
		return None;
	}
	if tags.get("historic").map(String::as_str) == Some("castle") {
		return None;
	}
	if let Some(material) = material_tag(tags).filter(|m| !painted_metal(m, tags)) {
		if let Some(block) = facade_tone_for_material(material, tags, rng) {
			return Some(block);
		}
		if let Some(block) = get_wall_block_for_material(material, rng) {
			return Some(block);
		}
	}
	if let Some(rgb) = colour_tag(tags) {
		if let Some(block) =
			tower_facade_tones(category, tags).and_then(|family| facade_tone_for_colour(rgb, family, rng))
		{
			return Some(block);
		}
		return Some(wall_block_for_colour_tag(rgb, rng));
	}
	None
}

/// Steel shows its paint, so a metal with a colour tag defers to the colour.
fn painted_metal(material: &str, tags: &Tags) -> bool {
	matches!(
		material.trim().to_ascii_lowercase().as_str(),
		"steel" | "metal" | "iron"
	) && (tags.contains_key("building:colour") || tags.contains_key("colour"))
}

fn family_mask(name: &str) -> u8 {
	name.split('|')
		.map(|part| match part.trim() {
			"BRICKWORK" => BRICKWORK,
			"STONEWORK" => STONEWORK,
			"RENDERED" => RENDERED,
			"CONCRETE_WORK" => CONCRETE_WORK,
			_ => 0,
		})
		.fold(0, |acc, bit| acc | bit)
}

/// The wall of a brick, stone, render or concrete facade that also has a colour tag: that material's nearest
/// shade, or the colour itself where the material has no shade near it.
fn facade_tone_for_material(material: &str, tags: &Tags, rng: &mut impl Rng) -> Option<Block> {
	let rgb = colour_tag(tags)?;
	let normalized = norm_tag(material);
	let family = data::tables()
		.materials
		.facade_tone_families
		.iter()
		.find(|row| row.words.contains(&normalized))
		.map(|row| family_mask(&row.family))?;
	facade_tone_for_colour(rgb, family, rng).or_else(|| Some(wall_block_for_colour_tag(rgb, rng)))
}

/// The tone family of a tower with a colour but no material; `None` for every other building.
fn tower_facade_tones(category: BuildingCategory, tags: &Tags) -> Option<u8> {
	if !matches!(
		category,
		BuildingCategory::TallBuilding
			| BuildingCategory::MasonrySkyscraper
			| BuildingCategory::ContemporarySkyscraper
			| BuildingCategory::ModernSkyscraper
			| BuildingCategory::GridSkyscraper
			| BuildingCategory::GlassCornerSkyscraper
	) {
		return None;
	}
	let masonry = category == BuildingCategory::MasonrySkyscraper
		|| matches!(
			seed::building_arch_era_dated(tags, seed::building_start_year(tags)),
			ArchEra::HistoricOrnate | ArchEra::TraditionalPreWar
		);
	Some(if masonry { STONEWORK | BRICKWORK } else { CONCRETE_WORK })
}

/// The nearest facade tone of `family` to a tagged colour, hue-keeping, among near ties; `None` when even the
/// nearest is far off.
fn facade_tone_for_colour(rgb: RGBTuple, family: u8, rng: &mut impl Rng) -> Option<Block> {
	const MAX_DISTANCE: f32 = 0.03;
	let target = oklab_components(&rgb);
	let insert = |best: &mut [(f32, Block); 3], d: f32, block: Block| {
		if let Some(slot) = best.iter().position(|&(bd, _)| d < bd) {
			best.copy_within(slot..2, slot + 1);
			best[slot] = (d, block);
		}
	};
	let mut any = [(f32::MAX, Block::Stone); 3];
	let mut same_hue = [(f32::MAX, Block::Stone); 3];
	for row in &data::tables().palette.facade_tones {
		if family_mask(&row.mask) & family == 0 {
			continue;
		}
		let lab = oklab_components(&row.rgb_tuple());
		let (dl, da, db) = (0.5 * (target.0 - lab.0), target.1 - lab.1, target.2 - lab.2);
		let d = dl * dl + da * da + db * db;
		insert(&mut any, d, row.block);
		if keeps_hue(target, lab) {
			insert(&mut same_hue, d, row.block);
		}
	}
	if any[0].0 > MAX_DISTANCE {
		return None;
	}
	let best = if same_hue[0].0 <= 4.0 * any[0].0 { same_hue } else { any };
	let cutoff = best[0].0.max(1e-6) * 1.25;
	let near = best.iter().take_while(|&&(d, _)| d <= cutoff).count();
	Some(best[rng.random_range(0..near)].1)
}

/// Whether a block's Oklab colour keeps the hue of a tagged one.
fn keeps_hue(target: (f32, f32, f32), block: (f32, f32, f32)) -> bool {
	let target_chroma = target.1.hypot(target.2);
	if target_chroma < 0.03 {
		return true;
	}
	let chroma = block.1.hypot(block.2);
	if chroma < 0.015 {
		return false;
	}
	let cos = (target.1 * block.1 + target.2 * block.2) / (target_chroma * chroma);
	cos >= 0.927
}

/// The wall for a `building:colour` tag: the nearest render or stone tone for pale unsaturated colours, the
/// general palette for the rest.
fn wall_block_for_colour_tag(rgb: RGBTuple, rng: &mut impl Rng) -> Block {
	let target = oklab_components(&rgb);
	if target.0 < 0.55 || target.1.hypot(target.2) >= 0.14 {
		return wall_block_for_color(rgb, rng);
	}
	data::tables()
		.palette
		.render_tones
		.iter()
		.map(|row| {
			let lab = oklab_components(&row.rgb_tuple());
			let (dl, da, db) = (0.5 * (target.0 - lab.0), target.1 - lab.1, target.2 - lab.2);
			(row.block, dl * dl + da * da + db * db)
		})
		.min_by(|a, b| a.1.total_cmp(&b.1))
		.map_or(Block::WhiteConcrete, |(b, _)| b)
}

/// Squared Oklab distance with lightness downweighted, for colour tags. Arnis `tag_match_distance`.
fn tag_match_distance(a: (f32, f32, f32), b: (f32, f32, f32)) -> f32 {
	let dl = 0.5 * (a.0 - b.0);
	let da = a.1 - b.1;
	let db = a.2 - b.2;
	dl * dl + da * da + db * db
}

fn palette_lab(tables: &Tables) -> impl Iterator<Item = ((f32, f32, f32), Block, u8)> + '_ {
	tables
		.palette
		.match_palette
		.iter()
		.zip(tables.palette_lab.iter())
		.map(|(row, lab)| (*lab, row.block, row.usage_flags()))
}

/// Three nearest usage-flagged blocks within 1.5x of the best match, picked with the rng.
fn pick_for_usage(color: RGBTuple, usage: u8, rng: &mut impl Rng) -> Block {
	let target = oklab_components(&color);
	let mut scored: Vec<(f32, Block)> = palette_lab(data::tables())
		.filter(|(_, _, flags)| flags & usage != 0)
		.map(|(c, b, _)| (tag_match_distance(target, c), b))
		.collect();
	scored.sort_by(|a, b| a.0.total_cmp(&b.0));
	scored.truncate(3);
	let cutoff = scored[0].0.max(1e-6) * 1.5;
	scored.retain(|&(d, _)| d <= cutoff);
	scored[rng.random_range(0..scored.len())].1
}

/// Warm building stone: buff, sand and cream masonry.
const WARM_STONE: &[Block] = &[
	Block::Sandstone,
	Block::SmoothSandstone,
	Block::EndStoneBricks,
	Block::WhiteTerracotta,
];

fn reads_as_warm_stone(color: RGBTuple) -> bool {
	let (l, a, b) = oklab_components(&color);
	let chroma = (a * a + b * b).sqrt();
	let yellow_enough = a <= 0.0 || b > 1.73 * a;
	b > 0.030 && a > -0.05 && yellow_enough && b < 0.13 && l > 0.55 && chroma < 0.11
}

/// The wall block for a `building:colour`/`colour` tag value. Arnis `block_palette::wall_block_for_color`.
pub fn wall_block_for_color(color: RGBTuple, rng: &mut impl Rng) -> Block {
	if reads_as_warm_stone(color) {
		return pick_nearest_of(WARM_STONE, color, rng);
	}
	pick_for_usage(color, USE_WALL, rng)
}

/// The roof block for a `roof:colour` tag value. Arnis `block_palette::roof_block_for_color`.
pub fn roof_block_for_color(color: RGBTuple, rng: &mut impl Rng) -> Block {
	pick_for_usage(color, USE_ROOF, rng)
}

fn pick_nearest_of(list: &[Block], color: RGBTuple, rng: &mut impl Rng) -> Block {
	let target = oklab_components(&color);
	let mut scored: Vec<(f32, Block)> = palette_lab(data::tables())
		.filter(|(_, b, _)| list.contains(b))
		.map(|(c, b, _)| (tag_match_distance(target, c), b))
		.collect();
	scored.sort_by(|a, b| a.0.total_cmp(&b.0));
	scored.truncate(3);
	scored[rng.random_range(0..scored.len())].1
}

/// A wall block for an OSM `building:material`, or `None` if unrecognized. Arnis `get_wall_block_for_material`.
pub fn get_wall_block_for_material(material: &str, rng: &mut impl Rng) -> Option<Block> {
	let normalized = norm_tag(material);
	let options = &data::tables()
		.materials
		.wall_block_for_material
		.iter()
		.find(|row| row.words.contains(&normalized))?
		.blocks;
	Some(options[rng.random_range(0..options.len())])
}

/// A roof block for an OSM `roof:material`, or `None` if unrecognized. Arnis `get_roof_block_for_material`.
pub fn get_roof_block_for_material(material: &str, rng: &mut impl Rng) -> Option<Block> {
	let normalized = norm_tag(material);
	let options = &data::tables()
		.materials
		.roof_block_for_material
		.iter()
		.find(|row| row.words.contains(&normalized))?
		.blocks;
	Some(options[rng.random_range(0..options.len())])
}

/// Which kind of fabric a building belongs to, for the regional palettes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WallTypology {
	House,
	Traditional,
	Civic,
	Modern,
}

/// The typology from category, era and height; `None` for categories that keep their own palette.
pub fn wall_typology(
	category: BuildingCategory,
	era: ArchEra,
	building_height: i32,
	ctx: &RoofContext,
) -> Option<WallTypology> {
	let modern_era = matches!(era, ArchEra::PostWarPanel | ArchEra::Contemporary);
	let old_era = matches!(era, ArchEra::HistoricOrnate | ArchEra::TraditionalPreWar);
	let high_rise = f64::from(building_height) >= 30.0 * ctx.scale;
	let american = matches!(
		ctx.materials,
		MaterialRegion::NorthAmerica | MaterialRegion::NorthAmericaSunbelt | MaterialRegion::Canada
	);
	let small_house = category == BuildingCategory::Default
		&& ctx.materials.roof_habit().is_some()
		&& !ctx.attached
		&& f64::from(building_height) <= 11.0 * ctx.scale;
	Some(match category {
		BuildingCategory::House if modern_era && !american => WallTypology::Modern,
		BuildingCategory::House => WallTypology::House,
		_ if small_house && !modern_era => WallTypology::House,
		BuildingCategory::Residential
		| BuildingCategory::Default
		| BuildingCategory::Commercial
		| BuildingCategory::Hotel => {
			if modern_era {
				WallTypology::Modern
			} else if old_era || !high_rise {
				WallTypology::Traditional
			} else if american {
				WallTypology::Civic
			} else {
				WallTypology::Modern
			}
		}
		BuildingCategory::Office | BuildingCategory::TallBuilding => {
			if modern_era || (!old_era && !american && high_rise) {
				WallTypology::Modern
			} else {
				WallTypology::Civic
			}
		}
		BuildingCategory::School | BuildingCategory::Hospital => {
			if modern_era {
				WallTypology::Modern
			} else {
				WallTypology::Civic
			}
		}
		_ => return None,
	})
}

/// The weighted wall pool of a region and typology; `None` outside the regions with a palette of their own.
pub fn regional_wall_pool(region: MaterialRegion, typology: WallTypology) -> Option<&'static [(Block, u8)]> {
	let tables = data::tables();
	let row = tables
		.wall_pools
		.pool_for
		.iter()
		.find(|row| row.matches(region, typology))?;
	let name = row.pool.as_ref()?;
	tables.wall_pools.pools.get(name).map(|pool| pool.as_slice())
}

/// An index into a weighted list by one roll.
pub fn weighted_index(weights: impl Iterator<Item = u32> + Clone, rng: &mut impl Rng) -> usize {
	let total: u32 = weights.clone().sum();
	let mut roll = rng.random_range(0..total.max(1));
	for (i, w) in weights.enumerate() {
		if roll < w {
			return i;
		}
		roll -= w;
	}
	0
}

/// The share of buildings that step outside their district's sub-palette.
const DISTRICT_STRAY_CHANCE: f64 = 0.12;

/// A wall from a regional pool: the district keeps three to five of the pool's blocks, a few buildings stray.
pub fn pick_district_wall(
	pool: &[(Block, u8)],
	category: BuildingCategory,
	climate: Climate,
	district: u64,
	rng: &mut impl Rng,
) -> Block {
	let reweight = climate != Climate::Temperate && climate_applies(climate, category);
	let timber: &[Block] = if reweight && matches!(climate, Climate::Boreal | Climate::Tundra | Climate::IceCap) {
		&data::tables().wall_pools.nordic_wood_additions
	} else {
		&[]
	};
	let mut weighted: Vec<(Block, u32)> = pool
		.iter()
		.map(|&(b, w)| (b, u32::from(w)))
		.chain(timber.iter().map(|&b| (b, 4)))
		.map(|(b, w)| {
			let factor = if reweight {
				u32::from(climate_wall_weight(climate, category, b))
			} else {
				1
			};
			(b, w * factor)
		})
		.filter(|&(_, w)| w > 0)
		.collect();
	if weighted.len() < 2 {
		weighted = pool.iter().map(|&(b, w)| (b, u32::from(w))).collect();
	}
	let mut district_rng = element_rng(district ^ 0x5B9A_1E77_D157_0002);
	let keep = district_rng.random_range(3..=5usize).min(weighted.len());
	let mut rest = weighted.clone();
	let mut sub: Vec<(Block, u32)> = Vec::with_capacity(keep);
	for _ in 0..keep {
		let i = weighted_index(rest.iter().map(|&(_, w)| w), &mut district_rng);
		sub.push(rest.swap_remove(i));
	}
	let source = if rng.random_bool(DISTRICT_STRAY_CHANCE) {
		&weighted
	} else {
		&sub
	};
	source[weighted_index(source.iter().map(|&(_, w)| w), rng)].0
}

/// The wall blocks that fit a building era; `None` for Unknown.
pub fn era_allow_list(era: ArchEra) -> Option<&'static [Block]> {
	let allow = &data::tables().wall_pools.era_allow;
	Some(match era {
		ArchEra::Unknown => return None,
		ArchEra::TraditionalPreWar => &allow.traditional_pre_war,
		ArchEra::PostWarPanel => &allow.post_war_panel,
		ArchEra::Contemporary => &allow.contemporary,
		ArchEra::HistoricOrnate => &allow.historic_ornate,
	})
}

fn era_filters_category(category: BuildingCategory) -> bool {
	matches!(
		category,
		BuildingCategory::House
			| BuildingCategory::Residential
			| BuildingCategory::Commercial
			| BuildingCategory::Office
			| BuildingCategory::Hotel
			| BuildingCategory::Default
	)
}

/// Whether climate reweighting applies to this category in this climate.
pub fn climate_applies(climate: Climate, category: BuildingCategory) -> bool {
	match category {
		BuildingCategory::House | BuildingCategory::Residential => true,
		BuildingCategory::Commercial | BuildingCategory::Office | BuildingCategory::Hotel => {
			matches!(
				climate,
				Climate::HotDesert | Climate::HotSteppe | Climate::TropicalSavanna
			)
		}
		_ => false,
	}
}

/// The per-block weight for climate-adapted palettes: 1 neutral, 0 excluded.
pub fn climate_wall_weight(climate: Climate, category: BuildingCategory, block: Block) -> u8 {
	let tables = &data::tables().wall_pools;
	let residential_scale = |w: u8| {
		if category == BuildingCategory::Residential {
			(w / 2).max(1)
		} else {
			w
		}
	};
	let (group, scaled): (&str, &[Block]) = match climate {
		Climate::Temperate => return 1,
		Climate::HotDesert | Climate::HotSteppe => ("hot", &[]),
		Climate::TropicalSavanna => ("tropical_savanna", &[]),
		Climate::Boreal => ("boreal", &tables.climate_residential_scaled.boreal),
		Climate::Tundra | Climate::IceCap => ("polar", &tables.climate_residential_scaled.polar),
		Climate::ColdSteppe | Climate::ColdDesert | Climate::DryContinental => ("cold_dry", &[]),
	};
	let weight = tables
		.climate_weights
		.get(group)
		.and_then(|m| m.get(&block))
		.copied()
		.unwrap_or(1);
	if scaled.contains(&block) {
		residential_scale(weight)
	} else {
		weight
	}
}

/// A weighted wall pick with the rare-block damping of `pick_with_rare_filter`.
fn pick_weighted_wall(pool: &[(Block, u8)], rare_exempt: Option<Block>, rng: &mut impl Rng) -> Block {
	let total: u32 = pool.iter().map(|&(_, w)| w as u32).sum();
	for _ in 0..8 {
		let mut roll = rng.random_range(0..total);
		let mut picked = pool[0].0;
		for &(b, w) in pool {
			if roll < w as u32 {
				picked = b;
				break;
			}
			roll -= w as u32;
		}
		if !is_rare_wall_block(picked) || Some(picked) == rare_exempt || rng.random_bool(0.20) {
			return picked;
		}
	}
	pool[0].0
}

/// A pick from `palette`, biased against rare blocks.
pub fn pick_with_rare_filter<R: Rng>(palette: &[Block], rng: &mut R) -> Block {
	let mut last = palette[rng.random_range(0..palette.len())];
	for _ in 0..8 {
		if !is_rare_wall_block(last) || rng.random_bool(0.20) {
			return last;
		}
		last = palette[rng.random_range(0..palette.len())];
	}
	last
}

fn uniform<R: Rng>(palette: &[Block], rng: &mut R) -> Block {
	palette[rng.random_range(0..palette.len())]
}

/// A wall block from the category palette. Arnis `get_wall_block_for_category`.
pub fn get_wall_block_for_category(
	category: BuildingCategory,
	era: ArchEra,
	climate: Climate,
	rng: &mut impl Rng,
) -> Block {
	let p = &data::tables().wall_pools.category_palettes;
	if climate != Climate::Temperate && climate_applies(climate, category) {
		let palette: &[Block] = match category {
			BuildingCategory::House | BuildingCategory::Residential => &p.residential,
			_ => &p.commercial,
		};
		let nordic = matches!(climate, Climate::Boreal | Climate::Tundra | Climate::IceCap)
			&& matches!(category, BuildingCategory::House | BuildingCategory::Residential);
		let allow = era_allow_list(era);
		let extra: &[Block] = if nordic {
			&data::tables().wall_pools.nordic_wood_additions
		} else {
			&[]
		};
		let pool: Vec<(Block, u8)> = palette
			.iter()
			.chain(extra.iter())
			.copied()
			.filter(|b| allow.is_none_or(|a| a.contains(b)))
			.map(|b| (b, climate_wall_weight(climate, category, b)))
			.filter(|&(_, w)| w > 0)
			.collect();
		if pool.len() >= 2 {
			let rare_exempt =
				matches!(climate, Climate::Boreal | Climate::Tundra | Climate::IceCap).then_some(Block::RedTerracotta);
			return pick_weighted_wall(&pool, rare_exempt, rng);
		}
	}
	if era_filters_category(category) {
		if let Some(allow) = era_allow_list(era) {
			let palette: &[Block] = match category {
				BuildingCategory::House | BuildingCategory::Residential => &p.residential,
				BuildingCategory::Commercial | BuildingCategory::Office | BuildingCategory::Hotel => &p.commercial,
				_ => &[],
			};
			let filtered: Vec<Block> = palette.iter().copied().filter(|b| allow.contains(b)).collect();
			return if filtered.len() >= 4 {
				pick_with_rare_filter(&filtered, rng)
			} else {
				pick_with_rare_filter(allow, rng)
			};
		}
	}
	match category {
		BuildingCategory::House | BuildingCategory::Residential => pick_with_rare_filter(&p.residential, rng),
		BuildingCategory::Commercial | BuildingCategory::Office | BuildingCategory::Hotel => {
			pick_with_rare_filter(&p.commercial, rng)
		}
		BuildingCategory::Industrial | BuildingCategory::Warehouse => pick_with_rare_filter(&p.industrial, rng),
		BuildingCategory::Religious => pick_with_rare_filter(&p.religious, rng),
		BuildingCategory::School | BuildingCategory::Hospital => pick_with_rare_filter(&p.institutional, rng),
		BuildingCategory::Farm => pick_with_rare_filter(&p.farm, rng),
		BuildingCategory::Historic => pick_with_rare_filter(&p.historic, rng),
		BuildingCategory::Garage => pick_with_rare_filter(&p.garage, rng),
		BuildingCategory::Shed => uniform(&p.shed, rng),
		BuildingCategory::Tower => uniform(&p.tower, rng),
		BuildingCategory::Greenhouse => uniform(&p.greenhouse, rng),
		BuildingCategory::TallBuilding => uniform(&p.commercial, rng),
		BuildingCategory::ModernSkyscraper => uniform(&p.modern_skyscraper, rng),
		BuildingCategory::ContemporarySkyscraper | BuildingCategory::GridSkyscraper => uniform(&p.contemporary, rng),
		BuildingCategory::MasonrySkyscraper => {
			if rng.random_bool(0.5) {
				uniform(&p.masonry_warm, rng)
			} else {
				uniform(&p.masonry_gray, rng)
			}
		}
		BuildingCategory::GlassySkyscraper | BuildingCategory::GlassCornerSkyscraper => uniform(&p.glassy, rng),
		BuildingCategory::Default => uniform(&p.fallback, rng),
	}
}

/// Walls, towers and ruins that keep castle masonry under `historic=*`.
fn is_fortification(tags: &Tags) -> bool {
	let materials = &data::tables().materials;
	let has = |key: &str, values: &[String]| tags.get(key).is_some_and(|value| values.iter().any(|v| v == value));
	has("building", &materials.fortification_buildings) || has("historic", &materials.fortification_historic)
}

/// The wall for a building without material or colour tags: the regional palette where the region has one, else
/// the category palette. Arnis `determine_wall_block`.
pub fn determine_wall_block(
	tags: &Tags,
	category: BuildingCategory,
	era: ArchEra,
	climate: Climate,
	building_height: i32,
	ctx: &RoofContext,
	rng: &mut impl Rng,
) -> Block {
	if tags.get("historic").map(String::as_str) == Some("castle") {
		return uniform(&data::tables().wall_pools.category_palettes.castle, rng);
	}
	let typology = if category == BuildingCategory::Historic {
		(!is_fortification(tags)).then_some(WallTypology::Civic)
	} else {
		wall_typology(category, era, building_height, ctx)
	};
	if let Some(pool) = typology.and_then(|t| regional_wall_pool(ctx.materials, t)) {
		return pick_district_wall(pool, category, climate, ctx.district, rng);
	}
	get_wall_block_for_category(category, era, climate, rng)
}

/// The floor slabs of a building whose glazing shows them.
pub fn concrete_floor_for(category: BuildingCategory, picked: Block) -> Block {
	let wooden_floors = matches!(
		category,
		BuildingCategory::House
			| BuildingCategory::Residential
			| BuildingCategory::Farm
			| BuildingCategory::Historic
			| BuildingCategory::Religious
	);
	match picked {
		Block::OakPlanks if !wooden_floors => Block::PolishedAndesite,
		Block::MudBricks if !wooden_floors => Block::SmoothStone,
		_ => picked,
	}
}

pub fn get_floor_block_with_rng(rng: &mut impl Rng) -> Block {
	uniform(&data::tables().wall_pools.category_palettes.floor, rng)
}

/// The window glass pool per category.
pub fn window_pool_for_category(category: BuildingCategory) -> &'static [Block] {
	let glass = &data::tables().glass;
	let name = glass
		.pool_for_category
		.get(&category)
		.map(String::as_str)
		.unwrap_or("variations");
	glass.window_pools.get(name).map(|pool| pool.as_slice()).unwrap_or(&[])
}

/// Dark walls and dark accent bands take dark glass.
pub fn coordinated_window_block(wall_block: Block, accent_block: Block, picked: Block) -> Block {
	const DARK: &[Block] = &[
		Block::BlackConcrete,
		Block::GrayConcrete,
		Block::Blackstone,
		Block::PolishedBlackstone,
		Block::PolishedBlackstoneBricks,
		Block::DeepslateBricks,
		Block::PolishedDeepslate,
		Block::CobbledDeepslate,
		Block::NetherBrick,
		Block::RedNetherBricks,
		Block::BlackTerracotta,
		Block::GrayTerracotta,
		Block::BrownTerracotta,
		Block::DarkOakPlanks,
	];
	if !(DARK.contains(&wall_block) || DARK.contains(&accent_block)) {
		picked
	} else if matches!(picked, Block::GrayStainedGlass | Block::BlackStainedGlass) {
		Block::BlackStainedGlass
	} else {
		Block::GrayStainedGlass
	}
}

/// A candidate list from a trim-rule map for a wall.
fn rule_blocks(rules: &[data::TrimRule], wall: Block, accent: Option<Block>) -> &[Block] {
	for rule in rules {
		if rule.walls.contains(&wall)
			|| (rule.glass && is_glass_wall(wall) && !rule.glass_and_glass_accent)
			|| (rule.glass_and_glass_accent && is_glass_wall(wall) && accent.is_some_and(is_glass_wall))
			|| rule.default
		{
			return &rule.blocks;
		}
	}
	&[]
}

/// The trim stone that suits the wall. Arnis `accent_for_wall`.
pub fn accent_for_wall(wall: Block, rng: &mut impl Rng) -> Block {
	let options = rule_blocks(&data::tables().trim.accent, wall, None);
	options[rng.random_range(0..options.len())]
}

/// The darker plinth block for a wall. Arnis `base_course_for_wall`.
pub fn base_course_for_wall(wall: Block) -> Block {
	rule_blocks(&data::tables().trim.base_course, wall, None)[0]
}

/// Light stone for lintels, sills and cornices, set off against the wall. Arnis `trim_block_for_wall`.
pub fn trim_block_for_wall(wall: Block, seed: u64) -> Block {
	let rules = &data::tables().trim.trim;
	for rule in rules {
		if rule.walls.contains(&wall) || rule.default {
			return if rule.seeded {
				rule.blocks[element_rng(seed ^ 0x7121_A57E_0000_0001).random_range(0..rule.blocks.len())]
			} else {
				rule.blocks[0]
			};
		}
	}
	Block::PolishedDiorite
}

/// The coping of a parapet in `wall`, as its full block. Arnis `rooftops::coping_for` picks a slab; a slab of a
/// wall's own family reads as that wall, so the accent and wall arms return the block itself.
pub fn coping_for(wall: Block, accent: Block, seed: u64) -> Block {
	let rules = &data::tables().trim.coping;
	let rule = rules.iter().find(|rule| {
		rule.walls.contains(&wall)
			|| (rule.glass_and_glass_accent && is_glass_wall(wall) && is_glass_wall(accent))
			|| (rule.glass && !rule.glass_and_glass_accent && is_glass_wall(wall))
			|| rule.default
	});
	match rule {
		Some(rule) if rule.accent => slab_of(accent),
		Some(rule) if rule.wall => slab_of(wall),
		Some(rule) => {
			rule.blocks[(crate::rng::hash2(seed ^ 0xC0B1_4600_0000_0001, 0, 0) % rule.blocks.len() as u64) as usize]
		}
		None => slab_of(wall),
	}
}

/// The block whose slab Arnis `get_slab_block_for_material` makes for a material.
pub fn slab_of(material: Block) -> Block {
	rule_blocks(&data::tables().trim.slab_of, material, None)
		.first()
		.copied()
		.unwrap_or(Block::StoneBricks)
}

/// Grey or black glass for a masonry tower.
pub fn masonry_window_glass(wall: Block, seed: u64) -> Block {
	if is_dark_wall(wall) || element_rng(seed ^ 0x6A55_0F7E_0000_0001).random_bool(0.7) {
		Block::GrayStainedGlass
	} else {
		Block::BlackStainedGlass
	}
}

/// The dark panel between the storeys of an art-deco shaft.
pub fn deco_spandrel_for_wall(wall: Block, seed: u64) -> Block {
	let spandrel = &data::tables().trim.deco_spandrel;
	let options: &[Block] = if is_dark_wall(wall) || (crate::block::is_masonry_wall(wall) && !is_light_stone(wall)) {
		&spandrel.dark_or_masonry
	} else if is_warm_stone(wall) {
		&spandrel.warm_stone
	} else {
		&spandrel.default
	};
	options[element_rng(seed ^ 0x6A55_0F7E_0000_0002).random_range(0..options.len())]
}

/// What stands behind the glass of an empty shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlassBacking {
	pub panel: Block,
	pub alt: Block,
	pub spandrel: Block,
}

/// Backing for a glass tint. Arnis `glass_backing`.
pub fn glass_backing(glass: Block) -> GlassBacking {
	let backing = &data::tables().glass.backing;
	let row = backing
		.get(&glass.name())
		.or_else(|| backing.get("default"))
		.copied()
		.unwrap_or([Block::WhiteConcrete, Block::SmoothStone, Block::LightGrayConcrete]);
	GlassBacking {
		panel: row[0],
		alt: row[1],
		spandrel: row[2],
	}
}

/// Stained glass for the mapped colour of a glass building. Arnis `glass_for_colour`.
pub fn glass_for_colour(rgb: RGBTuple) -> Block {
	let (l, a, b) = oklab_components(&rgb);
	let chroma = a.hypot(b);
	let hue = b.atan2(a).to_degrees().rem_euclid(360.0);
	let warm = !(100.0..300.0).contains(&hue);
	if warm && l >= 0.75 {
		return Block::LightGrayStainedGlass;
	}
	if chroma >= 0.08 {
		return match hue {
			_ if warm => Block::BrownStainedGlass,
			h if h < 230.0 || chroma < 0.18 => Block::CyanStainedGlass,
			_ if l < 0.7 => Block::BlueStainedGlass,
			_ => Block::LightBlueStainedGlass,
		};
	}
	if warm && chroma >= 0.05 {
		Block::BrownStainedGlass
	} else if l < 0.53 {
		Block::BlackStainedGlass
	} else if !warm && chroma >= 0.02 && l < 0.78 {
		Block::CyanStainedGlass
	} else if l < 0.72 {
		Block::GrayStainedGlass
	} else {
		Block::LightGrayStainedGlass
	}
}

/// The opaque panel between the glass bands of a post-war curtain wall.
pub fn spandrel_panel(glass: Block) -> Block {
	data::tables()
		.glass
		.spandrel_panel
		.get(&glass.name())
		.copied()
		.unwrap_or_else(|| glass_backing(glass).spandrel)
}

/// The corner pier of a glass grid.
pub fn curtain_frame_for(glass: Block) -> Block {
	let frame = &data::tables().glass.curtain_frame;
	frame
		.get(&glass.name())
		.or_else(|| frame.get("default"))
		.copied()
		.unwrap_or(Block::SmoothStone)
}

/// The wall and window glass of a building whose walls are tagged as glass. Arnis `glass_palette`.
pub fn glass_palette(
	tags: &Tags,
	category: BuildingCategory,
	wall_block: Block,
	window_block: Block,
) -> (Block, Block) {
	let mut materials = ["building:material", "building:facade:material", "facade:material"]
		.iter()
		.filter_map(|key| tags.get(*key))
		.map(|m| matches!(m.trim().to_ascii_lowercase().as_str(), "glass" | "mirror"));
	let first_material = materials.next();
	let glass_tagged = first_material == Some(true) || materials.any(|glass| glass);
	let other_material = first_material.is_some() && !glass_tagged;
	let colour = colour_tag(tags);
	let colour_glass = colour.map(glass_for_colour);
	let tint = colour_glass.filter(|_| glass_tagged);
	let stone_colour = colour.is_some_and(|rgb| {
		let (_, a, b) = oklab_components(&rgb);
		let hue = b.atan2(a).to_degrees().rem_euclid(360.0);
		!(100.0..300.0).contains(&hue) && a.hypot(b) >= 0.03
	});
	match category {
		_ if other_material => (wall_block, window_block),
		BuildingCategory::GlassySkyscraper | BuildingCategory::GlassCornerSkyscraper => {
			let own_glass = is_glass_wall(wall_block).then_some(wall_block);
			let wall = colour_glass
				.filter(|_| glass_tagged || !stone_colour)
				.or(own_glass)
				.unwrap_or(Block::GrayStainedGlass);
			(wall, window_block)
		}
		BuildingCategory::GridSkyscraper => match tint.or(is_glass_wall(wall_block).then_some(wall_block)) {
			Some(glass) => (glass, glass),
			None => (wall_block, window_block),
		},
		_ if is_glass_wall(wall_block) => (tint.unwrap_or(wall_block), window_block),
		_ => (wall_block, window_block),
	}
}

/// Whether a facade is a glass curtain wall.
pub fn is_curtain_wall(category: BuildingCategory, has_windows: bool, wall_block: Block) -> bool {
	is_glass_wall(wall_block)
		&& category != BuildingCategory::Greenhouse
		&& (!has_windows || category == BuildingCategory::GridSkyscraper)
}

/// The pier at a glass tower's corner.
pub fn corner_pier(accent_block: Block) -> Block {
	if is_glass_wall(accent_block) {
		Block::LightGrayConcrete
	} else {
		accent_block
	}
}

/// What shows through the glass of a building whose interior is an empty shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellGlass {
	Plain,
	Backed,
	Hall,
}

pub fn shell_glass_for(
	tags: &Tags,
	category: BuildingCategory,
	building_type: &str,
	wall_block: Block,
	furnished: bool,
) -> ShellGlass {
	if furnished || category == BuildingCategory::Greenhouse || matches!(building_type, "greenhouse" | "glasshouse") {
		return ShellGlass::Plain;
	}
	let glass_wall = is_glass_wall(wall_block);
	if glass_wall && is_glass_hall(tags, building_type) {
		ShellGlass::Hall
	} else if glass_wall
		|| matches!(
			category,
			BuildingCategory::GlassySkyscraper
				| BuildingCategory::GlassCornerSkyscraper
				| BuildingCategory::GridSkyscraper
				| BuildingCategory::ModernSkyscraper
		) {
		ShellGlass::Backed
	} else {
		ShellGlass::Plain
	}
}

/// Whether a glass-walled building is one open hall rather than glazed storeys.
fn is_glass_hall(tags: &Tags, building_type: &str) -> bool {
	let levels = tags.get("building:levels").and_then(|l| l.trim().parse::<f64>().ok());
	if levels.is_some_and(|l| l >= 2.0) {
		return false;
	}
	let glass_vault = tags.get("roof:material").map(String::as_str) == Some("glass")
		&& tags
			.get("roof:shape")
			.is_some_and(|shape| crate::roof::parse_roof_type(shape) != crate::category::RoofType::Flat);
	levels.is_some() || glass_vault || matches!(building_type, "pavilion" | "conservatory" | "train_station" | "hangar")
}

/// Squared Oklab distance, re-exported for callers that keep one target converted.
pub fn lab_distance(a: (f32, f32, f32), b: (f32, f32, f32)) -> f32 {
	oklab_distance_lab(a, b)
}
