// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Arnis `src/element_processing/buildings.rs` and `src/element_processing/rooftops.rs` at commit
// d8e8b662 (github.com/louis-e/arnis, Apache-2.0): the roof shape defaults, the pitched covering, the tagged
// covering, the flat membrane and the parapet share. Modified: the pools and shares read
// `packages/structures/data/facade/roof-pools.json` and `chances.json`; the membrane keeps its three blocks but
// lays no patches here.

//! What shape a roof takes and what it is covered in.

use rand::Rng;

use crate::block::{is_glass_wall, Block};
use crate::category::{BuildingCategory, Outline, RoofType};
use crate::climate::Climate;
use crate::color::{color_text_to_rgb_tuple, norm_tag, oklab_components, RGBTuple};
use crate::data;
use crate::region::{BuildingRegion, MaterialRegion};
use crate::rng::element_rng;
use crate::seed::{ArchEra, Tags};
use crate::style::RoofContext;
use crate::walls::{get_roof_block_for_material, roof_block_for_color, weighted_index};

/// The roof type a `roof:shape` value names; everything unknown is flat.
pub fn parse_roof_type(roof_shape: &str) -> RoofType {
	match roof_shape {
		"gabled" | "gable" | "pitched" | "saltbox" | "double_saltbox" | "quadruple_saltbox" | "gabled_row" => {
			RoofType::Gabled
		}
		"hipped" | "hip" | "side_hipped" => RoofType::Hipped,
		"round" | "barrel" | "vault" | "vaulted" => RoofType::Round,
		"mansard" => RoofType::Mansard,
		"gambrel" => RoofType::Gambrel,
		"half-hipped" | "half_hipped" | "side_half-hipped" => RoofType::HalfHipped,
		"skillion" | "shed" | "lean_to" | "monopitch" => RoofType::Skillion,
		"pyramidal" | "pyramid" => RoofType::Pyramidal,
		"dome" | "spherical" => RoofType::Dome,
		"cone" | "conical" | "circular" | "spire" => RoofType::Cone,
		"onion" => RoofType::Onion,
		_ => RoofType::Flat,
	}
}

/// Building types that default to a pitched roof without a `roof:shape`.
pub fn qualifies_for_auto_gabled_roof(building_type: &str) -> bool {
	matches!(
		building_type,
		"apartments"
			| "residential"
			| "house" | "yes"
			| "detached"
			| "semidetached_house"
			| "terrace"
			| "bungalow"
			| "villa" | "cabin"
			| "hut" | "farm"
			| "farm_auxiliary"
			| "barn" | "stable"
			| "cowshed"
			| "sty" | "sheepfold"
	)
}

/// Detached house types: the stock that keeps a pitched roof in a flat-roofed North American city.
pub fn is_house_type(building_type: &str) -> bool {
	matches!(
		building_type,
		"house"
			| "detached"
			| "semidetached_house"
			| "bungalow"
			| "villa" | "cabin"
			| "hut" | "farm"
			| "farm_auxiliary"
			| "barn" | "stable"
			| "cowshed"
			| "sty" | "sheepfold"
	)
}

/// The roof of a building that counts storeys in its roof (`roof:levels`) but names no shape.
pub fn roof_levels_roof(tags: &Tags, era: ArchEra, ctx: &RoofContext) -> Option<(RoofType, bool)> {
	let levels = tags
		.get("roof:levels")
		.and_then(|v| v.trim().parse::<f64>().ok())
		.filter(|l| *l >= 1.0)?;
	if tags.contains_key("building:part") {
		return None;
	}
	if tags.contains_key("height") && (tags.contains_key("roof:height") || tags.contains_key("roof:angle")) {
		return None;
	}
	let pre_war = matches!(
		era,
		ArchEra::HistoricOrnate | ArchEra::TraditionalPreWar | ArchEra::Unknown
	);
	let roof = match ctx.region {
		BuildingRegion::NorthAmerica if ctx.attached && pre_war => RoofType::Mansard,
		BuildingRegion::Europe if era == ArchEra::HistoricOrnate && levels >= 2.0 => RoofType::Mansard,
		_ if ctx.attached => RoofType::Gabled,
		_ => RoofType::Hipped,
	};
	Some((roof, true))
}

const CIVIC_AND_COMMERCIAL: &[&str] = &[
	"commercial",
	"retail",
	"office",
	"hotel",
	"public",
	"civic",
	"government",
	"school",
	"university",
	"college",
	"kindergarten",
	"townhall",
	"historic",
	"palace",
	"castle",
	"museum",
	"theatre",
];

/// The roof of an untagged European building that is not a detached house. Arnis `european_default_roof`.
#[allow(clippy::too_many_arguments)]
pub fn european_default_roof(
	tags: &Tags,
	outline: &Outline,
	building_type: &str,
	era: ArchEra,
	building_height: i32,
	footprint_size: usize,
	style_seed: u64,
	ctx: &RoofContext,
) -> Option<(RoofType, bool)> {
	let chances = &data::tables().chances;
	if ctx.region != BuildingRegion::Europe
		|| ctx.materials.roof_habit().is_some()
		|| tags.contains_key("building:part")
	{
		return None;
	}
	let urban_type = matches!(building_type, "apartments" | "residential" | "yes" | "terrace")
		|| CIVIC_AND_COMMERCIAL.contains(&building_type);
	if !urban_type && !qualifies_for_auto_gabled_roof(building_type) {
		return None;
	}
	let scale_sq = ctx.scale * ctx.scale;
	let footprint_m2 = footprint_size as f64 / scale_sq;
	let tall_block = tags
		.get("building:levels")
		.and_then(|l| l.trim().parse::<f64>().ok())
		.is_some_and(|l| l > 7.0);
	if f64::from(building_height) > 26.0 * ctx.scale || tall_block {
		return Some((RoofType::Flat, false));
	}
	if footprint_m2 > 3000.0 {
		return None;
	}
	if !outline.nodes.is_empty() {
		let (min_x, max_x, min_z, max_z) = outline.bounds();
		let bbox_cells = (f64::from(max_x - min_x + 1) * f64::from(max_z - min_z + 1)).max(1.0);
		if (footprint_size as f64 / bbox_cells) < 0.5 {
			return None;
		}
	}
	let commercial = CIVIC_AND_COMMERCIAL.contains(&building_type)
		&& !matches!(building_type, "historic" | "palace" | "castle" | "townhall");
	let s = &chances.european_roof_share;
	let share = match era {
		ArchEra::HistoricOrnate => s.historic_ornate,
		ArchEra::TraditionalPreWar => s.traditional_pre_war,
		ArchEra::PostWarPanel if commercial => s.post_war_panel_commercial,
		ArchEra::PostWarPanel => s.post_war_panel,
		ArchEra::Contemporary if commercial => s.contemporary_commercial,
		ArchEra::Contemporary => s.contemporary,
		ArchEra::Unknown if ctx.attached => s.unknown_attached,
		ArchEra::Unknown if footprint_m2 > 1500.0 => s.unknown_large,
		ArchEra::Unknown if !urban_type => return None,
		ArchEra::Unknown => s.unknown,
	};
	let mut rng = element_rng(style_seed ^ 0x5E0F_EA57_0C1D_70B5);
	if !rng.random_bool(share) {
		return Some((RoofType::Flat, false));
	}
	let tall = f64::from(building_height) >= 14.0 * ctx.scale;
	let roof = if era == ArchEra::HistoricOrnate
		&& footprint_m2 >= 400.0
		&& tall
		&& rng.random_bool(chances.european_mansard_share)
	{
		RoofType::Mansard
	} else if ctx.attached {
		RoofType::Gabled
	} else {
		RoofType::Hipped
	};
	Some((roof, true))
}

/// The roof of an untagged building where the region has a roof habit of its own. Arnis `regional_default_roof`.
#[allow(clippy::too_many_arguments)]
pub fn regional_default_roof(
	tags: &Tags,
	building_type: &str,
	era: ArchEra,
	climate: Climate,
	building_height: i32,
	footprint_size: usize,
	style_seed: u64,
	ctx: &RoofContext,
) -> Option<(RoofType, bool)> {
	let habit = ctx.materials.roof_habit()?;
	if tags.contains_key("building:part") || !qualifies_for_auto_gabled_roof(building_type) {
		return None;
	}
	let footprint_m2 = footprint_size as f64 / (ctx.scale * ctx.scale);
	let height_m = f64::from(building_height) / ctx.scale;
	let house = is_house_type(building_type)
		|| building_type == "terrace"
		|| (matches!(building_type, "yes" | "residential")
			&& !ctx.attached
			&& footprint_m2 <= 220.0
			&& height_m <= 11.0);
	let modern = matches!(era, ArchEra::PostWarPanel | ArchEra::Contemporary);
	let mut chance = if footprint_m2 > 1500.0 {
		0.0
	} else if house {
		habit.house
	} else if height_m <= habit.block_max_m {
		if modern {
			habit.block * 0.5
		} else {
			habit.block
		}
	} else {
		0.0
	};
	if ctx.materials != MaterialRegion::Australasia {
		chance *= match climate {
			Climate::HotDesert => 0.35,
			Climate::HotSteppe => 0.7,
			_ => 1.0,
		};
	}
	let mut rng = element_rng(style_seed ^ 0x2E61_0A1F_0F5E_7001);
	if !rng.random_bool(chance) {
		return Some((RoofType::Flat, false));
	}
	let roof = if ctx.attached || building_type == "terrace" || !rng.random_bool(habit.hipped) {
		RoofType::Gabled
	} else {
		RoofType::Hipped
	};
	Some((roof, true))
}

/// The probability that an auto-gabled candidate gets the pitched roof.
pub fn climate_gable_probability(climate: Climate) -> f64 {
	match climate {
		Climate::HotDesert | Climate::HotSteppe => 0.35,
		Climate::TropicalSavanna => 0.60,
		Climate::Boreal | Climate::Tundra | Climate::IceCap => 0.95,
		_ => 0.90,
	}
}

/// The footprint's area over its bounding box's, 1.0 for a degenerate ring.
pub fn compute_building_diagonality(nodes: &[(i32, i32)]) -> f64 {
	if nodes.len() < 3 {
		return 1.0;
	}
	let mut area = 0i64;
	for i in 0..nodes.len() {
		let j = (i + 1) % nodes.len();
		area += (nodes[i].0 as i64) * (nodes[j].1 as i64);
		area -= (nodes[j].0 as i64) * (nodes[i].1 as i64);
	}
	let polygon_area = (area.abs() as f64) / 2.0;
	let min_x = nodes.iter().map(|n| n.0).min().unwrap_or(0);
	let max_x = nodes.iter().map(|n| n.0).max().unwrap_or(0);
	let min_z = nodes.iter().map(|n| n.1).min().unwrap_or(0);
	let max_z = nodes.iter().map(|n| n.1).max().unwrap_or(0);
	let bbox_area = ((max_x - min_x + 1) * (max_z - min_z + 1)) as f64;
	if bbox_area <= 0.0 {
		return 1.0;
	}
	(polygon_area / bbox_area).min(1.0)
}

/// The length-weighted dominant edge angle in radians, folded to (-45, 45] degrees.
pub fn dominant_axis_angle(nodes: &[(i32, i32)]) -> f64 {
	let mut sum_c = 0.0f64;
	let mut sum_s = 0.0f64;
	for i in 0..nodes.len() {
		let j = (i + 1) % nodes.len();
		let dx = (nodes[j].0 - nodes[i].0) as f64;
		let dz = (nodes[j].1 - nodes[i].1) as f64;
		let len = (dx * dx + dz * dz).sqrt();
		if len < 3.0 {
			continue;
		}
		let ang = dz.atan2(dx);
		sum_c += len * (4.0 * ang).cos();
		sum_s += len * (4.0 * ang).sin();
	}
	if sum_c == 0.0 && sum_s == 0.0 {
		return 0.0;
	}
	sum_s.atan2(sum_c) / 4.0
}

fn pool_named(name: &str) -> &'static [(Block, u8)] {
	data::tables()
		.roof_pools
		.pools
		.get(name)
		.map(|p| p.as_slice())
		.unwrap_or(&[])
}

/// The covering of a pitched roof, from the region's families, with a district dominant. Arnis
/// `pitched_roof_block`.
pub fn pitched_roof_block(
	category: BuildingCategory,
	era: ArchEra,
	roof_type: RoofType,
	wall_block: Block,
	ctx: &RoofContext,
	style_seed: u64,
) -> Block {
	let roofs = &data::tables().roof_pools;
	let civic = matches!(category, BuildingCategory::Religious | BuildingCategory::Historic);
	let spire = matches!(roof_type, RoofType::Dome | RoofType::Onion | RoofType::Cone)
		|| (roof_type == RoofType::Pyramidal && category == BuildingCategory::Religious);
	let house = matches!(
		category,
		BuildingCategory::House | BuildingCategory::Farm | BuildingCategory::Garage
	) || (!ctx.attached && matches!(category, BuildingCategory::Default | BuildingCategory::Residential));
	let pool: &[(Block, u8)] = if spire {
		pool_named("spire")
	} else if roof_type == RoofType::Mansard {
		if ctx.materials == MaterialRegion::France {
			pool_named("french_mansard")
		} else {
			pool_named("mansard")
		}
	} else if matches!(category, BuildingCategory::Industrial | BuildingCategory::Warehouse) {
		pool_named("industrial")
	} else {
		let choice = roofs.pool_for_region.get(&ctx.materials);
		let name = match choice {
			Some(choice) => choice
				.house
				.as_deref()
				.filter(|_| house)
				.unwrap_or(choice.other.as_str()),
			None => "other",
		};
		pool_named(name)
	};
	let european =
		ctx.materials.building_region() == BuildingRegion::Europe && ctx.materials != MaterialRegion::EastEurope;
	let modern = matches!(era, ArchEra::PostWarPanel | ArchEra::Contemporary);
	let weights =
		|pool: &[(Block, u8)]| -> Vec<(Block, u32)> { pool.iter().map(|&(b, w)| (b, u32::from(w))).collect() };
	let mut rng = element_rng(style_seed ^ 0x2F0F_C0DE_0000_0004);
	let roof = if spire {
		let all = weights(pool);
		all[weighted_index(all.iter().map(|&(_, w)| w), &mut rng)].0
	} else {
		let mut district_rng = element_rng(ctx.district ^ 0x2F0F_C0DE_D157_0003);
		let regional = weights(pool);
		let french_tile = |b: Block| ctx.materials == MaterialRegion::France && roofs.tile_families.contains(&b);
		let painted = |b: Block| ctx.materials != MaterialRegion::EastEurope && roofs.painted_sheet.contains(&b);
		let dominant_weights = regional.iter().map(|&(b, w)| {
			if b == roofs.tile_brown || french_tile(b) || painted(b) {
				0
			} else {
				w
			}
		});
		let dominant = regional[weighted_index(dominant_weights, &mut district_rng)].0;
		let mut own = regional;
		if civic {
			own.push((Block::DeepslateTiles, 20));
			own.push((Block::WaxedOxidizedCopper, 10));
		} else if european && modern {
			own.push((Block::CobbledDeepslate, 15));
			own.push((roofs.tile_brown, 10));
		}
		let share = if european {
			roofs.district_roof_share
		} else {
			roofs.district_roof_share_elsewhere
		};
		let independent = civic || modern || rng.random_bool(1.0 - share);
		if independent {
			own[weighted_index(own.iter().map(|&(_, w)| w), &mut rng)].0
		} else {
			dominant
		}
	};
	roof_distinct_from_wall(roof, wall_block, ctx.materials)
}

/// A roof in the wall's own tone moves to a neighboring shade. Arnis `roof_distinct_from_wall`.
pub fn roof_distinct_from_wall(roof: Block, wall: Block, region: MaterialRegion) -> Block {
	let tones = &data::tables().trim.roof_distinct_from_wall;
	let warm_tone = [&tones.brick_tone, &tones.red_tone, &tones.orange_tone]
		.into_iter()
		.find(|tone| tone.contains(&roof));
	let clash = roof == wall
		|| warm_tone.is_some_and(|tone| tone.contains(&wall))
		|| (tones.mid_grey.contains(&roof) && tones.mid_grey.contains(&wall));
	if !clash {
		roof
	} else if warm_tone.is_some() && region != MaterialRegion::BritishIsles {
		if warm_tone == Some(&tones.red_tone) {
			Block::Brick
		} else {
			Block::RedTerracotta
		}
	} else if roof == Block::DeepslateTiles || region == MaterialRegion::BrickNorth {
		Block::PolishedBlackstoneBricks
	} else {
		Block::DeepslateTiles
	}
}

/// The roof covering `roof:material` and `roof:colour` ask for, or `None` without either. Arnis `tagged_roof_block`.
pub fn tagged_roof_block(tags: &Tags, pitched: bool, chosen: Option<Block>, rng: &mut impl Rng) -> Option<Block> {
	let material = tags.get("roof:material");
	let color = tags.get("roof:colour").and_then(|c| color_text_to_rgb_tuple(c));
	if !pitched {
		return material
			.and_then(|m| get_roof_block_for_material(m, rng))
			.or_else(|| color.map(|rgb| roof_block_for_color(rgb, rng)));
	}
	if let Some(family) = material.and_then(|m| roof_material_family(m)) {
		return Some(match color {
			Some(rgb) => nearest_roof_shade(family, rgb).0,
			None => chosen
				.filter(|b| family.contains(b))
				.unwrap_or_else(|| family[rng.random_range(0..family.len())]),
		});
	}
	if let (Some(rgb), true) = (color, material.is_some_and(|m| is_sheet_metal(m))) {
		return Some(roof_family_for_color(rgb, rng));
	}
	if let Some(block) = material.and_then(|m| get_roof_block_for_material(m, rng)) {
		return Some(block);
	}
	color.map(|rgb| roof_family_for_color(rgb, rng))
}

/// Whether a `roof:material` value is sheet metal.
fn is_sheet_metal(material: &str) -> bool {
	let normalized = norm_tag(material);
	data::tables().materials.sheet_metal.contains(&normalized)
}

/// The roof family a `roof:material` value names; `None` for the materials that map to one block of their own.
fn roof_material_family(material: &str) -> Option<&'static [Block]> {
	let normalized = norm_tag(material);
	let tables = data::tables();
	let row = tables
		.materials
		.roof_material_families
		.iter()
		.find(|row| row.words.contains(&normalized))?;
	Some(match row.family.as_str() {
		"tile" => &tables.roof_pools.tile_families,
		"concrete_tile" => &tables.roof_pools.concrete_tile,
		"slate" => &tables.roof_pools.slate_family,
		"copper" => &tables.roof_pools.copper_family,
		_ => return None,
	})
}

/// The block of `family` nearest to `rgb` in Oklab with lightness at half weight, and that distance.
fn nearest_roof_shade(family: &[Block], rgb: RGBTuple) -> (Block, f32) {
	let target = oklab_components(&rgb);
	data::tables()
		.palette
		.roof_shades
		.iter()
		.filter(|row| family.contains(&row.block))
		.map(|row| {
			let lab = oklab_components(&row.rgb_tuple());
			let (dl, da, db) = (0.5 * (target.0 - lab.0), target.1 - lab.1, target.2 - lab.2);
			(row.block, (dl * dl + da * da + db * db).sqrt())
		})
		.min_by(|a, b| a.1.total_cmp(&b.1))
		.unwrap_or((family[0], 0.0))
}

/// A pitched roof for a bare `roof:colour`. Arnis `roof_family_for_colour`.
fn roof_family_for_color(rgb: RGBTuple, rng: &mut impl Rng) -> Block {
	let (l, a, b) = oklab_components(&rgb);
	if a.hypot(b) < 0.035 {
		return if l >= 0.55 {
			Block::PolishedAndesite
		} else if l >= 0.38 {
			Block::CobbledDeepslate
		} else if l >= 0.25 {
			Block::DeepslateTiles
		} else {
			Block::PolishedBlackstoneBricks
		};
	}
	let (r, g, bl) = (f32::from(rgb.0), f32::from(rgb.1), f32::from(rgb.2));
	if r > g && r > bl {
		let hue = 60.0 * (g - bl) / (r - g.min(bl));
		if (-20.0..=40.0).contains(&hue) {
			return nearest_roof_shade(&data::tables().roof_pools.tile_families, rgb).0;
		}
	}
	let families: Vec<Block> = data::tables().palette.roof_shades.iter().map(|row| row.block).collect();
	match nearest_roof_shade(&families, rgb) {
		(block, d) if d <= 0.17 => block,
		_ => roof_block_for_color(rgb, rng),
	}
}

/// The block a mapped `roof:material`, else `roof:colour`, asks for on a flat roof.
pub fn mapped_roof_block(tags: &Tags, style_seed: u64) -> Option<Block> {
	let mut roof_rng = element_rng(style_seed ^ 0xF00F_C010_BA5E_F00D);
	tagged_roof_block(tags, false, None, &mut roof_rng)
}

/// The block a mapped `roof:material` or `roof:colour` asks for on a pitched roof of `roof_type`, drawn from
/// the same stream `generate_roof` uses, or `None` to keep the chosen covering.
pub fn mapped_pitched_roof_block(tags: &Tags, chosen: Option<Block>, style_seed: u64) -> Option<Block> {
	let mut roof_rng = element_rng(style_seed ^ 0xF00F_C010_BA5E_F00D);
	tagged_roof_block(tags, true, chosen, &mut roof_rng)
}

/// What a flat roof is covered in: a field block with patches of a second tone and the odd repair.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RoofMembrane {
	pub base: Block,
	pub patch: Block,
	pub repair: Block,
	/// The bare margin along the parapet of a green roof.
	pub margin: Option<Block>,
}

impl RoofMembrane {
	pub fn uniform(block: Block) -> Self {
		Self {
			base: block,
			patch: block,
			repair: block,
			margin: None,
		}
	}

	pub fn is_green(&self) -> bool {
		self.base == Block::MossBlock
	}
}

/// The membrane of a flat roof the tags leave open, by region and building. Arnis `rooftops::pick_membrane`.
pub fn pick_membrane(
	region: BuildingRegion,
	materials: MaterialRegion,
	category: BuildingCategory,
	era: ArchEra,
	building_height: i32,
	style_seed: u64,
) -> RoofMembrane {
	let tables = data::tables();
	let chances = &tables.chances;
	let mut rng = element_rng(style_seed ^ 0x6D65_6D62_7261_6E65);
	let roll = rng.random_range(0u32..100);
	let industrial = matches!(category, BuildingCategory::Industrial | BuildingCategory::Warehouse);
	let regional = tables
		.roof_pools
		.membrane_shares
		.get(&materials)
		.filter(|_| !industrial);
	let family: &str = if let Some(shares) = regional {
		let mut left = roll;
		shares
			.iter()
			.find(|(_, share)| {
				let hit = left < *share;
				left = left.saturating_sub(*share);
				hit
			})
			.map_or("grey", |(family, _)| family.as_str())
	} else if region == BuildingRegion::Europe {
		let green_share = match era {
			_ if building_height > 30
				|| matches!(
					category,
					BuildingCategory::Industrial
						| BuildingCategory::Warehouse
						| BuildingCategory::Garage
						| BuildingCategory::Shed
						| BuildingCategory::Greenhouse
				) =>
			{
				0.0
			}
			ArchEra::Contemporary => chances.membrane_green_share.contemporary,
			ArchEra::Unknown => chances.membrane_green_share.unknown,
			ArchEra::PostWarPanel => chances.membrane_green_share.post_war_panel,
			_ => chances.membrane_green_share.other,
		};
		if rng.random_bool(green_share) {
			return RoofMembrane {
				base: Block::MossBlock,
				patch: Block::GrassBlock,
				repair: Block::CoarseDirt,
				margin: Some(Block::CoarseDirt),
			};
		}
		if roll < chances.membrane_eu_bands.eu_grey_below {
			"eu_grey"
		} else if roll < chances.membrane_eu_bands.ballast_below {
			"ballast"
		} else {
			"grey"
		}
	} else {
		let bands = &chances.membrane_na_bands;
		let [white, light, grey] = if industrial {
			bands.industrial
		} else {
			match era {
				ArchEra::HistoricOrnate | ArchEra::TraditionalPreWar => bands.prewar,
				ArchEra::Contemporary => bands.contemporary,
				_ => bands.other,
			}
		};
		if roll < white {
			"white"
		} else if roll < light {
			"light"
		} else if roll < grey {
			"grey"
		} else {
			"dark"
		}
	};
	let options = tables
		.roof_pools
		.membranes
		.get(family)
		.map(|v| v.as_slice())
		.unwrap_or(&[]);
	let [base, patch, repair] = options[rng.random_range(0..options.len())];
	RoofMembrane {
		base,
		patch,
		repair,
		margin: None,
	}
}

/// Categories whose roof aesthetic does not fit a parapet.
fn flat_parapet_excluded(category: BuildingCategory) -> bool {
	matches!(
		category,
		BuildingCategory::House
			| BuildingCategory::Farm
			| BuildingCategory::Garage
			| BuildingCategory::Shed
			| BuildingCategory::Greenhouse
			| BuildingCategory::Religious
	)
}

/// A parapet on a flat roof the preset leaves open. Arnis `flat_parapet_for`.
pub fn flat_parapet_for(
	group_seed: u64,
	roof_type: RoofType,
	building_height: i32,
	category: BuildingCategory,
	roofless_condition: bool,
	region: BuildingRegion,
) -> bool {
	if roof_type != RoofType::Flat || flat_parapet_excluded(category) || roofless_condition {
		return false;
	}
	let shares = &data::tables().chances.flat_parapet_share;
	let share = match region {
		BuildingRegion::NorthAmerica => shares.north_america,
		BuildingRegion::Europe => shares.europe,
		BuildingRegion::Other => shares.other,
	};
	let share = if building_height <= 5 {
		share * shares.low_factor
	} else {
		share
	};
	element_rng(group_seed ^ 0x534F_F154_4AAE_E0F0).random_bool(share)
}

/// Whether a roof block is glass, which a glass wall's roof continues in the wall's own glass.
pub fn roof_block_is_glass(block: Block) -> bool {
	is_glass_wall(block)
}
