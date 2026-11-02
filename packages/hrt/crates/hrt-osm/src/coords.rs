// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Web Mercator world coordinates and the packed node location Planetiler stores for every node.
//!
//! World coordinates run from (0, 0) at the north-west corner of the map to (1, 1) at the south-east corner. A node
//! location packs the world x and y, each offset by 1 and scaled to 31 bits, into the upper and lower halves of a
//! `u64`. The functions here repeat Planetiler 0.10.2's `GeoUtils` arithmetic step for step, because the Java build
//! truncates the scaled values to integers and a different order of operations can move a coordinate by one unit.

use std::f64::consts::PI;

const RADIANS_PER_DEGREE: f64 = PI / 180.0;
const DEGREES_PER_RADIAN: f64 = 180.0 / PI;
const HALF_QUANTIZED_WORLD_SIZE: f64 = (1u64 << 30) as f64;
const LOWER_32_BIT_MASK: u64 = (1 << 32) - 1;

/// Returns the latitude for a world y coordinate.
pub fn world_lat(y: f64) -> f64 {
	let n = PI - 2.0 * PI * y;
	DEGREES_PER_RADIAN * (0.5 * (n.exp() - (-n).exp())).atan()
}

/// Returns the world x coordinate for a longitude: 0 at the antimeridian's west side, 0.5 at the prime meridian.
pub fn world_x(longitude: f64) -> f64 {
	(longitude + 180.0) / 360.0
}

/// Returns the world y coordinate for a latitude: 0 at the map's north edge, 0.5 at the equator, 1 at the south edge.
///
/// A latitude north of the y = −0.1 line returns −0.1, and one south of the y = 1.1 line returns 1.1, as Planetiler does.
pub fn world_y(latitude: f64) -> f64 {
	if latitude <= min_lat() {
		return 1.1;
	}
	if latitude >= max_lat() {
		return -0.1;
	}
	let sin = (latitude * RADIANS_PER_DEGREE).sin();
	0.5 - 0.25 * ((1.0 + sin) / (1.0 - sin)).ln() / PI
}

fn max_lat() -> f64 {
	world_lat(-0.1)
}

fn min_lat() -> f64 {
	world_lat(1.1)
}

/// Packs a longitude and latitude into the 64-bit node location Planetiler stores.
pub fn encode_flat_location(lon: f64, lat: f64) -> u64 {
	let x = ((world_x(lon) + 1.0) * HALF_QUANTIZED_WORLD_SIZE) as i64;
	let y = ((world_y(lat) + 1.0) * HALF_QUANTIZED_WORLD_SIZE) as i64;
	((x as u64) << 32) | (y as u64 & LOWER_32_BIT_MASK)
}

/// Returns the world x coordinate of a packed node location.
pub fn decode_world_x(encoded: u64) -> f64 {
	(encoded >> 32) as f64 / HALF_QUANTIZED_WORLD_SIZE - 1.0
}

/// Returns the world y coordinate of a packed node location.
pub fn decode_world_y(encoded: u64) -> f64 {
	(encoded & LOWER_32_BIT_MASK) as f64 / HALF_QUANTIZED_WORLD_SIZE - 1.0
}

/// Returns the world coordinate pair of a packed node location.
pub fn decode_world(encoded: u64) -> [f64; 2] {
	[decode_world_x(encoded), decode_world_y(encoded)]
}

/// Converts a PBF coordinate in nanodegrees to degrees with the multiplication Planetiler's `PbfFieldDecoder` performs.
pub fn nano_to_degrees(nano: i64) -> f64 {
	0.000000001 * nano as f64
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn prime_meridian_and_equator_sit_at_the_world_center_line() {
		assert_eq!(world_x(0.0), 0.5);
		assert_eq!(world_y(0.0), 0.5);
		let encoded = encode_flat_location(0.0, 0.0);
		assert_eq!(decode_world(encoded), [0.5, 0.5]);
	}

	#[test]
	fn latitudes_past_the_mercator_edge_clamp_to_planetiler_bounds() {
		assert_eq!(world_y(89.9), -0.1);
		assert_eq!(world_y(-89.9), 1.1);
	}

	#[test]
	fn a_round_trip_moves_a_coordinate_by_less_than_one_quantum() {
		let quantum = 1.0 / HALF_QUANTIZED_WORLD_SIZE;
		for (lon, lat) in [
			(7.4246, 43.7384),
			(-122.4194, 37.7749),
			(139.6917, 35.6895),
			(-179.99, -84.9),
		] {
			let [x, y] = decode_world(encode_flat_location(lon, lat));
			assert!(world_x(lon) - x >= 0.0 && world_x(lon) - x < quantum);
			assert!(world_y(lat) - y >= 0.0 && world_y(lat) - y < quantum);
		}
	}
}
