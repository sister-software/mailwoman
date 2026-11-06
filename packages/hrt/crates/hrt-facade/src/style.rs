// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Arnis `src/element_processing/buildings.rs` at commit d8e8b662 (github.com/louis-e/arnis,
// Apache-2.0): `RoofContext`, `BuildingStyle` and `BuildingStyle::resolve`. The draw order on the shared RNG is
// unchanged, including the floor block and chimney draws a map never reads. Modified: the Mapillary tail, which
// swaps the wall for a photographed color, is left out.

//! The resolved style of one building: its blocks, window style, accent features, roof and relief family.

use rand::Rng;

use crate::block::Block;
use crate::category::{BuildingCategory, BuildingStylePreset, DetailTier, Outline, RoofType, WallDepthStyle};
use crate::climate::Climate;
use crate::data;
use crate::region::{BuildingRegion, MaterialRegion};
use crate::rng::element_rng;
use crate::roof;
use crate::seed::{ArchEra, Tags};
use crate::walls;

/// What the style choice needs to know about the building's surroundings.
#[derive(Clone, Copy, Debug)]
pub struct RoofContext {
	pub region: BuildingRegion,
	/// Shares a wall with a neighbor: a terraced row or a perimeter block.
	pub attached: bool,
	pub scale: f64,
	/// Regional wall and roof materials.
	pub materials: MaterialRegion,
	/// The district seed of the building, of its whole group for parts.
	pub district: u64,
	/// Ringed by other buildings on all sides.
	pub enclosed: bool,
}

/// A fully resolved building style.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BuildingStyle {
	pub wall_block: Block,
	pub floor_block: Block,
	pub window_block: Block,
	pub accent_block: Block,
	pub roof_block: Option<Block>,
	pub use_horizontal_windows: bool,
	pub has_windows: bool,
	pub use_accent_roof_line: bool,
	pub use_accent_lines: bool,
	pub use_vertical_accent: bool,
	pub roof_type: RoofType,
	pub has_chimney: bool,
	pub generate_roof: bool,
	pub has_garage_door: bool,
	pub has_single_door: bool,
	pub wall_depth_style: WallDepthStyle,
	pub has_parapet: bool,
}

/// The inputs `resolve` reads, which Arnis passes as separate arguments.
pub struct ResolveInputs<'a> {
	pub preset: &'a BuildingStylePreset,
	pub tags: &'a Tags,
	pub outline: &'a Outline,
	pub building_type: &'a str,
	pub category: BuildingCategory,
	pub era: ArchEra,
	pub climate: Climate,
	pub detail: DetailTier,
	pub building_height: i32,
	pub has_multiple_floors: bool,
	pub footprint_size: usize,
	pub style_seed: u64,
	pub roof_ctx: RoofContext,
	/// Whether an `entrance=*` or `door=*` node sits on the outline, which suppresses preset doors.
	pub has_mapped_entrance: bool,
}

impl BuildingStyle {
	/// Resolves a preset into a style with the shared RNG, in Arnis's draw order.
	pub fn resolve(input: &ResolveInputs<'_>, rng: &mut impl Rng) -> Self {
		let ResolveInputs {
			preset,
			tags,
			outline,
			building_type,
			category,
			era,
			climate,
			detail,
			building_height,
			has_multiple_floors,
			footprint_size,
			style_seed,
			roof_ctx,
			has_mapped_entrance,
		} = *input;
		let chances = &data::tables().chances;
		let palettes = &data::tables().wall_pools.category_palettes;

		let wall_block = walls::determine_wall_block_from_tags(tags, category, rng)
			.or(preset.wall_block)
			.unwrap_or_else(|| {
				walls::determine_wall_block(tags, category, era, climate, building_height, &roof_ctx, rng)
			});

		let floor_block = preset.floor_block.unwrap_or_else(|| {
			if matches!(
				category,
				BuildingCategory::GlassySkyscraper | BuildingCategory::ModernSkyscraper
			) {
				palettes.skyscraper_floor[rng.random_range(0..palettes.skyscraper_floor.len())]
			} else {
				walls::concrete_floor_for(category, walls::get_floor_block_with_rng(rng))
			}
		});

		let window_block = preset.window_block.unwrap_or_else(|| {
			let pool = walls::window_pool_for_category(category);
			pool[rng.random_range(0..pool.len())]
		});

		let accent_block = preset.accent_block.unwrap_or_else(|| {
			if category == BuildingCategory::GlassySkyscraper {
				palettes.glassy_accent[rng.random_range(0..palettes.glassy_accent.len())]
			} else if category == BuildingCategory::ModernSkyscraper {
				palettes.modern_accent[rng.random_range(0..palettes.modern_accent.len())]
			} else {
				walls::accent_for_wall(wall_block, rng)
			}
		});

		let window_block = if preset.window_block.is_none() && category != BuildingCategory::Religious {
			walls::coordinated_window_block(wall_block, accent_block, window_block)
		} else {
			window_block
		};
		let (wall_block, window_block) = walls::glass_palette(tags, category, wall_block, window_block);

		let use_horizontal_windows = preset
			.use_horizontal_windows
			.unwrap_or_else(|| category == BuildingCategory::ModernSkyscraper);

		let use_accent_roof_line = preset
			.use_accent_roof_line
			.unwrap_or_else(|| rng.random_bool(chances.accent_roof_line_chance));

		let use_accent_lines = preset.use_accent_lines.unwrap_or_else(|| {
			if category == BuildingCategory::ModernSkyscraper {
				true
			} else if category == BuildingCategory::GlassySkyscraper {
				rng.random_bool(chances.accent_lines_glassy_chance)
			} else {
				has_multiple_floors && rng.random_bool(chances.accent_lines_chance)
			}
		});

		let use_vertical_accent = preset.use_vertical_accent.unwrap_or_else(|| {
			has_multiple_floors && !use_accent_lines && rng.random_bool(chances.vertical_accent_chance)
		});

		let (roof_type, generate_roof) = if let Some(roof_shape) = tags.get("roof:shape") {
			(roof::parse_roof_type(roof_shape), true)
		} else if let Some(rt) = preset.roof_type {
			let should_generate = preset.generate_roof.unwrap_or(rt != RoofType::Flat);
			(rt, should_generate)
		} else if (tags.contains_key("building:part")
			&& (tags.contains_key("height") || tags.contains_key("building:levels")))
			|| roof_ctx.enclosed
		{
			// A part with a mapped top is a modeled volume, and an enclosed building's roof is under its neighbors.
			(RoofType::Flat, false)
		} else if let Some(choice) = roof::european_default_roof(
			tags,
			outline,
			building_type,
			era,
			building_height,
			footprint_size,
			style_seed,
			&roof_ctx,
		) {
			choice
		} else if let Some(choice) = roof::regional_default_roof(
			tags,
			building_type,
			era,
			climate,
			building_height,
			footprint_size,
			style_seed,
			&roof_ctx,
		) {
			choice
		} else if roof::qualifies_for_auto_gabled_roof(building_type) {
			const MAX_FOOTPRINT_FOR_GABLED: usize = 800;
			let mut roof_rng = element_rng(style_seed ^ 0x0F1E_2D3C_4B5A_6907);
			let big_block = footprint_size > MAX_FOOTPRINT_FOR_GABLED || building_height >= 15;
			let scale_sq = roof_ctx.scale * roof_ctx.scale;
			let american_flat = roof_ctx.region == BuildingRegion::NorthAmerica
				&& (roof_ctx.attached
					|| f64::from(building_height) >= 13.0 * roof_ctx.scale
					|| (!roof::is_house_type(building_type) && footprint_size as f64 > 300.0 * scale_sq));
			if american_flat {
				(RoofType::Flat, false)
			} else if building_type == "apartments" && big_block {
				let [flat_w, hip_w] = if matches!(era, ArchEra::HistoricOrnate | ArchEra::TraditionalPreWar) {
					chances.apartment_block_weights.old
				} else {
					chances.apartment_block_weights.other
				};
				let roll = roof_rng.random_range(0u32..100);
				if roll < flat_w {
					(RoofType::Flat, false)
				} else if roll < flat_w + hip_w {
					if roof_ctx.attached {
						(RoofType::Gabled, true)
					} else {
						(RoofType::Hipped, true)
					}
				} else {
					(RoofType::Mansard, true)
				}
			} else if matches!(era, ArchEra::HistoricOrnate | ArchEra::TraditionalPreWar)
				&& (100..=MAX_FOOTPRINT_FOR_GABLED).contains(&footprint_size)
				&& roof_rng.random_bool(chances.prewar_mansard_chance)
			{
				(RoofType::Mansard, true)
			} else if footprint_size <= MAX_FOOTPRINT_FOR_GABLED
				&& roof_rng.random_bool(roof::climate_gable_probability(climate))
			{
				(RoofType::Gabled, true)
			} else {
				(RoofType::Flat, false)
			}
		} else if matches!(building_type, "church" | "cathedral" | "chapel")
			&& (footprint_size as f64) <= 6000.0 * roof_ctx.scale * roof_ctx.scale
		{
			(RoofType::Gabled, true)
		} else if matches!(building_type, "industrial" | "warehouse" | "hangar") && footprint_size > 800 {
			let mut roof_rng = element_rng(style_seed ^ 0x0F1E_2D3C_4B5A_6907);
			if roof_rng.random_bool(chances.industrial_skillion_chance) {
				(RoofType::Skillion, true)
			} else {
				(RoofType::Flat, false)
			}
		} else {
			(RoofType::Flat, false)
		};
		let defaulted = !tags.contains_key("roof:shape") && preset.roof_type.is_none() && !roof_ctx.enclosed;
		let (roof_type, generate_roof) = match roof::roof_levels_roof(tags, era, &roof_ctx) {
			Some(choice) if defaulted && roof_type == RoofType::Flat => choice,
			_ => (roof_type, generate_roof),
		};

		let has_explicit_roof_shape = tags.contains_key("roof:shape");
		const DIAGONAL_THRESHOLD: f64 = 0.35;
		let diagonality = roof::compute_building_diagonality(&outline.nodes);
		let roof_type = if !has_explicit_roof_shape
			&& matches!(
				roof_type,
				RoofType::Gabled | RoofType::Hipped | RoofType::Mansard | RoofType::Gambrel
			) && diagonality < DIAGONAL_THRESHOLD
			&& roof::dominant_axis_angle(&outline.nodes).to_degrees().abs() > 10.0
		{
			RoofType::Pyramidal
		} else {
			roof_type
		};

		let generate_roof =
			generate_roof || (roof_type == RoofType::Flat && !tags.contains_key("building:part") && !roof_ctx.enclosed);

		let heated = !matches!(
			roof_ctx.materials,
			MaterialRegion::Japan
				| MaterialRegion::Korea
				| MaterialRegion::EastAsia
				| MaterialRegion::SoutheastAsia
				| MaterialRegion::SouthAsia
				| MaterialRegion::MiddleEast
				| MaterialRegion::SubSaharanAfrica
				| MaterialRegion::LatinAmerica
		);
		let has_chimney = heated
			&& preset.has_chimney.unwrap_or_else(|| {
				let is_residential = matches!(
					building_type,
					"house"
						| "residential" | "detached"
						| "semidetached_house"
						| "terrace" | "farm"
						| "cabin" | "bungalow"
						| "villa" | "yes"
				);
				let suitable_roof = matches!(
					roof_type,
					RoofType::Gabled | RoofType::Hipped | RoofType::Mansard | RoofType::Gambrel | RoofType::HalfHipped
				);
				let suitable_size = (30..=400).contains(&footprint_size);
				is_residential && suitable_roof && suitable_size && rng.random_bool(chances.chimney_chance)
			});

		let roof_block = preset.roof_block.or_else(|| {
			(generate_roof && roof_type != RoofType::Flat)
				.then(|| roof::pitched_roof_block(category, era, roof_type, wall_block, &roof_ctx, style_seed))
		});

		let has_windows = preset.has_windows.unwrap_or(true);

		let has_garage_door = if has_mapped_entrance {
			false
		} else {
			preset.has_garage_door.unwrap_or(false)
		};
		let has_single_door = if has_mapped_entrance {
			false
		} else {
			preset.has_single_door.unwrap_or(false)
		};

		let wall_depth_style = preset.wall_depth_style.unwrap_or_else(|| {
			if footprint_size < 20 || detail == DetailTier::Minimal {
				WallDepthStyle::None
			} else {
				match (era, category) {
					(
						ArchEra::HistoricOrnate,
						BuildingCategory::House | BuildingCategory::Residential | BuildingCategory::Commercial,
					) => return WallDepthStyle::HistoricOrnate,
					(ArchEra::PostWarPanel, BuildingCategory::House | BuildingCategory::Residential) => {
						return WallDepthStyle::None
					}
					(ArchEra::Contemporary, BuildingCategory::Residential)
						if element_rng(style_seed ^ 0xE5A0_11DE_57A1_0003)
							.random_bool(chances.contemporary_residential_pillars_chance) =>
					{
						return WallDepthStyle::ModernPillars;
					}
					_ => {}
				}
				match category {
					BuildingCategory::House | BuildingCategory::Residential => WallDepthStyle::SubtlePilasters,
					BuildingCategory::Commercial | BuildingCategory::Office | BuildingCategory::Hotel => {
						WallDepthStyle::ModernPillars
					}
					BuildingCategory::School | BuildingCategory::Hospital => WallDepthStyle::InstitutionalBands,
					BuildingCategory::Industrial | BuildingCategory::Warehouse => WallDepthStyle::IndustrialBeams,
					BuildingCategory::Historic => WallDepthStyle::HistoricOrnate,
					BuildingCategory::Religious => WallDepthStyle::ReligiousButtress,
					BuildingCategory::TallBuilding | BuildingCategory::ModernSkyscraper => {
						WallDepthStyle::SkyscraperFins
					}
					BuildingCategory::GlassySkyscraper => WallDepthStyle::GlassCurtain,
					_ => WallDepthStyle::None,
				}
			}
		});

		let has_parapet = preset.has_parapet.unwrap_or_else(|| {
			let is_flat = roof_type == RoofType::Flat;
			let suitable = matches!(
				category,
				BuildingCategory::Commercial
					| BuildingCategory::Office
					| BuildingCategory::Hotel
					| BuildingCategory::School
					| BuildingCategory::Hospital
					| BuildingCategory::TallBuilding
					| BuildingCategory::GlassySkyscraper
					| BuildingCategory::ModernSkyscraper
			);
			is_flat && has_multiple_floors && suitable
		});

		Self {
			wall_block,
			floor_block,
			window_block,
			accent_block,
			roof_block,
			use_horizontal_windows,
			has_windows,
			use_accent_roof_line,
			use_accent_lines,
			use_vertical_accent,
			roof_type,
			has_chimney,
			generate_roof,
			has_garage_door,
			has_single_door,
			wall_depth_style,
			has_parapet,
		}
	}
}
