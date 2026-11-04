// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A key-to-values table that returns each key's values in the order Planetiler's appendable multimap does.
//!
//! Planetiler's `SparseUnorderedBinarySearchMultimap` keeps every `(key, value)` pair, sorted by key with a key's
//! values in insertion order. Its `get` binary-searches the whole key array, collects values forward from the index
//! the search lands on, then backward from the index before it. A key with several values therefore comes back
//! rotated and partly reversed, and where the search lands depends on every other key in the table. Planetiler reads
//! a way's relation memberships and a relation's parent relations through this lookup, and the profile sees that
//! order: the basemap's road shields keep it for shields that sort equal.

/// A table of `(key, value)` pairs, sorted once by [`BinarySearchMultimap::from_pairs`].
#[derive(Debug, Default)]
pub struct BinarySearchMultimap<V> {
	keys: Vec<i64>,
	values: Vec<V>,
}

impl<V> BinarySearchMultimap<V> {
	/// Builds the table from pairs in insertion order, keeping every pair, duplicates included.
	pub fn from_pairs(mut pairs: Vec<(i64, V)>) -> Self {
		// A stable sort keeps a key's values in insertion order, as Planetiler's prepare step places them.
		pairs.sort_by_key(|(key, _)| *key);
		let (keys, values) = pairs.into_iter().unzip();
		BinarySearchMultimap { keys, values }
	}

	/// Returns `key`'s values in Planetiler's lookup order, or an empty list when the key is absent.
	pub fn get(&self, key: i64) -> Vec<&V> {
		let Some(index) = java_binary_search(&self.keys, key) else {
			return Vec::new();
		};
		let mut out = Vec::new();
		let mut i = index;
		while i < self.keys.len() && self.keys[i] == key {
			out.push(&self.values[i]);
			i += 1;
		}
		let mut i = index;
		while i > 0 && self.keys[i - 1] == key {
			i -= 1;
			out.push(&self.values[i]);
		}
		out
	}

	/// Returns the number of pairs.
	pub fn len(&self) -> usize {
		self.keys.len()
	}

	/// Returns whether the table holds no pairs.
	pub fn is_empty(&self) -> bool {
		self.keys.is_empty()
	}
}

/// `java.util.Arrays.binarySearch(long[], long)`: the index it returns for a key present in `keys`, with the same
/// midpoint sequence, so a run of equal keys is entered at the same position.
fn java_binary_search(keys: &[i64], key: i64) -> Option<usize> {
	let (mut low, mut high) = (0i64, keys.len() as i64 - 1);
	while low <= high {
		let mid = ((low + high) as u64 >> 1) as i64;
		let value = keys[mid as usize];
		if value < key {
			low = mid + 1;
		} else if value > key {
			high = mid - 1;
		} else {
			return Some(mid as usize);
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn values_come_forward_from_the_search_index_then_backward() {
		// Keys [1, 5, 5, 5, 9]: the search for 5 starts at index 2, the middle of the run.
		let table = BinarySearchMultimap::from_pairs(vec![(5, "a"), (1, "x"), (5, "b"), (9, "y"), (5, "c")]);
		assert_eq!(table.get(5), [&"b", &"c", &"a"]);
		assert_eq!(table.get(1), [&"x"]);
		assert!(table.get(4).is_empty());
	}

	#[test]
	fn the_landing_index_depends_on_the_other_keys() {
		// Keys [0, 5, 5, 5, 6, 7, 8, 9]: the first midpoint is index 3, the run's last entry, so the same three values
		// come back reversed.
		let table = BinarySearchMultimap::from_pairs(vec![
			(5, "a"),
			(0, "x"),
			(5, "b"),
			(6, "p"),
			(7, "q"),
			(8, "r"),
			(9, "y"),
			(5, "c"),
		]);
		assert_eq!(table.get(5), [&"c", &"b", &"a"]);
	}

	#[test]
	fn the_search_matches_java_for_every_length_and_key() {
		// Java's loop on keys 0, 10, 20, …: the probes are (low + high) >>> 1 until the key is found.
		for len in 1..40i64 {
			let keys: Vec<i64> = (0..len).map(|i| i * 10).collect();
			for target in 0..len {
				let (mut low, mut high) = (0i64, len - 1);
				let mut expected = None;
				while low <= high {
					let mid = (low + high) / 2;
					match keys[mid as usize].cmp(&(target * 10)) {
						std::cmp::Ordering::Less => low = mid + 1,
						std::cmp::Ordering::Greater => high = mid - 1,
						std::cmp::Ordering::Equal => {
							expected = Some(mid as usize);
							break;
						}
					}
				}
				assert_eq!(java_binary_search(&keys, target * 10), expected);
			}
		}
	}
}
