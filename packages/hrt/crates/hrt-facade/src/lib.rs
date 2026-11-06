// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// The decision path is ported from Arnis `src/element_processing/buildings.rs` `generate_buildings` at commit
// d8e8b662 (github.com/louis-e/arnis, Apache-2.0), kept to the decisions a map renderer reads.

//! Building facade styles for Earth's compact building tiles, decided the way Arnis decides them.
//!
//! [`resolve`] takes one building ([`FacadeInput`]) and returns its [`FacadeStyle`]: palette indexes for the wall,
//! trim, accent, glass, spandrel, base course, shop frame and roof, with the category, era, window archetype,
//! ground floor, roof shape, bay rhythm and tower zoning the shader draws from. Every draw is seeded from the
//! building's seed, so the same input always yields the same style, and the parts of one building share one.
//!
//! The seed rules per source are [`seed_for_osm_way`], [`seed_for_relation_ring`], [`seed_for_overture_id`] and
//! [`part_group_seed`]; the district seed is [`district_seed`] of the geographic cell [`district_cell`] gives.

pub mod block;
pub mod category;
pub mod climate;
pub mod color;
pub mod data;
pub mod facade;
pub mod height;
pub mod region;
pub mod rng;
pub mod roof;
pub mod seed;
pub mod style;
pub mod walls;

use rand::Rng;

pub use block::Block;
pub use category::{BuildingCategory, BuildingCondition, DetailTier, Outline, RoofType, WallDepthStyle};
pub use climate::Climate;
pub use facade::{BayLayout, BayRhythm, GroundFloor, TowerZoning, WindowArchetype};
pub use region::{BuildingRegion, MaterialRegion};
pub use roof::RoofMembrane;
pub use seed::{ArchEra, StyleHint, Tags};
pub use style::BuildingStyle;
pub use walls::ShellGlass;

use category::{building_type, BuildingStylePreset};
use facade::{PeriodCues, ZoningInputs};
use height::GROUND_FLOOR_BONUS;
use rng::element_rng;
use style::{ResolveInputs, RoofContext};

/// What the build knows about a building's neighbors. Without it, every decision takes Arnis's answer for a
/// building with no street and no neighbor: `Plain` ground floors, free-standing roofs, no party walls.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NeighborFacts {
	/// Shares a wall with a neighbor: party columns at least 4 and at least 15 percent of the ring.
	pub attached: bool,
	/// Ringed by other buildings on at least 90 percent of its outward cells.
	pub enclosed: bool,
	/// Any wall faces a road within the street setback.
	pub has_any_street: bool,
	/// Two consecutive perpendicular street-facing walls meet at a convex corner.
	pub street_corner: bool,
}

/// One wall segment's neighbor facts, as the neighbor pass classifies it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EdgeFacts {
	/// The segment's length in meters.
	pub length: f64,
	/// Faces a road within the setback.
	pub street: bool,
	/// Faces another building's footprint within two meters.
	pub party: bool,
}

impl NeighborFacts {
	/// The aggregate facts Arnis's `RoofContext` reads, from per-edge facts. `enclosed` and the corner need the
	/// footprint bitmap and are passed through.
	pub fn from_edges(edges: &[EdgeFacts], enclosed: bool, street_corner: bool) -> Self {
		let (mut party, mut total) = (0.0, 0.0);
		for edge in edges {
			total += edge.length;
			if edge.party {
				party += edge.length;
			}
		}
		Self {
			attached: party >= 4.0 && party * 100.0 >= total * 15.0,
			enclosed,
			has_any_street: edges.iter().any(|edge| edge.street),
			street_corner,
		}
	}
}

/// One building as the style resolver reads it.
#[derive(Clone, Debug)]
pub struct FacadeInput<'a> {
	/// The building's seed: its own id, or for a part the group seed with the hint, year and housing bits packed
	/// as [`part_group_seed`] packs them.
	pub seed: u64,
	/// The element's own id, for the few draws Arnis makes per element rather than per group: the window phase,
	/// quoins, the tower crown and wall variety. Equal to `seed` for a building that is not a part.
	pub element_id: u64,
	/// OSM tags, or for an Overture row the tags [`overture_tags`] derives. `building` or `building:part` must be
	/// present for the type to read; absent, the type is `yes`.
	pub tags: &'a Tags,
	/// The footprint in whole meters, with its cell count.
	pub outline: Outline,
	/// The building's centroid, for the region and the climate.
	pub lon: f64,
	pub lat: f64,
	/// The geographic 128 m district cell the building's group center falls in, from [`district_cell`].
	pub district_cell: (i64, i64),
	/// `building:levels` of a building relation the ring came from.
	pub relation_levels: Option<i32>,
	/// Neighbor facts, or `None` for Arnis's defaults.
	pub neighbors: Option<NeighborFacts>,
	/// Whether an `entrance=*` or `door=*` node sits on the outline.
	pub has_mapped_entrance: bool,
}

/// The resolved style of one building: what the record stores and the shader draws.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FacadeStyle {
	/// The wall block.
	pub wall: Block,
	/// The light stone of lintels, sills, string courses and the cornice.
	pub trim: Block,
	/// The accent block of floor bands, the roof line, quoins and corner piers.
	pub accent: Block,
	/// The window glass.
	pub glass: Block,
	/// The panel between the storeys of a shaft whose spandrels recede with the glass.
	pub spandrel: Block,
	/// The darker plinth block of the bottom one or two rows, or `None` for none.
	pub base_course: Option<Block>,
	/// The dark frame of a shopfront or lobby.
	pub shop_frame: Block,
	/// The covering of a pitched roof, or `None` on a flat roof.
	pub roof_block: Option<Block>,
	/// What a flat roof is covered in.
	pub roof_cover: RoofMembrane,
	/// The coping on the parapet.
	pub coping: Block,
	pub category: BuildingCategory,
	pub era: ArchEra,
	pub detail: DetailTier,
	pub condition: BuildingCondition,
	pub region: BuildingRegion,
	pub materials: MaterialRegion,
	pub climate: Climate,
	pub window_archetype: WindowArchetype,
	/// The window, pier and corner widths the wall runs are laid out with.
	pub bays: BayRhythm,
	pub ground: GroundFloor,
	pub zoning: Option<TowerZoning>,
	pub roof_type: RoofType,
	pub generate_roof: bool,
	/// The rows a pitched roof takes off a mapped height.
	pub roof_rise: Option<i32>,
	pub has_parapet: bool,
	pub has_windows: bool,
	pub use_horizontal_windows: bool,
	pub use_accent_lines: bool,
	pub use_accent_roof_line: bool,
	pub use_vertical_accent: bool,
	pub top_treatment: bool,
	pub attic_style: bool,
	pub surrounds: bool,
	pub piano_nobile: bool,
	pub rustication: bool,
	pub shell_glass: ShellGlass,
	pub wall_depth_style: WallDepthStyle,
	pub has_chimney: bool,
	/// Wall rows, after the condition and roof rise took theirs; one row is one meter.
	pub building_height: i32,
	/// Rows per upper storey: 3, 4 or 5.
	pub floor_cycle: i32,
	pub is_tall_building: bool,
	/// The inferred height in rows when the tags give none, else `None`.
	pub inferred_height: Option<i32>,
	/// The lattice phase of walls no run layout covers: 0 for a part.
	pub window_phase: i32,
}

/// The seed of an OSM way: its id.
pub fn seed_for_osm_way(way_id: u64) -> u64 {
	way_id
}

/// The seed of a relation's `ring_idx`-th outer ring: bit 63, the relation id shifted by 16, and the ring index.
pub fn seed_for_relation_ring(relation_id: u64, ring_idx: usize) -> u64 {
	(1u64 << 63) | (relation_id << 16) | (ring_idx as u64 & 0xFFFF)
}

/// The seed of an Overture row: FNV-1a of the GERS id string with bit 63 set, as Arnis hashes it.
pub fn seed_for_overture_id(gers_id: &str) -> u64 {
	const FNV_OFFSET: u64 = 0xcbf29ce484222325;
	const FNV_PRIME: u64 = 0x100000001b3;
	let mut hash = FNV_OFFSET;
	for byte in gers_id.as_bytes() {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(FNV_PRIME);
	}
	hash | (1u64 << 63)
}

/// The shared seed of a part: the outline's seed (a way id, or `RELATION_SEED_BIT | relation id`) with the
/// building's style hint, construction year and housing flag packed in.
pub fn part_group_seed(outline_seed: u64, hint: StyleHint, year: Option<i32>, housing: bool) -> u64 {
	seed::seed_with_residential_mark(
		seed::seed_with_year(seed::seed_with_hint(outline_seed, hint), year),
		housing,
	)
}

/// The side of a district cell in meters.
pub const DISTRICT_CELL_METERS: f64 = 128.0;

/// The geographic 128 m cell holding a point, the cell `hrt-profile`'s `district` hashes.
pub fn district_cell(lon: f64, lat: f64) -> (i64, i64) {
	let cell_x = (lon * 111_320.0 * lat.to_radians().cos() / DISTRICT_CELL_METERS).floor() as i64;
	let cell_y = (lat * 110_540.0 / DISTRICT_CELL_METERS).floor() as i64;
	(cell_x, cell_y)
}

/// The seed of a district cell, as Arnis `district_seed` derives it from a cell index.
pub fn district_seed(cell: (i64, i64)) -> u64 {
	rng::coord_rng(cell.0 as i32, cell.1 as i32, 0xD157_C7A1_5EED_0001).random()
}

/// The sRGB color of every block in palette order, for the client to embed.
pub fn palette() -> Vec<[u8; 3]> {
	data::tables().palette.blocks.iter().map(|row| row.rgb).collect()
}

/// The OSM-style tags Arnis derives from an Overture buildings row, so an Overture-only building reads like a
/// tagged way. `keep_low_heights` keeps a measured height Arnis would drop in favor of its inference (heights under
/// 10 m, or under 28 m beside a floor count), which a map wants.
#[allow(clippy::too_many_arguments)]
pub fn overture_tags(
	subtype: Option<&str>,
	class: Option<&str>,
	height: Option<f64>,
	num_floors: Option<i32>,
	min_height: Option<f64>,
	roof_shape: Option<&str>,
	roof_material: Option<&str>,
	roof_orientation: Option<&str>,
	roof_height: Option<f64>,
	facade_color: Option<&str>,
	roof_color: Option<&str>,
	facade_material: Option<&str>,
	keep_low_heights: bool,
) -> Tags {
	let mut tags = Tags::new();
	tags.insert(
		"building".to_string(),
		category::overture_class_to_osm_building(subtype, class).to_string(),
	);
	let has_useful_floors = num_floors.is_some_and(|f| f >= 2);
	if let Some(h) = height {
		if h > 0.0 && h < 1000.0 {
			let emit = if keep_low_heights {
				true
			} else if has_useful_floors {
				h > 28.0
			} else {
				h >= 10.0
			};
			if emit {
				tags.insert("height".to_string(), format!("{h:.1}"));
			}
		}
	}
	if let Some(h) = min_height {
		if h > 0.0 && h < 1000.0 {
			tags.insert("min_height".to_string(), format!("{h:.1}"));
		}
	}
	if let Some(floors) = num_floors {
		if (2..200).contains(&floors) || (keep_low_heights && floors == 1) {
			tags.insert("building:levels".to_string(), floors.to_string());
		}
	}
	if let Some(roof) = roof_shape {
		tags.insert("roof:shape".to_string(), roof.to_string());
	}
	if let Some(mat) = roof_material {
		tags.insert("roof:material".to_string(), mat.to_string());
	}
	if let Some(orient) = roof_orientation {
		tags.insert("roof:orientation".to_string(), orient.to_string());
	}
	if let Some(color) = facade_color {
		tags.insert("building:colour".to_string(), color.to_string());
	}
	if let Some(color) = roof_color {
		tags.insert("roof:colour".to_string(), color.to_string());
	}
	if let Some(mat) = facade_material {
		tags.insert("building:material".to_string(), mat.to_string());
	}
	if let Some(rh) = roof_height {
		let plausible = (0.5..100.0).contains(&rh) && height.is_none_or(|h| rh < h * 0.75);
		if plausible {
			tags.insert("roof:height".to_string(), format!("{rh:.1}"));
		}
	}
	tags.insert("source".to_string(), "overture_maps".to_string());
	tags
}

/// The style of one building, along `generate_buildings`'s decision order.
pub fn resolve(input: &FacadeInput<'_>) -> FacadeStyle {
	let scale_factor = 1.0;
	let tags = input.tags;
	let chances = &data::tables().chances;

	// A part's shared seed carries the year of the building it belongs to.
	let (outline_year, group_seed) = if input.seed != input.element_id {
		(seed::year_from_seed(input.seed), seed::seed_without_year(input.seed))
	} else {
		(None, input.seed)
	};
	let is_part = tags.contains_key("building:part");
	let min_level = tags
		.get("building:min_level")
		.and_then(|s| s.parse::<i32>().ok())
		.unwrap_or(0);
	let building_type = building_type(tags);
	let housing_group = is_part && seed::residential_group_from_seed(group_seed);
	let group_seed = seed::seed_without_residential_mark(group_seed);
	let floor_cycle = height::floor_cycle_for(building_type, tags, housing_group);

	let start_year = seed::building_start_year(tags).or(outline_year);
	let mut era = seed::building_arch_era_dated(tags, start_year);
	if era == ArchEra::Unknown && is_part {
		era = seed::arch_era_from_hint(seed::style_hint_from_seed(group_seed));
	}

	let min_level_offset = if let Some(mh) = tags.get("min_height") {
		mh.trim_end_matches('m')
			.trim()
			.parse::<f64>()
			.ok()
			.map(|h| (h * scale_factor) as i32)
			.unwrap_or(0)
	} else if min_level > 0 {
		height::multiply_scale(min_level * floor_cycle + GROUND_FLOOR_BONUS, scale_factor)
	} else {
		0
	};

	let footprint_size = input.outline.cells;
	let has_height_source =
		tags.contains_key("height") || tags.contains_key("building:levels") || input.relation_levels.is_some();
	let (building_height, is_tall_building) = height::calculate_building_height(
		tags,
		building_type,
		min_level,
		scale_factor,
		input.relation_levels,
		floor_cycle,
		footprint_size,
		group_seed,
	);
	let (floor_cycle, building_height, is_tall_building) =
		if height::takes_commercial_rhythm(is_tall_building, building_type, floor_cycle, tags) {
			let (h, tall) = height::calculate_building_height(
				tags,
				building_type,
				min_level,
				scale_factor,
				input.relation_levels,
				4,
				footprint_size,
				group_seed,
			);
			(4, h, tall)
		} else {
			(floor_cycle, building_height, is_tall_building)
		};
	let inferred_height = (!has_height_source).then_some(building_height);

	let materials = MaterialRegion::at(input.lat, input.lon);
	let region = materials.building_region();
	let category = BuildingCategory::from_element(
		tags,
		&input.outline,
		is_tall_building,
		building_height,
		group_seed,
		scale_factor,
		region,
	);
	let preset = BuildingStylePreset::for_category(category);

	let neighbors = input.neighbors.unwrap_or_default();
	let detail = category::compute_detail_tier(
		tags,
		category,
		footprint_size,
		building_height,
		neighbors.has_any_street,
	);

	let mut rng = element_rng(group_seed);
	let has_multiple_floors = building_height > floor_cycle + 2;
	let climate = Climate::at(input.lat, input.lon);
	let roof_ctx = RoofContext {
		enclosed: neighbors.enclosed,
		region,
		attached: neighbors.attached,
		scale: scale_factor,
		materials,
		district: district_seed(input.district_cell),
	};
	let style = BuildingStyle::resolve(
		&ResolveInputs {
			preset: &preset,
			tags,
			outline: &input.outline,
			building_type,
			category,
			era,
			climate,
			detail,
			building_height,
			has_multiple_floors,
			footprint_size,
			style_seed: group_seed,
			roof_ctx,
			has_mapped_entrance: input.has_mapped_entrance,
		},
		&mut rng,
	);
	let roof_cover = roof::mapped_roof_block(tags, group_seed)
		.or(style.roof_block)
		.map(RoofMembrane::uniform)
		.unwrap_or_else(|| {
			roof::pick_membrane(
				roof_ctx.region,
				roof_ctx.materials,
				category,
				era,
				building_height,
				group_seed,
			)
		});

	let condition = BuildingCondition::from_tags(tags);
	let mut wall_block = style.wall_block;
	const THIN_RING_MAX_CELLS: usize = 4;
	let is_thin_ring = footprint_size <= THIN_RING_MAX_CELLS;
	let curtain_glass = block::is_glass_wall(wall_block)
		&& !matches!(
			category,
			BuildingCategory::GridSkyscraper | BuildingCategory::Greenhouse
		);
	let mut has_windows = style.has_windows && !is_thin_ring && !curtain_glass;
	let mut effective_building_height = building_height;
	match condition {
		BuildingCondition::Construction => {
			effective_building_height = (building_height / 2).max(3);
			wall_block = Block::Scaffolding;
			has_windows = false;
		}
		BuildingCondition::Ruined => {
			effective_building_height = ((building_height as f64 * 0.6) as i32).max(3);
			has_windows = false;
		}
		BuildingCondition::Abandoned | BuildingCondition::Disused | BuildingCondition::Normal => {}
	}

	let condition_keeps_roof = matches!(
		condition,
		BuildingCondition::Normal | BuildingCondition::Disused | BuildingCondition::Abandoned
	);
	let roof_rise = height::mapped_height_roof_rise(
		tags,
		&input.outline,
		style.roof_type,
		style.generate_roof,
		condition_keeps_roof,
		effective_building_height,
		category == BuildingCategory::Religious,
		scale_factor,
	);
	if let Some(rise) = roof_rise {
		effective_building_height = (effective_building_height - rise).max(3);
	}
	let roofless = matches!(condition, BuildingCondition::Construction | BuildingCondition::Ruined);
	let has_sloped_roof = style.generate_roof && style.roof_type != RoofType::Flat && !roofless;

	let old_row_fabric = !is_tall_building
		&& roof_ctx.attached
		&& footprint_size as f64 <= 800.0 * scale_factor * scale_factor
		&& effective_building_height <= 8 * floor_cycle + GROUND_FLOOR_BONUS;
	let window_archetype = facade::pick_window_archetype(
		category,
		era,
		roof_ctx.region,
		wall_block,
		PeriodCues::of(tags, start_year, old_row_fabric),
		group_seed,
	);
	let masonry_tower = matches!(
		window_archetype,
		WindowArchetype::PairedPunched | WindowArchetype::DecoPiers
	);
	let window_block = if masonry_tower {
		walls::masonry_window_glass(wall_block, group_seed)
	} else {
		style.window_block
	};

	let top_treatment = has_windows
		&& effective_building_height >= 4 * floor_cycle
		&& !style.use_horizontal_windows
		&& !matches!(
			category,
			BuildingCategory::GlassySkyscraper
				| BuildingCategory::GlassCornerSkyscraper
				| BuildingCategory::GridSkyscraper
				| BuildingCategory::Tower
		) && element_rng(group_seed ^ 0xF10A_401E_0000_0001).random_bool(chances.top_treatment_chance);
	let attic_style = has_windows
		&& has_sloped_roof
		&& effective_building_height >= 3 * floor_cycle
		&& matches!(
			category,
			BuildingCategory::House | BuildingCategory::Residential | BuildingCategory::Historic
		) && element_rng(group_seed ^ 0xF10A_401E_0000_0002).random_bool(chances.attic_chance);
	let surrounds = roof_ctx.region == BuildingRegion::Europe
		&& has_windows
		&& !matches!(
			wall_block,
			Block::Brick
				| Block::Terracotta
				| Block::RedTerracotta
				| Block::OrangeTerracotta
				| Block::BrownTerracotta
				| Block::NetherBrick
				| Block::RedNetherBricks
				| Block::MudBricks
				| Block::Granite
				| Block::PolishedGranite
				| Block::BrownConcrete
		) && condition == BuildingCondition::Normal
		&& detail >= DetailTier::Standard
		&& !is_tall_building
		&& matches!(
			window_archetype,
			WindowArchetype::Spaced | WindowArchetype::Portrait | WindowArchetype::Hooded
		) && {
		let chance = match (era, category) {
			(ArchEra::HistoricOrnate, _) | (_, BuildingCategory::Historic) => chances.surrounds_chance.historic,
			(ArchEra::TraditionalPreWar, _) => chances.surrounds_chance.traditional_pre_war,
			(
				ArchEra::Unknown,
				BuildingCategory::Residential
				| BuildingCategory::Default
				| BuildingCategory::Commercial
				| BuildingCategory::Hotel
				| BuildingCategory::Office,
			) => chances.surrounds_chance.unknown,
			_ => 0.0,
		};
		chance > 0.0 && element_rng(group_seed ^ 0xFA5C_4E40_0000_0001).random_bool(chance)
	};
	let piano_nobile = has_windows
		&& effective_building_height >= 3 * floor_cycle
		&& match category {
			BuildingCategory::Historic => {
				element_rng(group_seed ^ 0xF10A_401E_0000_0003).random_bool(chances.piano_nobile_chance.historic)
			}
			BuildingCategory::Hotel => {
				element_rng(group_seed ^ 0xF10A_401E_0000_0003).random_bool(chances.piano_nobile_chance.hotel)
			}
			BuildingCategory::Residential | BuildingCategory::Default | BuildingCategory::Commercial
				if roof_ctx.region == BuildingRegion::Europe && era == ArchEra::HistoricOrnate =>
			{
				element_rng(group_seed ^ 0xF10A_401E_0000_0003).random_bool(chances.piano_nobile_chance.european_ornate)
			}
			_ => false,
		};

	let is_ground_level = min_level_offset == 0;
	let has_parapet = style.has_parapet
		|| roof::flat_parapet_for(
			group_seed,
			style.roof_type,
			effective_building_height,
			category,
			roofless,
			roof_ctx.region,
		);
	let window_phase = if is_part {
		0
	} else {
		element_rng(input.element_id ^ 0x77D0_A3E1_9B1C_5544).random_range(0..6)
	};
	let curtain_wall = walls::is_curtain_wall(category, has_windows, wall_block);
	let mut bays = if curtain_wall {
		facade::curtain_rhythm(group_seed, era)
	} else {
		let mut bays = window_archetype.rhythm();
		bays.pier += i32::from(surrounds);
		bays
	};
	let spandrel = if window_archetype == WindowArchetype::DecoPiers {
		walls::deco_spandrel_for_wall(wall_block, group_seed)
	} else {
		style.accent_block
	};
	let rustication = matches!(
		category,
		BuildingCategory::House
			| BuildingCategory::Residential
			| BuildingCategory::Commercial
			| BuildingCategory::Hotel
			| BuildingCategory::Historic
	) && is_ground_level
		&& condition == BuildingCondition::Normal
		&& detail >= DetailTier::Standard
		&& match era {
			ArchEra::HistoricOrnate => true,
			ArchEra::TraditionalPreWar => {
				element_rng(group_seed ^ 0x0BA5_E5A0_0000_000A).random_bool(chances.rustication_prewar_chance)
			}
			_ => false,
		};
	let base_course = {
		let eligible = is_ground_level
			&& has_windows
			&& condition == BuildingCondition::Normal
			&& !matches!(
				category,
				BuildingCategory::Greenhouse
					| BuildingCategory::Shed
					| BuildingCategory::Garage
					| BuildingCategory::GlassySkyscraper
			);
		let base = walls::base_course_for_wall(wall_block);
		let old_europe =
			roof_ctx.region == BuildingRegion::Europe && !matches!(era, ArchEra::PostWarPanel | ArchEra::Contemporary);
		(eligible
			&& base != wall_block
			&& (old_europe || element_rng(group_seed ^ 0xBA5E_C0A2_5E11_0001).random_bool(chances.base_course_chance)))
		.then_some(base)
	};
	let ground = if (has_windows || curtain_wall) && condition == BuildingCondition::Normal && is_ground_level {
		facade::pick_ground_floor(
			tags,
			category,
			effective_building_height / floor_cycle,
			roof_ctx.region,
			roof_ctx.attached,
			neighbors.has_any_street,
			neighbors.street_corner,
			group_seed,
		)
	} else {
		GroundFloor::Plain
	};
	let trim = walls::trim_block_for_wall(wall_block, group_seed);
	let shop_frame = {
		let options = facade::shop_frame_options(roof_ctx.region);
		options[element_rng(group_seed ^ 0x5409_F2A3_0000_0003).random_range(0..options.len())]
	};
	let shell_glass = walls::shell_glass_for(tags, category, building_type, wall_block, false);
	if let Some(closed) = facade::closed_retail_bays(
		tags,
		has_windows,
		wall_block,
		effective_building_height,
		floor_cycle,
		footprint_size,
		scale_factor,
	) {
		bays = closed;
	}
	let punched_windows = has_windows
		&& !style.use_horizontal_windows
		&& !matches!(category, BuildingCategory::Tower | BuildingCategory::GridSkyscraper);
	let zoning = TowerZoning::plan(&ZoningInputs {
		is_ground_level,
		condition,
		punched_windows,
		window_archetype,
		floor_cycle,
		building_height: effective_building_height,
		wall_block,
		trim_block: trim,
	})
	.map(|z| z.keeping_mapped_wall(wall_block, tags));
	let coping = walls::coping_for(wall_block, style.accent_block, group_seed);

	FacadeStyle {
		wall: wall_block,
		trim,
		accent: style.accent_block,
		glass: window_block,
		spandrel,
		base_course,
		shop_frame,
		roof_block: style.roof_block,
		roof_cover,
		coping,
		category,
		era,
		detail,
		condition,
		region,
		materials,
		climate,
		window_archetype,
		bays,
		ground,
		zoning,
		roof_type: style.roof_type,
		generate_roof: style.generate_roof,
		roof_rise,
		has_parapet,
		has_windows,
		use_horizontal_windows: style.use_horizontal_windows,
		use_accent_lines: style.use_accent_lines && !masonry_tower,
		use_accent_roof_line: style.use_accent_roof_line,
		use_vertical_accent: style.use_vertical_accent,
		top_treatment,
		attic_style,
		surrounds,
		piano_nobile,
		rustication,
		shell_glass,
		wall_depth_style: style.wall_depth_style,
		has_chimney: style.has_chimney,
		building_height: effective_building_height,
		floor_cycle,
		is_tall_building,
		inferred_height,
		window_phase,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tags(pairs: &[(&str, &str)]) -> Tags {
		pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
	}

	fn rectangle(w: i32, l: i32) -> Outline {
		Outline {
			nodes: vec![(0, 0), (w, 0), (w, l), (0, l), (0, 0)],
			cells: ((w - 1) * (l - 1)).max(1) as usize,
		}
	}

	#[test]
	fn a_detroit_house_resolves_deterministically() {
		let tags = tags(&[("building", "house"), ("building:levels", "2")]);
		let input = FacadeInput {
			seed: 1234,
			element_id: 1234,
			tags: &tags,
			outline: rectangle(12, 9),
			lon: -83.05,
			lat: 42.33,
			district_cell: district_cell(-83.05, 42.33),
			relation_levels: None,
			neighbors: None,
			has_mapped_entrance: false,
		};
		let a = resolve(&input);
		let b = resolve(&input);
		assert_eq!(a, b);
		assert_eq!(a.category, BuildingCategory::House);
		assert_eq!(a.materials, MaterialRegion::NorthAmerica);
		assert_eq!(a.building_height, 8 - a.roof_rise.unwrap_or(0));
		assert_eq!(a.floor_cycle, 3);
		assert!(a.inferred_height.is_none());
	}

	#[test]
	fn seeds_follow_their_sources() {
		assert_eq!(seed_for_relation_ring(1, 2) >> 63, 1);
		assert_eq!(seed_for_overture_id("08b2f5a3-7c1e-4fff-0200-0a1b2c3d4e5f") >> 63, 1);
		let seed = part_group_seed(99, StyleHint::Masonry, Some(1914), true);
		assert_eq!(seed::group_key(seed), 99);
		assert_eq!(seed::year_from_seed(seed), Some(1914));
		assert_eq!(palette().len(), block::BLOCK_COUNT);
	}
}
