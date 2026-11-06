// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Arnis `src/element_processing/buildings.rs` at commit d8e8b662 (github.com/louis-e/arnis,
// Apache-2.0): `MaterialRegion`, `BuildingRegion` and `RoofHabit`. Modified: the hand-traced borders moved to
// `packages/structures/data/facade/regions.json` as an ordered rule list, which this module evaluates with the same
// arithmetic; the enum, the coarse region map and the roof habits read the same file.

//! Where a building stands decides which material pools and roof habits it draws from: a building-material
//! region, and the coarser roof-shape region it belongs to.

use serde::Deserialize;

use crate::data;

/// Building-material tradition of the area, finer than [`BuildingRegion`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialRegion {
	NorthAmerica,
	NorthAmericaSunbelt,
	Canada,
	BritishIsles,
	BrickNorth,
	France,
	Central,
	CentralEast,
	Nordic,
	Mediterranean,
	EastEurope,
	CentralAsia,
	MiddleEast,
	SubSaharanAfrica,
	SouthAsia,
	SoutheastAsia,
	EastAsia,
	Korea,
	Japan,
	LatinAmerica,
	SouthernCone,
	Australasia,
	Other,
}

/// Building tradition of the area: roof habits differ most between these three.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildingRegion {
	NorthAmerica,
	Europe,
	Other,
}

/// How untagged roofs are pitched where the European and North American rules do not apply.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct RoofHabit {
	/// Chance that a house, or a small low free-standing `building=yes`, gets a pitched roof.
	pub house: f64,
	/// Chance for a low urban block up to `block_max_m`; taller and larger blocks are flat.
	pub block: f64,
	pub block_max_m: f64,
	/// Share of free-standing pitched roofs that are hipped.
	pub hipped: f64,
}

impl BuildingRegion {
	pub fn at(lat: f64, lon: f64) -> Self {
		MaterialRegion::at(lat, lon).building_region()
	}
}

impl MaterialRegion {
	/// The region holding a point, by the rule list.
	pub fn at(lat: f64, lon: f64) -> Self {
		let regions = &data::tables().regions;
		evaluate_rules(&regions.rules, lat, lon, regions).unwrap_or(MaterialRegion::Other)
	}

	/// The roof-shape tradition the material region belongs to.
	pub fn building_region(self) -> BuildingRegion {
		let map = &data::tables().regions.building_region;
		if map.north_america.contains(&self) {
			BuildingRegion::NorthAmerica
		} else if map.europe.contains(&self) {
			BuildingRegion::Europe
		} else {
			BuildingRegion::Other
		}
	}

	/// The roof habit of the regions outside the European town and North American city rules.
	pub fn roof_habit(self) -> Option<RoofHabit> {
		data::tables().regions.roof_habits.get(&self).copied()
	}
}

/// The region tables as `regions.json` holds them.
#[derive(Deserialize)]
pub struct RegionTables {
	pub building_region: BuildingRegionMap,
	pub roof_habits: std::collections::HashMap<MaterialRegion, RoofHabit>,
	pub classifiers: std::collections::HashMap<String, Vec<BoolRule>>,
	pub rules: Vec<Rule>,
}

#[derive(Deserialize)]
pub struct BuildingRegionMap {
	pub north_america: Vec<MaterialRegion>,
	pub europe: Vec<MaterialRegion>,
}

#[derive(Deserialize)]
pub struct Rule {
	pub when: Predicate,
	#[serde(default)]
	pub region: Option<MaterialRegion>,
	#[serde(default)]
	pub rules: Vec<Rule>,
}

#[derive(Deserialize)]
pub struct BoolRule {
	pub when: Predicate,
	pub value: Predicate,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Predicate {
	Literal(bool),
	All { all: Vec<Predicate> },
	Any { any: Vec<Predicate> },
	Not { not: Box<Predicate> },
	Ref { r#ref: String },
	Lat { lat: Comparison },
	Lon { lon: Comparison },
}

/// One comparison, written as `{"gt": rhs}`, `{"ge": rhs}`, `{"lt": rhs}` or `{"le": rhs}`.
#[derive(Deserialize)]
pub struct Comparison {
	#[serde(default)]
	gt: Option<Rhs>,
	#[serde(default)]
	ge: Option<Rhs>,
	#[serde(default)]
	lt: Option<Rhs>,
	#[serde(default)]
	le: Option<Rhs>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Rhs {
	Number(f64),
	Function(PiecewiseFunction),
}

#[derive(Deserialize)]
pub struct PiecewiseFunction {
	of: Axis,
	pieces: Vec<Piece>,
	#[serde(default)]
	cap: Option<f64>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
	Lat,
	Lon,
}

#[derive(Deserialize)]
pub struct Piece {
	#[serde(default)]
	below: Option<f64>,
	#[serde(default)]
	upto: Option<f64>,
	#[serde(default)]
	value: Option<f64>,
	#[serde(default)]
	slope: Option<f64>,
	#[serde(default)]
	at: Option<f64>,
	#[serde(default)]
	interpolate: Option<Vec<(f64, f64)>>,
}

fn evaluate_rules(rules: &[Rule], lat: f64, lon: f64, tables: &RegionTables) -> Option<MaterialRegion> {
	for rule in rules {
		if !rule.when.holds(lat, lon, tables) {
			continue;
		}
		if let Some(region) = rule.region {
			return Some(region);
		}
		if let Some(region) = evaluate_rules(&rule.rules, lat, lon, tables) {
			return Some(region);
		}
	}
	None
}

impl Predicate {
	fn holds(&self, lat: f64, lon: f64, tables: &RegionTables) -> bool {
		match self {
			Predicate::Literal(value) => *value,
			Predicate::All { all } => all.iter().all(|p| p.holds(lat, lon, tables)),
			Predicate::Any { any } => any.iter().any(|p| p.holds(lat, lon, tables)),
			Predicate::Not { not } => !not.holds(lat, lon, tables),
			Predicate::Ref { r#ref } => tables
				.classifiers
				.get(r#ref)
				.and_then(|rules| rules.iter().find(|rule| rule.when.holds(lat, lon, tables)))
				.is_some_and(|rule| rule.value.holds(lat, lon, tables)),
			Predicate::Lat { lat: comparison } => comparison.holds(lat, lat, lon),
			Predicate::Lon { lon: comparison } => comparison.holds(lon, lat, lon),
		}
	}
}

impl Comparison {
	fn holds(&self, x: f64, lat: f64, lon: f64) -> bool {
		if let Some(rhs) = &self.gt {
			return x > rhs.value(lat, lon);
		}
		if let Some(rhs) = &self.ge {
			return x >= rhs.value(lat, lon);
		}
		if let Some(rhs) = &self.lt {
			return x < rhs.value(lat, lon);
		}
		if let Some(rhs) = &self.le {
			return x <= rhs.value(lat, lon);
		}
		false
	}
}

impl Rhs {
	fn value(&self, lat: f64, lon: f64) -> f64 {
		match self {
			Rhs::Number(n) => *n,
			Rhs::Function(f) => f.value(match f.of {
				Axis::Lat => lat,
				Axis::Lon => lon,
			}),
		}
	}
}

impl PiecewiseFunction {
	fn value(&self, x: f64) -> f64 {
		let piece = self
			.pieces
			.iter()
			.find(|piece| match (piece.below, piece.upto) {
				(Some(bound), _) => x < bound,
				(None, Some(bound)) => x <= bound,
				(None, None) => true,
			})
			.or_else(|| self.pieces.last());
		let value = match piece {
			None => 0.0,
			Some(piece) => match (&piece.interpolate, piece.value, piece.slope, piece.at) {
				(Some(points), _, _, _) => interpolate(points, x),
				(None, Some(value), Some(slope), Some(at)) => value + slope * (x - at),
				(None, Some(value), _, _) => value,
				_ => 0.0,
			},
		};
		match self.cap {
			Some(cap) => value.min(cap),
			None => value,
		}
	}
}

/// Piecewise-linear value at `x` through `points` sorted by x, held flat beyond the ends. Arnis `interpolate`.
fn interpolate(points: &[(f64, f64)], x: f64) -> f64 {
	let (first, last) = (points[0], points[points.len() - 1]);
	if x <= first.0 {
		return first.1;
	}
	for pair in points.windows(2) {
		let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
		if x <= x1 {
			return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
		}
	}
	last.1
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn cities_land_in_their_regions() {
		assert_eq!(MaterialRegion::at(35.69, 139.76), MaterialRegion::Japan);
		assert_eq!(MaterialRegion::at(42.33, -83.05), MaterialRegion::NorthAmerica);
		// Windsor, across the Detroit river.
		assert_eq!(MaterialRegion::at(42.30, -83.03), MaterialRegion::Canada);
		assert_eq!(MaterialRegion::at(48.86, 2.35), MaterialRegion::France);
		assert_eq!(MaterialRegion::at(51.5, -0.12), MaterialRegion::BritishIsles);
		assert_eq!(MaterialRegion::at(55.75, 37.62), MaterialRegion::EastEurope);
		assert_eq!(MaterialRegion::at(-33.87, 151.21), MaterialRegion::Australasia);
		assert_eq!(MaterialRegion::at(19.43, -99.13), MaterialRegion::LatinAmerica);
		assert_eq!(MaterialRegion::Japan.building_region(), BuildingRegion::Other);
		assert_eq!(MaterialRegion::France.building_region(), BuildingRegion::Europe);
		assert!(MaterialRegion::Japan.roof_habit().is_some());
		assert!(MaterialRegion::France.roof_habit().is_none());
	}
}
