// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Arnis `src/osm_parser.rs` at commit d8e8b662 (github.com/louis-e/arnis, Apache-2.0): the packed part
// seed, `StyleHint`, `ArchEra` and the tag readers behind them. Modified: the style, material and cladding word lists
// moved to `packages/structures/data/facade/materials.json`; nothing else changed.

//! Seeds and eras. A building's style is drawn from one seed; the parts of one building share it, and the shared
//! seed carries three facts of the whole building in its high bits: a facade-style hint, the construction year and
//! whether it is housing.

use std::collections::HashMap;

use crate::color::norm_tag;
use crate::data;

/// The OSM tags of a building, as Arnis holds them.
pub type Tags = HashMap<String, String>;

/// Set on a seed derived from a relation id, so it never collides with a way id.
pub const RELATION_SEED_BIT: u64 = 1 << 63;

const STYLE_HINT_SHIFT: u64 = 61;
const STYLE_HINT_MASK: u64 = 0b11 << STYLE_HINT_SHIFT;

/// Set on the shared seed of parts whose building is housing (bit 60).
const RESIDENTIAL_GROUP_BIT: u64 = 1 << 60;

const YEAR_SHIFT: u64 = 52;
const YEAR_MASK: u64 = 0xFF << YEAR_SHIFT;
const YEAR_BASE: i32 = 1800;

/// A facade-style hint read from a building's tags and packed into its parts' seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StyleHint {
	None = 0,
	Masonry = 1,
	Contemporary = 2,
	Glass = 3,
}

pub fn style_hint_from_seed(seed: u64) -> StyleHint {
	match (seed & STYLE_HINT_MASK) >> STYLE_HINT_SHIFT {
		1 => StyleHint::Masonry,
		2 => StyleHint::Contemporary,
		3 => StyleHint::Glass,
		_ => StyleHint::None,
	}
}

/// The seed with its hint, housing and year bits cleared: what the random variant roll reads.
pub fn seed_without_hint(seed: u64) -> u64 {
	seed & !(STYLE_HINT_MASK | RESIDENTIAL_GROUP_BIT | YEAR_MASK)
}

pub fn residential_group_from_seed(seed: u64) -> bool {
	seed & RESIDENTIAL_GROUP_BIT != 0
}

pub fn seed_without_residential_mark(seed: u64) -> u64 {
	seed & !RESIDENTIAL_GROUP_BIT
}

pub fn seed_with_residential_mark(seed: u64, residential: bool) -> u64 {
	if residential {
		seed | RESIDENTIAL_GROUP_BIT
	} else {
		seed
	}
}

/// The key the parts of one building are grouped under: the seed without the bits two parts may not share.
pub fn group_key(seed: u64) -> u64 {
	seed & !(STYLE_HINT_MASK | YEAR_MASK | RESIDENTIAL_GROUP_BIT)
}

pub fn seed_with_hint(seed: u64, hint: StyleHint) -> u64 {
	(seed & !STYLE_HINT_MASK) | ((hint as u64) << STYLE_HINT_SHIFT)
}

/// The construction year packed into a part's shared seed, or `None` for no year.
pub fn year_from_seed(seed: u64) -> Option<i32> {
	let packed = ((seed & YEAR_MASK) >> YEAR_SHIFT) as i32;
	(packed > 0).then_some(YEAR_BASE + packed)
}

pub fn seed_without_year(seed: u64) -> u64 {
	seed & !YEAR_MASK
}

pub fn seed_with_year(seed: u64, year: Option<i32>) -> u64 {
	let packed = year.map_or(0, |y| (y - YEAR_BASE).clamp(1, 255) as u64);
	(seed & !YEAR_MASK) | (packed << YEAR_SHIFT)
}

/// Building types built on the residential storey height: flats, houses and their outbuildings.
pub fn is_housing_type(tags: &Tags) -> bool {
	matches!(
		tags.get("building").map(String::as_str),
		Some(
			"residential"
				| "apartments"
				| "house" | "detached"
				| "semidetached_house"
				| "terrace" | "dormitory"
				| "bungalow" | "villa"
		)
	)
}

/// The mapped architectural style, normalized; the first of a `;` list.
fn architecture(tags: &Tags) -> Option<String> {
	tags.get("building:architecture")
		.or_else(|| tags.get("architecture"))
		.map(|a| norm_tag(a.split(';').next().unwrap_or(a)))
}

/// Whether the building is mapped as art deco.
pub fn is_art_deco(tags: &Tags) -> bool {
	architecture(tags).as_deref() == Some("artdeco")
}

/// The year the building went up, from the first of `start_date`, `construction_date` and `year_of_construction`
/// that holds one.
pub fn building_start_year(tags: &Tags) -> Option<i32> {
	["start_date", "construction_date", "year_of_construction"]
		.iter()
		.find_map(|key| tags.get(*key).and_then(|v| first_year(v)))
}

/// The first four-digit run in a date-like value: `1911-1913` gives 1911.
fn first_year(v: &str) -> Option<i32> {
	let bytes = v.as_bytes();
	let mut i = 0;
	while i + 4 <= bytes.len() {
		if bytes[i..i + 4].iter().all(|b| b.is_ascii_digit()) {
			return v[i..i + 4].parse().ok();
		}
		i += 1;
	}
	None
}

fn material_of(tags: &Tags) -> Option<String> {
	tags.get("building:material")
		.or_else(|| tags.get("building:facade:material"))
		.or_else(|| tags.get("facade:material"))
		.map(|m| norm_tag(m))
}

/// A facade style for a building from its tags, or `None` to leave it to the random roll.
pub fn building_style_hint(tags: &Tags) -> StyleHint {
	let words = &data::tables().materials;
	let material = material_of(tags);
	if material.as_deref() == Some("glass") || material.as_deref() == Some("mirror") {
		return StyleHint::Glass;
	}
	if tags.get("roof:material").map(|r| norm_tag(r)).as_deref() == Some("glass") {
		return StyleHint::Glass;
	}
	let arch = architecture(tags);
	let year = building_start_year(tags);
	if is_listed(tags) && !listed_for_modern_design(tags, arch.as_deref(), year) {
		return StyleHint::Masonry;
	}
	if material
		.as_deref()
		.is_some_and(|m| words.masonry_materials.iter().any(|w| w == m))
	{
		return StyleHint::Masonry;
	}
	if let Some(c) = tags.get("building:cladding") {
		if words.masonry_cladding.iter().any(|w| *w == norm_tag(c)) {
			return StyleHint::Masonry;
		}
	}
	if let Some(a) = arch.as_deref() {
		if words.ornate_styles.iter().any(|w| w == a) || words.brutalist_styles.iter().any(|w| w == a) {
			return StyleHint::Masonry;
		}
		if words.modern_styles.iter().any(|w| w == a) {
			return StyleHint::Contemporary;
		}
	}
	if year.is_some_and(|y| y < 1945) {
		return StyleHint::Masonry;
	}
	if material
		.as_deref()
		.is_some_and(|m| words.concrete_materials.iter().any(|w| w == m))
	{
		return StyleHint::Contemporary;
	}
	StyleHint::None
}

/// The architectural era low-rise styling reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchEra {
	Unknown,
	/// Explicit heritage or ornate-architecture signals.
	HistoricOrnate,
	/// Pre-1945 masonry fabric without ornate signals.
	TraditionalPreWar,
	/// 1945 to 1979: panel, prefab, brutalist.
	PostWarPanel,
	/// 1980 on: concrete and glass.
	Contemporary,
}

/// Whether the building is listed or marked historic. `no` on these keys is a negation, not a signal.
fn is_listed(tags: &Tags) -> bool {
	let present_and_not_no = |key: &str| tags.get(key).is_some_and(|v| !v.eq_ignore_ascii_case("no"));
	present_and_not_no("historic")
		|| present_and_not_no("heritage")
		|| tags.contains_key("ref:nrhp")
		|| present_and_not_no("listed_status")
}

fn listed_for_modern_design(tags: &Tags, arch: Option<&str>, year: Option<i32>) -> bool {
	arch.is_some_and(|a| data::tables().materials.modern_styles.iter().any(|w| w == a))
		|| (year.is_some_and(|y| y >= 1945) && !is_place_of_worship(tags))
}

fn is_place_of_worship(tags: &Tags) -> bool {
	tags.get("amenity").is_some_and(|a| a == "place_of_worship")
		|| tags.get("building").is_some_and(|b| {
			matches!(
				b.as_str(),
				"church"
					| "cathedral" | "chapel"
					| "basilica" | "mosque"
					| "synagogue" | "temple"
					| "shrine" | "monastery"
			)
		})
}

/// The year a building passes on to its parts: its own date, unless the date is later than its style.
pub fn year_for_parts(tags: &Tags) -> Option<i32> {
	let year = building_start_year(tags)?;
	(year < 1945
		|| matches!(
			building_arch_era_dated(tags, Some(year)),
			ArchEra::PostWarPanel | ArchEra::Contemporary
		))
	.then_some(year)
}

/// The era of a building put up in `year`.
pub fn era_for_year(year: i32) -> ArchEra {
	if year < 1945 {
		ArchEra::TraditionalPreWar
	} else if year < 1980 {
		ArchEra::PostWarPanel
	} else {
		ArchEra::Contemporary
	}
}

/// The era of a building from its tags, with `year` standing in for the date tags.
pub fn building_arch_era_dated(tags: &Tags, year: Option<i32>) -> ArchEra {
	let words = &data::tables().materials;
	let arch = architecture(tags);
	if let Some(a) = arch.as_deref() {
		if words.ornate_styles.iter().any(|w| w == a) {
			return ArchEra::HistoricOrnate;
		}
		if words.brutalist_styles.iter().any(|w| w == a) {
			return ArchEra::PostWarPanel;
		}
		if words.modern_styles.iter().any(|w| w == a) {
			return year.map_or(ArchEra::Contemporary, era_for_year);
		}
	}
	if is_listed(tags) {
		return match year {
			Some(y) if listed_for_modern_design(tags, None, Some(y)) => era_for_year(y),
			_ => ArchEra::HistoricOrnate,
		};
	}
	if let Some(y) = year {
		return era_for_year(y);
	}
	if let Some(m) = material_of(tags).as_deref() {
		if words.panel_materials.iter().any(|w| w == m) {
			return ArchEra::PostWarPanel;
		}
		if words.masonry_materials.iter().any(|w| w == m) {
			return ArchEra::TraditionalPreWar;
		}
		if words.concrete_materials.iter().any(|w| w == m) || m == "glass" || m == "mirror" {
			return ArchEra::Contemporary;
		}
	}
	if let Some(c) = tags.get("building:cladding") {
		if words.masonry_cladding.iter().any(|w| *w == norm_tag(c)) {
			return ArchEra::TraditionalPreWar;
		}
	}
	ArchEra::Unknown
}

/// The fallback era of an untagged part, from its group seed's hint.
pub fn arch_era_from_hint(hint: StyleHint) -> ArchEra {
	match hint {
		StyleHint::Masonry => ArchEra::TraditionalPreWar,
		StyleHint::Contemporary | StyleHint::Glass => ArchEra::Contemporary,
		StyleHint::None => ArchEra::Unknown,
	}
}

/// Whether a part stands on the ground: no positive `min_height` or `building:min_level`.
pub fn part_covers_ground(tags: &Tags) -> bool {
	let leading_f64 = |s: &str| {
		let t = s.trim();
		let mut end = 0;
		let mut seen_dot = false;
		for (i, c) in t.char_indices() {
			let ok = c.is_ascii_digit() || (c == '.' && !seen_dot) || ((c == '-' || c == '+') && i == 0);
			if !ok {
				break;
			}
			seen_dot |= c == '.';
			end = i + c.len_utf8();
		}
		t[..end].parse::<f64>().ok()
	};
	let min_h = tags.get("min_height").and_then(|s| leading_f64(s));
	let min_lvl = tags.get("building:min_level").and_then(|s| leading_f64(s));
	min_h.unwrap_or(0.0) <= 0.0 && min_lvl.unwrap_or(0.0) <= 0.0
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_packed_bits_round_trip() {
		let seed = seed_with_year(seed_with_hint(4242, StyleHint::Glass), Some(1962));
		assert_eq!(year_from_seed(seed), Some(1962));
		assert_eq!(style_hint_from_seed(seed), StyleHint::Glass);
		assert_eq!(seed_without_year(seed), seed_with_hint(4242, StyleHint::Glass));
		assert_eq!(year_from_seed(seed_with_year(4242, None)), None);
		assert_eq!(group_key(seed_with_residential_mark(seed, true)), 4242);
	}

	#[test]
	fn eras_follow_dates_styles_and_materials() {
		let tags =
			|pairs: &[(&str, &str)]| -> Tags { pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() };
		assert_eq!(
			building_arch_era_dated(&tags(&[("start_date", "1911-1913")]), Some(1911)),
			ArchEra::TraditionalPreWar
		);
		assert_eq!(
			building_arch_era_dated(&tags(&[("building:architecture", "art_deco")]), None),
			ArchEra::HistoricOrnate
		);
		assert_eq!(
			building_arch_era_dated(&tags(&[("building:material", "panel")]), None),
			ArchEra::PostWarPanel
		);
		assert_eq!(
			building_style_hint(&tags(&[("building:material", "glass")])),
			StyleHint::Glass
		);
		assert_eq!(building_style_hint(&tags(&[("heritage", "2")])), StyleHint::Masonry);
	}
}
