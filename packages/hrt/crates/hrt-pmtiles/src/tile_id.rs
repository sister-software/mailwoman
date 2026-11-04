// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Hilbert tile ids.
//!
//! A tile's id is the count of tiles in every lower zoom, `(4^z - 1) / 3`, plus the tile's position along the Hilbert
//! curve that fills its own zoom. The rotation matches `zxyToTileId` and `tileIdToZxy` in the `pmtiles` JavaScript
//! reader, so an id written here is the id that reader looks up.

/// The highest zoom whose ids fit the reader's arithmetic. The JavaScript reader refuses zoom 27 and above, because
/// its ids are doubles.
pub const MAX_ZOOM: u8 = 26;

/// The number of tiles in all zooms below `z`.
fn zoom_base(z: u8) -> u64 {
	((1u64 << (2 * z as u32)) - 1) / 3
}

/// Rotates a quadrant so the curve's sub-square is oriented as the parent's.
///
/// The reflection subtracts the full coordinate from the quadrant size, as the JavaScript reader does in signed
/// arithmetic. The subtraction wraps here; later steps read only the coordinate's bits below the current quadrant, and
/// those bits are the same either way.
fn rotate(size: u64, x: u64, y: u64, rx: u64, ry: u64) -> (u64, u64) {
	if ry == 0 {
		if rx != 0 {
			return (
				size.wrapping_sub(1).wrapping_sub(y),
				size.wrapping_sub(1).wrapping_sub(x),
			);
		}
		return (y, x);
	}
	(x, y)
}

/// The Hilbert tile id of the tile at zoom `z`, column `x` and row `y`.
///
/// # Panics
///
/// Panics when `z` exceeds [`MAX_ZOOM`] or `x` or `y` is outside the zoom's `2^z` tiles.
pub fn tile_id(z: u8, x: u32, y: u32) -> u64 {
	assert!(z <= MAX_ZOOM, "zoom {z} exceeds {MAX_ZOOM}");
	let size = 1u64 << z;
	let (mut x, mut y) = (u64::from(x), u64::from(y));
	assert!(x < size && y < size, "tile {x}/{y} is outside zoom {z}");

	let mut distance = 0u64;
	let mut quadrant = size >> 1;

	while quadrant > 0 {
		let rx = x & quadrant;
		let ry = y & quadrant;
		let rx_bit = u64::from(rx != 0);
		let ry_bit = u64::from(ry != 0);

		distance += quadrant * quadrant * ((3 * rx_bit) ^ ry_bit);
		(x, y) = rotate(quadrant, x, y, rx, ry);
		quadrant >>= 1;
	}

	zoom_base(z) + distance
}

/// The zoom, column and row of a Hilbert tile id; the inverse of [`tile_id`].
///
/// # Panics
///
/// Panics when the id is above the last id of [`MAX_ZOOM`].
pub fn tile_id_to_zxy(id: u64) -> (u8, u32, u32) {
	let mut z = 0u8;

	while zoom_base(z + 1) <= id {
		z += 1;
		assert!(z <= MAX_ZOOM, "tile id {id} is beyond zoom {MAX_ZOOM}");
	}

	let size = 1u64 << z;
	let mut t = id - zoom_base(z);
	let (mut x, mut y) = (0u64, 0u64);
	let mut quadrant = 1u64;

	while quadrant < size {
		let rx = 1 & (t / 2);
		let ry = 1 & (t ^ rx);

		(x, y) = rotate(quadrant, x, y, rx, ry);
		x += quadrant * rx;
		y += quadrant * ry;
		t /= 4;
		quadrant <<= 1;
	}

	(z, x as u32, y as u32)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn zoom_zero_and_one_follow_the_curve() {
		assert_eq!(tile_id(0, 0, 0), 0);
		assert_eq!(tile_id(1, 0, 0), 1);
		assert_eq!(tile_id(1, 0, 1), 2);
		assert_eq!(tile_id(1, 1, 1), 3);
		assert_eq!(tile_id(1, 1, 0), 4);
		assert_eq!(tile_id(2, 0, 0), 5);
	}

	#[test]
	fn inverse_recovers_every_tile_through_zoom_six() {
		for z in 0..=6u8 {
			let size = 1u32 << z;
			for x in 0..size {
				for y in 0..size {
					assert_eq!(tile_id_to_zxy(tile_id(z, x, y)), (z, x, y));
				}
			}
		}
	}

	#[test]
	fn ids_are_dense_within_a_zoom() {
		let mut ids: Vec<u64> = (0..16u32)
			.flat_map(|x| (0..16u32).map(move |y| tile_id(4, x, y)))
			.collect();
		ids.sort_unstable();
		let base = zoom_base(4);
		assert_eq!(ids, (base..base + 256).collect::<Vec<_>>());
	}
}
