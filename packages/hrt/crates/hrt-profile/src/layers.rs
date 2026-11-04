// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The basemap layers ported from the fork's `layers/` package.

pub mod boundaries;
pub mod buildings;
pub mod earth;
pub mod facilities;
pub mod infrastructure;
pub mod landcover;
pub mod landuse;
pub mod places;
pub mod pois;
pub mod roads;
pub mod transit;
pub mod trees;
pub mod water;

/// The world-coordinate area of a square of `square_meters` at the equator, as the fork computes it:
/// `Math.pow(GeoUtils.metersToPixelAtEquator(0, Math.sqrt(square_meters)) / 256, 2)`.
pub(crate) fn world_area_for_square_meters(square_meters: f64) -> f64 {
	let circumference = std::f64::consts::PI * 2.0 * 6_378_137.0;
	let meters_per_pixel = circumference / 2f64.powf(8.0);
	(square_meters.sqrt() / meters_per_pixel / 256.0).powi(2)
}
