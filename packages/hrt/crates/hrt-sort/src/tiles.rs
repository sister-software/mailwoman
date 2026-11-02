// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's FeatureGroup.TileFeatures (Apache-2.0, Copyright Michael Barry).

//! Grouping sorted records into tiles and applying label-grid limits.
//!
//! Within a tile, a record whose key carries the group flag counts toward its label-grid square, and once a square
//! holds its limit of features the rest in that square are dropped. Records arrive in ascending sort key, so the
//! lowest-sort-key features in each square are the ones kept. The counts restart whenever a grouped record comes from a
//! different layer than the previous grouped record.

use std::collections::HashMap;
use std::io;

use crate::key::{has_group, layer_of, tile_of};
use crate::record::FeatureRecord;

/// One tile's records, after label-grid limits.
#[derive(Debug, Default)]
pub struct TileFeatures {
	pub tile_id: u64,
	pub entries: Vec<(u64, Vec<u8>)>,
	/// Records read for this tile, including those dropped by a label-grid limit.
	pub processed: u64,
}

struct Builder {
	tile: TileFeatures,
	counts: Option<HashMap<i64, i64>>,
	last_layer: u8,
}

impl Builder {
	fn new(tile_id: u64) -> Self {
		Builder {
			tile: TileFeatures {
				tile_id,
				..TileFeatures::default()
			},
			counts: None,
			last_layer: u8::MAX,
		}
	}

	fn add(&mut self, key: u64, value: Vec<u8>) -> io::Result<()> {
		self.tile.processed += 1;
		if has_group(key) {
			let layer = layer_of(key);
			match self.counts.as_mut() {
				None => {
					self.counts = Some(HashMap::new());
					self.last_layer = layer;
				}
				Some(counts) if layer != self.last_layer => {
					self.last_layer = layer;
					counts.clear();
				}
				Some(_) => {}
			}
			let group = FeatureRecord::peek_group(&value).map_err(|error| io::Error::other(error.0))?;
			let counts = self.counts.as_mut().unwrap();
			let old = counts.get(&group.id).copied().unwrap_or(0);
			if group.limit > 0 && old >= i64::from(group.limit) {
				return Ok(());
			}
			counts.insert(group.id, old + 1);
		}
		self.tile.entries.push((key, value));
		Ok(())
	}
}

/// Groups records sorted by key into tiles.
pub struct Tiles<I> {
	records: I,
	pending: Option<(u64, Vec<u8>)>,
}

impl<I: Iterator<Item = io::Result<(u64, Vec<u8>)>>> Tiles<I> {
	pub fn new(records: I) -> Self {
		Tiles { records, pending: None }
	}
}

impl<I: Iterator<Item = io::Result<(u64, Vec<u8>)>>> Iterator for Tiles<I> {
	type Item = io::Result<TileFeatures>;

	fn next(&mut self) -> Option<Self::Item> {
		let (key, value) = match self.pending.take() {
			Some(record) => record,
			None => match self.records.next()? {
				Ok(record) => record,
				Err(error) => return Some(Err(error)),
			},
		};
		let tile_id = tile_of(key);
		let mut builder = Builder::new(tile_id);
		if let Err(error) = builder.add(key, value) {
			return Some(Err(error));
		}
		for record in self.records.by_ref() {
			let (key, value) = match record {
				Ok(record) => record,
				Err(error) => return Some(Err(error)),
			};
			if tile_of(key) != tile_id {
				self.pending = Some((key, value));
				break;
			}
			if let Err(error) = builder.add(key, value) {
				return Some(Err(error));
			}
		}
		Some(Ok(builder.tile))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::key::encode_key;
	use hrt_render::{GeometryType, Group, VectorGeometry};

	fn point(id: i64, group: Option<Group>) -> Vec<u8> {
		let mut bytes = Vec::new();
		FeatureRecord {
			group,
			id,
			geometry: VectorGeometry {
				commands: vec![9, 0, 0],
				geom_type: GeometryType::Point,
				scale: 0,
			},
			attributes: Vec::new(),
		}
		.encode(&mut bytes);
		bytes
	}

	#[test]
	fn records_split_by_tile_and_label_grid_limits_keep_the_first_features() {
		let square = Some(Group { id: 9, limit: 2 });
		let records = vec![
			(encode_key(1, 0, 0, true), point(1, square)),
			(encode_key(1, 0, 1, true), point(2, square)),
			(encode_key(1, 0, 2, true), point(3, square)),
			(encode_key(1, 1, 0, true), point(4, square)),
			(encode_key(2, 0, 0, false), point(5, None)),
		];
		let tiles: Vec<TileFeatures> = Tiles::new(records.into_iter().map(Ok)).map(Result::unwrap).collect();
		assert_eq!(tiles.len(), 2);
		assert_eq!(tiles[0].tile_id, 1);
		assert_eq!(tiles[0].processed, 4);
		assert_eq!(
			tiles[0].entries.len(),
			3,
			"the third feature in the square is over the limit of two"
		);
		assert_eq!(tiles[1].entries.len(), 1);
	}
}
