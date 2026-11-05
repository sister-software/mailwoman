// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Arnis `src/deterministic_rng.rs` at commit d8e8b662 (github.com/louis-e/arnis, Apache-2.0).
// Unmodified apart from the doc comments.

//! Deterministic random number generation: the same seed always yields the same sequence, so a building's style is a
//! function of its id and tags alone.

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

/// A ChaCha8 generator seeded from an element id or a derived seed.
#[inline]
pub fn element_rng(element_id: u64) -> ChaCha8Rng {
	ChaCha8Rng::seed_from_u64(element_id)
}

/// A generator seeded from an element id and a salt, for a second independent sequence of the same element.
#[inline]
pub fn element_rng_salted(element_id: u64, salt: u64) -> ChaCha8Rng {
	let combined = element_id ^ salt.rotate_left(32);
	ChaCha8Rng::seed_from_u64(combined)
}

/// A generator seeded from a cell and an id, for per-cell draws that must not depend on processing order.
#[inline]
pub fn coord_rng(x: i32, z: i32, element_id: u64) -> ChaCha8Rng {
	let coord_part = ((x as u32 as i64) << 32) | (z as u32 as i64);
	let seed = (coord_part as u64) ^ element_id;
	ChaCha8Rng::seed_from_u64(seed)
}

/// An integer hash of a seed and a cell: splitmix64's finalizer over the seed and the two coordinates.
/// Ported from Arnis `src/element_processing/rooftops.rs` `hash2`.
pub fn hash2(seed: u64, a: i32, b: i32) -> u64 {
	let mut h = seed
		^ u64::from(a as u32).wrapping_mul(0x9E37_79B9_7F4A_7C15)
		^ u64::from(b as u32).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
	h ^= h >> 30;
	h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
	h ^= h >> 27;
	h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
	h ^ (h >> 31)
}

#[cfg(test)]
mod tests {
	use super::*;
	use rand::Rng;

	#[test]
	fn the_same_seed_gives_the_same_sequence() {
		let mut a = element_rng(12345);
		let mut b = element_rng(12345);
		for _ in 0..100 {
			assert_eq!(a.random::<u64>(), b.random::<u64>());
		}
	}

	#[test]
	fn coordinates_seed_without_order() {
		let mut a = coord_rng(-100, -200, 1);
		let mut b = coord_rng(-100, -200, 1);
		assert_eq!(a.random::<u64>(), b.random::<u64>());
		let mut c = coord_rng(-101, -200, 1);
		assert_ne!(a.random::<u64>(), c.random::<u64>());
	}
}
