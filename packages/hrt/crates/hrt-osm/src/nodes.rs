// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The node location table: each node id with its packed location.

/// Node ids with their packed locations, sorted by id and searched by bisection.
///
/// The table costs 16 bytes a node. That size suits an extract, while a planet holds about ten billion nodes, so the
/// planet build needs a denser store; the lookup interface stays the same.
#[derive(Debug, Default)]
pub struct NodeStore {
	ids: Vec<i64>,
	locations: Vec<u64>,
}

impl NodeStore {
	/// Builds the table from chunks of `(id, location)` pairs, sorting them when the chunks arrive out of order.
	///
	/// A PBF file sorted by type then id, as the planet file and Geofabrik extracts are, yields chunks already in order, and the
	/// build then only concatenates them.
	pub fn from_chunks(chunks: Vec<Vec<(i64, u64)>>) -> Self {
		let total = chunks.iter().map(Vec::len).sum();
		let mut pairs: Vec<(i64, u64)> = Vec::with_capacity(total);
		for chunk in chunks {
			pairs.extend(chunk);
		}
		if !pairs.is_sorted_by_key(|pair| pair.0) {
			pairs.sort_unstable_by_key(|pair| pair.0);
		}
		let (ids, locations) = pairs.into_iter().unzip();
		NodeStore { ids, locations }
	}

	/// Returns the packed location of a node, or `None` when the file did not contain it.
	pub fn get(&self, id: i64) -> Option<u64> {
		self.ids.binary_search(&id).ok().map(|index| self.locations[index])
	}

	/// Returns the number of nodes in the table.
	pub fn len(&self) -> usize {
		self.ids.len()
	}

	/// Returns true when the table holds no nodes.
	pub fn is_empty(&self) -> bool {
		self.ids.is_empty()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn out_of_order_chunks_are_sorted_before_lookup() {
		let store = NodeStore::from_chunks(vec![vec![(30, 3), (40, 4)], vec![(10, 1), (20, 2)]]);
		assert_eq!(store.len(), 4);
		assert_eq!(store.get(10), Some(1));
		assert_eq!(store.get(40), Some(4));
		assert_eq!(store.get(25), None);
	}
}
