// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Arnis `src/climate.rs` at commit d8e8b662 (github.com/louis-e/arnis, Apache-2.0): the `Climate`
// classes and the fold from Koppen-Geiger classes. Modified: Arnis samples a bundled 0.1 degree grid once per
// generation; this module takes the class per building and, without a grid, returns the class Arnis gives ocean
// and unknown cells.

//! The climate axis of the style decisions: arid classes damp pitched roofs and favor light walls, boreal classes
//! add timber. Temperate changes nothing.

/// The ten climate groups the style decisions distinguish.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Climate {
	/// C*, humid-continental D*, tropical rainforest, and ocean or no data.
	Temperate,
	TropicalSavanna,
	HotDesert,
	HotSteppe,
	ColdDesert,
	ColdSteppe,
	DryContinental,
	Boreal,
	Tundra,
	IceCap,
}

impl Climate {
	/// Deserts, steppes and dry-summer continental climates.
	pub fn is_dry(self) -> bool {
		matches!(
			self,
			Climate::HotDesert
				| Climate::ColdDesert
				| Climate::HotSteppe
				| Climate::ColdSteppe
				| Climate::DryContinental
		)
	}

	/// The group of a Koppen-Geiger class, numbered 1 to 30 as Beck et al. 2023 number them; 0 is ocean or no data.
	pub fn from_class(c: u8) -> Climate {
		match c {
			3 => Climate::TropicalSavanna,
			4 => Climate::HotDesert,
			5 => Climate::ColdDesert,
			6 => Climate::HotSteppe,
			7 => Climate::ColdSteppe,
			17 | 18 => Climate::DryContinental,
			19 | 20 | 23 | 24 | 27 | 28 => Climate::Boreal,
			29 => Climate::Tundra,
			30 => Climate::IceCap,
			_ => Climate::Temperate,
		}
	}

	/// The climate at a point. No Koppen grid ships with the crate yet (its acquisition runs on AWS, see
	/// `packages/structures/sdk/koppen/fetch.run.ts`), so every point takes the group of class 0: `Temperate`,
	/// which leaves every style decision as Arnis makes it for an unknown cell.
	pub fn at(_lat: f64, _lon: f64) -> Climate {
		Climate::from_class(0)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn classes_fold_into_groups() {
		assert_eq!(Climate::from_class(4), Climate::HotDesert);
		assert_eq!(Climate::from_class(7), Climate::ColdSteppe);
		assert_eq!(Climate::from_class(30), Climate::IceCap);
		assert_eq!(Climate::from_class(15), Climate::Temperate);
		assert_eq!(Climate::from_class(21), Climate::Temperate);
		assert_eq!(Climate::from_class(18), Climate::DryContinental);
		assert_eq!(Climate::at(42.33, -83.05), Climate::Temperate);
	}
}
