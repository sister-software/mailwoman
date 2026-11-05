// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Arnis `src/element_processing/buildings.rs` at commit d8e8b662 (github.com/louis-e/arnis,
// Apache-2.0): `WindowArchetype`, `BayRhythm`, `BayLayout`, `curtain_rhythm`, `closed_retail_bays`, `PeriodCues`,
// `is_prewar_masonry_tower`, `pick_window_archetype`, `archetype_allows_window`, `GroundFloor`, `pick_ground_floor`,
// `shop_frame_options` and `TowerZoning`. Modified: the rhythms, weights and chances read the data files; the
// zoning takes its inputs as values rather than a `BuildingConfig`.

//! The window grammar: which archetype a facade takes, how its bays fit a wall run, what its ground floor is, and
//! where a masonry tower's base and capital fall.

use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::block::{is_glass_wall, is_light_stone, is_masonry_wall, Block};
use crate::category::{BuildingCategory, BuildingCondition};
use crate::data;
use crate::region::BuildingRegion;
use crate::rng::element_rng;
use crate::seed::{self, ArchEra, Tags};

/// A per-building window type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowArchetype {
	Sash,
	Portrait,
	Spaced,
	Wide,
	Ribbon,
	Hooded,
	Piers,
	Strips,
	PairedPunched,
	DecoPiers,
}

/// Window, pier and corner pier widths of a facade, in wall columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BayRhythm {
	pub window: i32,
	pub pier: i32,
	/// The narrowest pier a wall run may end on, so no glass reaches a corner.
	pub corner: i32,
}

impl BayRhythm {
	fn from_triple([window, pier, corner]: [i32; 3]) -> Self {
		Self { window, pier, corner }
	}
}

impl WindowArchetype {
	/// Window and pier widths in columns.
	pub fn rhythm(self) -> BayRhythm {
		BayRhythm::from_triple(
			data::tables()
				.archetypes
				.rhythms
				.get(&self)
				.copied()
				.unwrap_or([2, 2, 2]),
		)
	}

	/// Whether the rows between storeys are set back with the glass, so the piers run unbroken up the shaft.
	pub fn recessed_spandrels(self) -> bool {
		matches!(self, Self::Piers | Self::Strips | Self::DecoPiers)
	}
}

/// The bays of a shopfront or tower lobby.
pub fn shop_rhythm() -> BayRhythm {
	BayRhythm::from_triple(data::tables().archetypes.shop)
}

/// The mullion spacing of a glass curtain wall. Arnis `curtain_rhythm`.
pub fn curtain_rhythm(style_seed: u64, era: ArchEra) -> BayRhythm {
	let wide = era == ArchEra::PostWarPanel
		|| element_rng(style_seed ^ 0xC0A7_F125_0000_0001).random_bool(data::tables().chances.curtain_wide_chance);
	BayRhythm {
		window: if wide { 2 } else { 1 },
		pier: 1,
		corner: 1,
	}
}

/// The upper-floor bays of a department store: narrow slits in a mostly closed wall. Arnis `closed_retail_bays`.
pub fn closed_retail_bays(
	tags: &Tags,
	has_windows: bool,
	wall_block: Block,
	building_height: i32,
	floor_cycle: i32,
	footprint_cells: usize,
	scale: f64,
) -> Option<BayRhythm> {
	let store = matches!(tags.get("shop").map(String::as_str), Some("department_store" | "mall"))
		|| matches!(
			tags.get("building").map(String::as_str),
			Some("retail" | "department_store" | "mall")
		);
	let footprint_m2 = footprint_cells as f64 / (scale * scale);
	let storeys = (building_height - crate::height::GROUND_FLOOR_BONUS) / floor_cycle.max(1);
	(store && footprint_m2 >= 1500.0 && storeys >= 3 && has_windows && !is_glass_wall(wall_block))
		.then(|| BayRhythm::from_triple(data::tables().archetypes.closed_retail))
}

/// Windows laid out symmetrically along one straight wall run: as many as fit the rhythm, centered between corner
/// piers. Arnis `BayLayout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BayLayout {
	pub len: i32,
	/// The width of the pier at either end.
	pub lead: i32,
	pub window: i32,
	pub pier: i32,
	pub count: i32,
	/// The middle window is a column wider: an odd count over an odd remainder.
	pub wide_window: bool,
	/// The middle pier is a column wider: an even count over an odd remainder.
	pub wide_pier: bool,
}

/// Where a wall column falls in the window layout of its run.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BaySlot {
	End,
	Pier,
	Window { k: i32, width: i32, bay: i32 },
}

impl BayLayout {
	pub fn plan(len: i32, rhythm: BayRhythm) -> Self {
		let (window, pier) = (rhythm.window.max(1), rhythm.pier.max(1));
		let corner = if len < 3 * (window + pier) {
			1
		} else {
			rhythm.corner.max(1)
		};
		let mut count = if len - 2 * corner >= window {
			(len - 2 * corner + pier) / (window + pier)
		} else {
			0
		};
		loop {
			let mut layout = Self {
				len,
				lead: len,
				window,
				pier,
				count,
				wide_window: false,
				wide_pier: false,
			};
			if count == 0 {
				return layout;
			}
			let spare = len - count * window - (count - 1) * pier;
			if spare % 2 == 1 {
				if count % 2 == 0 {
					layout.wide_pier = true;
				} else if window == 1 && count >= 5 {
					count -= 1;
					continue;
				} else {
					layout.wide_window = true;
				}
			}
			layout.lead = spare / 2;
			return layout;
		}
	}

	/// The slot of column `i` along the run.
	pub fn slot(&self, i: i32) -> BaySlot {
		if self.count == 0 || i < self.lead || i >= self.len - self.lead {
			return BaySlot::End;
		}
		let mid = self.count / 2;
		let mut x = i - self.lead;
		for bay in 0..self.count {
			let width = self.window + i32::from(self.wide_window && bay == mid);
			if x < width {
				return BaySlot::Window { k: x, width, bay };
			}
			x -= width;
			let pier = self.pier + i32::from(self.wide_pier && bay + 1 == mid);
			if x < pier {
				return BaySlot::Pier;
			}
			x -= pier;
		}
		BaySlot::End
	}
}

/// Whether `floor_row` of an upper storey is glass under the archetype. Row 0 is the band between storeys.
pub fn archetype_allows_window(archetype: WindowArchetype, floor_row: i32, floor_cycle: i32) -> bool {
	match archetype {
		WindowArchetype::Ribbon if floor_cycle >= 4 => floor_row >= 2,
		WindowArchetype::DecoPiers if floor_cycle >= 4 => (1..floor_cycle - 1).contains(&floor_row),
		WindowArchetype::Spaced | WindowArchetype::Sash => (1..=2).contains(&floor_row),
		_ => floor_row >= 1,
	}
}

/// What the tags and setting of a building say about when it went up, beyond its era.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PeriodCues {
	pub start_year: Option<i32>,
	pub art_deco: bool,
	pub dwelling: bool,
	/// Attached, low and on a small lot: the undated row fabric of an old city center.
	pub old_row_fabric: bool,
}

impl PeriodCues {
	pub fn of(tags: &Tags, start_year: Option<i32>, old_row_fabric: bool) -> Self {
		Self {
			start_year,
			art_deco: seed::is_art_deco(tags),
			dwelling: matches!(
				crate::category::building_type(tags),
				"apartments" | "residential" | "dormitory" | "hotel" | "house"
			),
			old_row_fabric,
		}
	}
}

/// Whether a tall building is a masonry tower of the pre-war kind.
fn is_prewar_masonry_tower(
	category: BuildingCategory,
	era: ArchEra,
	region: BuildingRegion,
	wall_block: Block,
) -> bool {
	match era {
		ArchEra::TraditionalPreWar | ArchEra::HistoricOrnate => {
			matches!(
				category,
				BuildingCategory::TallBuilding | BuildingCategory::MasonrySkyscraper
			)
		}
		ArchEra::Unknown => {
			category == BuildingCategory::MasonrySkyscraper
				|| (category == BuildingCategory::TallBuilding
					&& region != BuildingRegion::Other
					&& is_masonry_wall(wall_block))
		}
		ArchEra::PostWarPanel | ArchEra::Contemporary => false,
	}
}

/// The weighted per-category archetype choice, seeded on the shared group seed. Arnis `pick_window_archetype`.
pub fn pick_window_archetype(
	category: BuildingCategory,
	era: ArchEra,
	region: BuildingRegion,
	wall_block: Block,
	cues: PeriodCues,
	group_seed: u64,
) -> WindowArchetype {
	use WindowArchetype::*;
	let tables = data::tables();
	let europe = region == BuildingRegion::Europe;
	let america = region == BuildingRegion::NorthAmerica;
	if is_prewar_masonry_tower(category, era, region, wall_block) {
		let interwar = cues.art_deco || cues.start_year.is_some_and(|y| (1919..1945).contains(&y));
		return if interwar {
			DecoPiers
		} else if cues.start_year.is_some()
			|| era == ArchEra::HistoricOrnate
			|| element_rng(group_seed ^ 0x57A2_C0DE_A5C1_0009).random_bool(tables.chances.prewar_paired_chance)
		{
			PairedPunched
		} else {
			DecoPiers
		};
	}
	let banded_office_years = !cues.dwelling && cues.start_year.is_some_and(|y| (1960..=1995).contains(&y));
	let masonry = is_masonry_wall(wall_block);
	let row = tables
		.archetypes
		.weights
		.iter()
		.find(|row| row.matches(category, region, era, cues.dwelling, masonry, banded_office_years));
	let table: &[(WindowArchetype, u32)] = match row {
		Some(row) => match (row.fixed, &row.table) {
			(Some(fixed), _) => return fixed,
			(None, table) => table,
		},
		None => return Portrait,
	};
	let mut rng = element_rng(group_seed ^ 0x57A2_C0DE_A5C1_0007);
	let total: u32 = table.iter().map(|&(_, w)| w).sum();
	let mut roll = rng.random_range(0..total);
	let mut picked = Portrait;
	for &(archetype, weight) in table {
		if roll < weight {
			picked = archetype;
			break;
		}
		roll -= weight;
	}
	if matches!(
		category,
		BuildingCategory::TallBuilding | BuildingCategory::MasonrySkyscraper | BuildingCategory::ContemporarySkyscraper
	) {
		return picked;
	}
	let mut era_rng = element_rng(group_seed ^ 0x57A2_C0DE_A5C1_0008);
	let undated_masonry =
		era == ArchEra::Unknown && region != BuildingRegion::Other && (cues.old_row_fabric || masonry);
	match (era, picked) {
		(ArchEra::HistoricOrnate, Portrait) if era_rng.random_bool(0.6) => Hooded,
		(ArchEra::HistoricOrnate | ArchEra::TraditionalPreWar, Ribbon | Wide) => Portrait,
		(ArchEra::Unknown, Ribbon | Wide) if undated_masonry => {
			if europe {
				Spaced
			} else {
				Portrait
			}
		}
		(ArchEra::PostWarPanel | ArchEra::Contemporary, Sash | Spaced | Hooded) => {
			if era_rng.random_bool(0.5) {
				Ribbon
			} else {
				Wide
			}
		}
		_ => {
			let _ = america;
			picked
		}
	}
}

/// What the street-facing ground floor is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroundFloor {
	/// Windows like the floors above, from the second row up.
	Plain,
	/// Display glass from the pavement up between dark piers, under a sign band.
	Shopfront,
	/// A tower's glazed entrance hall, laid out like a shopfront.
	Lobby,
}

/// The street-facing ground floor of a building. Arnis `pick_ground_floor`.
#[allow(clippy::too_many_arguments)]
pub fn pick_ground_floor(
	tags: &Tags,
	category: BuildingCategory,
	floors: i32,
	region: BuildingRegion,
	attached: bool,
	has_any_street: bool,
	corner: bool,
	group_seed: u64,
) -> GroundFloor {
	if matches!(
		category,
		BuildingCategory::TallBuilding
			| BuildingCategory::ModernSkyscraper
			| BuildingCategory::ContemporarySkyscraper
			| BuildingCategory::MasonrySkyscraper
			| BuildingCategory::GridSkyscraper
			| BuildingCategory::GlassySkyscraper
			| BuildingCategory::GlassCornerSkyscraper
	) {
		return GroundFloor::Lobby;
	}
	if !has_any_street {
		return GroundFloor::Plain;
	}
	let tagged_shop = tags.get("shop").is_some_and(|v| v != "no")
		|| tags.get("amenity").is_some_and(|v| {
			matches!(
				v.as_str(),
				"restaurant" | "cafe" | "bar" | "pub" | "fast_food" | "bank" | "pharmacy"
			)
		});
	if tagged_shop {
		return GroundFloor::Shopfront;
	}
	let g = &data::tables().chances.ground_floor;
	let chance = match category {
		BuildingCategory::Commercial | BuildingCategory::Hotel => {
			if corner {
				g.commercial_corner
			} else {
				g.commercial
			}
		}
		BuildingCategory::Office => g.office,
		BuildingCategory::Residential | BuildingCategory::Default if floors >= 3 && (attached || corner) => {
			let base = match region {
				BuildingRegion::NorthAmerica => g.residential.north_america,
				BuildingRegion::Europe => g.residential.europe,
				BuildingRegion::Other => g.residential.other,
			};
			if corner {
				base + g.residential_corner_bonus
			} else {
				base
			}
		}
		_ => 0.0,
	};
	if chance > 0.0 && element_rng(group_seed ^ 0x5709_EF90_0000_0002).random_bool(chance) {
		GroundFloor::Shopfront
	} else {
		GroundFloor::Plain
	}
}

/// The dark frame materials of a shopfront, by region.
pub fn shop_frame_options(region: BuildingRegion) -> &'static [Block] {
	let frames = &data::tables().trim.shop_frame;
	match region {
		BuildingRegion::Europe => &frames.europe,
		_ => &frames.default,
	}
}

/// The base, shaft and capital of a masonry tower: a stone base of one to four storeys under a belt course, and a
/// stone attic of one to three storeys under the main cornice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerZoning {
	/// The last wall row of the base, counted from the building's first wall row as row 1.
	pub base_top: i32,
	/// The first wall row of the capital, its band row.
	pub capital_from: Option<i32>,
	/// The stone of the base and the capital.
	pub stone: Block,
	/// Rusticated courses on every other row of the base, if any.
	pub groove: Option<Block>,
}

/// What `TowerZoning::plan` needs of a building.
pub struct ZoningInputs {
	pub is_ground_level: bool,
	pub condition: BuildingCondition,
	pub punched_windows: bool,
	pub window_archetype: WindowArchetype,
	pub floor_cycle: i32,
	pub building_height: i32,
	pub wall_block: Block,
	pub trim_block: Block,
}

impl TowerZoning {
	/// The zones of a pre-war tower shaft of six storeys or more standing on the ground; `start_y_offset` is 0.
	pub fn plan(input: &ZoningInputs) -> Option<Self> {
		if !input.is_ground_level
			|| input.condition != BuildingCondition::Normal
			|| !input.punched_windows
			|| !matches!(
				input.window_archetype,
				WindowArchetype::PairedPunched | WindowArchetype::DecoPiers
			) {
			return None;
		}
		let cycle = input.floor_cycle;
		let grammar_anchor = crate::height::GROUND_FLOOR_BONUS;
		let floors = (input.building_height - grammar_anchor) / cycle;
		if floors < 6 {
			return None;
		}
		let base_floors = match floors {
			..=9 => 1,
			10..=15 => 2,
			16..=24 => 3,
			_ => 4,
		};
		let capital_floors = match floors {
			..=11 => 1,
			12..=24 => 2,
			_ => 3,
		};
		let top = input.building_height;
		let capital = top - capital_floors * cycle;
		let (stone, groove) = if is_light_stone(input.wall_block) {
			let groove = (input.trim_block != input.wall_block).then_some(input.trim_block);
			(input.wall_block, groove)
		} else {
			(input.trim_block, None)
		};
		let floor_row = |h: i32| ((h - grammar_anchor) % cycle + cycle) % cycle;
		let ground_floor_top = grammar_anchor - 1 + cycle;
		let capital_from =
			(input.window_archetype == WindowArchetype::PairedPunched).then(|| capital - floor_row(capital));
		Some(Self {
			base_top: ground_floor_top + (base_floors - 1) * cycle,
			capital_from,
			stone,
			groove,
		})
	}

	/// The zones of a tower whose color or material is mapped keep the mapped wall.
	pub fn keeping_mapped_wall(self, wall_block: Block, tags: &Tags) -> Self {
		if crate::category::has_mapped_wall(tags) {
			Self {
				stone: wall_block,
				groove: None,
				..self
			}
		} else {
			self
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bays_are_symmetric_and_never_touch_a_corner() {
		for len in 3..60 {
			for archetype in [
				WindowArchetype::Sash,
				WindowArchetype::Portrait,
				WindowArchetype::Wide,
				WindowArchetype::Ribbon,
			] {
				let layout = BayLayout::plan(len, archetype.rhythm());
				assert_eq!(layout.slot(0), BaySlot::End, "len {len} {archetype:?}");
				assert_eq!(layout.slot(len - 1), BaySlot::End, "len {len} {archetype:?}");
				let windows = (0..len)
					.filter(|&i| matches!(layout.slot(i), BaySlot::Window { .. }))
					.count() as i32;
				let expected = layout.count * layout.window + i32::from(layout.wide_window);
				assert_eq!(windows, expected, "len {len} {archetype:?}");
			}
		}
	}
}
