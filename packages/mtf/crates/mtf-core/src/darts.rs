// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Derived from darts-clone's `darts.h` as vendored in Google SentencePiece v0.2.2
// (`third_party/darts_clone/darts.h`). Copyright (c) 2008-2011, Susumu Yata. All rights reserved.
// Redistributed under the BSD 2-clause terms in `third-party/darts-clone/LICENSE` of this workspace.
// Modified: the double-array prefix search was ported from C++ to Rust and bounds-checked.

//! A reader for darts-clone double-array tries, the format of SentencePiece's compiled
//! normalization map.

use crate::error::Error;

/// A borrowed darts-clone double array, read in place from little-endian units.
pub struct DoubleArray<'a> {
	units: &'a [u8],
}

fn has_leaf(u: u32) -> bool {
	(u >> 8) & 1 == 1
}

fn value(u: u32) -> u32 {
	u & 0x7FFF_FFFF
}

fn label(u: u32) -> u32 {
	u & (0x8000_0000 | 0xFF)
}

fn offset(u: u32) -> u32 {
	(u >> 10) << ((u & (1 << 9)) >> 6)
}

impl<'a> DoubleArray<'a> {
	/// Wraps `blob`, whose length must be a whole number of 4-byte units.
	pub fn new(blob: &'a [u8]) -> Result<Self, Error> {
		if blob.is_empty() || !blob.len().is_multiple_of(4) {
			return Err(Error::MalformedModel(
				"double array is not a whole number of units".into(),
			));
		}
		Ok(Self { units: blob })
	}

	fn unit(&self, index: u32) -> Option<u32> {
		let start = index as usize * 4;
		let bytes = self.units.get(start..start + 4)?;
		Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
	}

	/// Returns the `(value, length)` of every key in the trie that is a prefix of `key`.
	///
	/// An index outside the array ends the search, where upstream would read out of bounds.
	pub fn common_prefix_search(&self, key: &[u8], out: &mut Vec<(u32, usize)>) {
		out.clear();
		let Some(root) = self.unit(0) else { return };
		let mut node_pos = offset(root);
		for (i, &byte) in key.iter().enumerate() {
			node_pos ^= byte as u32;
			let Some(unit) = self.unit(node_pos) else { return };
			if label(unit) != byte as u32 {
				return;
			}
			node_pos ^= offset(unit);
			if has_leaf(unit) {
				let Some(leaf) = self.unit(node_pos) else { return };
				out.push((value(leaf), i + 1));
			}
		}
	}
}
