// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// The layout follows Planetiler 0.10.2's FeatureGroup (Apache-2.0, Copyright Michael Barry).

//! The 64-bit sort key of a rendered feature.
//!
//! From the highest bit down: 33 bits of Hilbert tile id, 8 bits of layer, 22 bits of sort key offset by its minimum,
//! and 1 bit set when the feature carries a label-grid group. Sorting by this key puts every tile's features together
//! in Hilbert order, each layer's features together, and each layer's features in ascending sort key.

/// The number of bits the sort key occupies.
pub const SORT_KEY_BITS: u32 = 22;
/// The largest sort key a feature can carry.
pub const SORT_KEY_MAX: i32 = (1 << (SORT_KEY_BITS - 1)) - 1;
/// The smallest sort key a feature can carry.
pub const SORT_KEY_MIN: i32 = -(1 << (SORT_KEY_BITS - 1));
const SORT_KEY_MASK: u64 = (1 << SORT_KEY_BITS) - 1;
const TILE_ID_BITS: u32 = 33;

/// Packs a tile id, layer, sort key and group flag into a key.
pub fn encode_key(tile_id: u64, layer: u8, sort_key: i32, has_group: bool) -> u64 {
	(tile_id << (64 - TILE_ID_BITS))
		| (u64::from(layer) << (SORT_KEY_BITS + 1))
		| ((((i64::from(sort_key) - i64::from(SORT_KEY_MIN)) as u64) & SORT_KEY_MASK) << 1)
		| u64::from(has_group)
}

pub fn tile_of(key: u64) -> u64 {
	key >> (64 - TILE_ID_BITS)
}

pub fn layer_of(key: u64) -> u8 {
	(key >> (SORT_KEY_BITS + 1)) as u8
}

pub fn sort_key_of(key: u64) -> i32 {
	(((key >> 1) & SORT_KEY_MASK) as i64 + i64::from(SORT_KEY_MIN)) as i32
}

pub fn has_group(key: u64) -> bool {
	key & 1 == 1
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn fields_round_trip_and_order_as_tile_then_layer_then_sort_key() {
		let key = encode_key(1_431_655_764, 7, -12, true);
		assert_eq!(tile_of(key), 1_431_655_764);
		assert_eq!(layer_of(key), 7);
		assert_eq!(sort_key_of(key), -12);
		assert!(has_group(key));
		assert!(encode_key(5, 0, SORT_KEY_MAX, true) < encode_key(6, 0, SORT_KEY_MIN, false));
		assert!(encode_key(5, 1, SORT_KEY_MIN, false) > encode_key(5, 0, SORT_KEY_MAX, true));
		assert!(encode_key(5, 1, -1, false) < encode_key(5, 1, 0, false));
	}
}
