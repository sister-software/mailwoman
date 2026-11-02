// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's OsmMultipolygon (Apache-2.0, Copyright Michael Barry), which ports imposm3's
// multipolygon.go and ring.go (Apache-2.0, Copyright Omniscale).

//! Multipolygon assembly from the ways of an OpenStreetMap relation.
//!
//! The member roles `inner` and `outer` are often wrong, so the builder ignores them. It joins ways with matching end
//! nodes into closed rings, sorts the rings by area with the largest first, and finds each ring's smallest enclosing
//! ring. A ring nested an even number of levels deep is a shell, and one nested an odd number of levels deep is a hole
//! in its parent. Every step keeps Planetiler's iteration order, so the same members produce the same polygons in the
//! same order.

use std::collections::HashMap;
use std::f64::consts::PI;

use geo::{Area, Coord, LineString, MultiPolygon, Polygon, PreparedGeometry, Relate};

use crate::coords::decode_world;
use crate::nodes::NodeStore;

/// The largest gap, in world units, that the builder closes between a ring's first and last node: 0.1 meters at the
/// equator.
pub const MIN_CLOSE_RING_GAP: f64 = 0.1 / (PI * 2.0 * 6_378_137.0);

/// The reason a multipolygon could not be assembled, using Planetiler's error-statistic names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MultipolygonError {
	/// The relation had no way members with stored geometry: `osm_invalid_multipolygon_empty`.
	Empty,
	/// The members formed no closed ring: `osm_invalid_multipolygon_empty_after_fix`.
	NoClosedRings,
	/// A member way referred to a node absent from the file: `osm_invalid_multipolygon`.
	MissingNode(i64),
}

/// Joins way node lists that share end nodes, returning every ring that closes or still has four or more nodes.
///
/// A way of one node is skipped, and an already-closed way of fewer than four nodes is dropped. Joined chains are
/// reversed as needed to line up their ends. The remaining open chains are scanned in ascending order of the end-node
/// id that indexes them.
pub fn connect_polygon_segments<W: AsRef<[i64]>>(ways: &[W]) -> Vec<Vec<i64>> {
	// Chains live in an arena. The endpoint index maps an end node to its chain, and a chain's two ends can point at
	// the same arena slot, as the Java code stores one list object under both keys.
	let mut arena: Vec<Vec<i64>> = Vec::with_capacity(ways.len());
	let mut endpoint_index: HashMap<i64, usize> = HashMap::with_capacity(ways.len() * 2);
	let mut complete = Vec::with_capacity(ways.len());

	for ids in ways {
		let ids = ids.as_ref();
		if ids.len() <= 1 {
			continue;
		}
		let first = ids[0];
		let last = ids[ids.len() - 1];
		if first == last {
			if ids.len() >= 4 {
				complete.push(ids.to_vec());
			}
			continue;
		}

		if let Some(matched) = endpoint_index.remove(&first) {
			if arena[matched][0] == first {
				arena[matched].reverse();
			}
			append_skip_first(&mut arena[matched], ids);
			match endpoint_index.get(&last).copied() {
				Some(next) if next != matched => {
					endpoint_index.remove(&last);
					let next_chain = &arena[next];
					let tail: Vec<i64> = if next_chain[0] == last {
						next_chain.clone()
					} else {
						next_chain.iter().rev().copied().collect()
					};
					append_skip_first(&mut arena[matched], &tail);
					let new_last = *arena[matched].last().unwrap();
					endpoint_index.insert(new_last, matched);
				}
				_ => {
					endpoint_index.insert(last, matched);
				}
			}
		} else if let Some(matched) = endpoint_index.remove(&last) {
			if arena[matched][0] == last {
				let mut joined = ids[..ids.len() - 1].to_vec();
				joined.extend_from_slice(&arena[matched]);
				arena[matched] = joined;
			} else {
				let reversed: Vec<i64> = ids.iter().rev().copied().collect();
				append_skip_first(&mut arena[matched], &reversed);
			}
			endpoint_index.insert(first, matched);
		} else {
			arena.push(ids.to_vec());
			let slot = arena.len() - 1;
			endpoint_index.insert(first, slot);
			endpoint_index.insert(last, slot);
		}
	}

	let mut keys: Vec<i64> = endpoint_index.keys().copied().collect();
	keys.sort_unstable();
	for key in keys {
		let chain = &arena[endpoint_index[&key]];
		if chain.len() >= 4 && (chain[0] == chain[chain.len() - 1] || key == chain[0]) {
			complete.push(chain.clone());
		}
	}
	complete
}

fn append_skip_first(chain: &mut Vec<i64>, tail: &[i64]) {
	chain.extend_from_slice(&tail[1..]);
}

struct Ring {
	polygon: Polygon,
	area: f64,
	contained_by: Option<usize>,
	/// The insertion ordinal of this ring in its parent's holes, standing in for Java's per-ring `LinkedHashSet`.
	hole_ordinal: Option<u64>,
	/// The insertion ordinal of this ring in the shell set.
	shell_ordinal: Option<u64>,
}

fn coordinates(segment: &[i64], nodes: &NodeStore) -> Result<Vec<Coord>, MultipolygonError> {
	segment
		.iter()
		.map(|&id| {
			let [x, y] = decode_world(nodes.get(id).ok_or(MultipolygonError::MissingNode(id))?);
			Ok(Coord { x, y })
		})
		.collect()
}

/// Builds the multipolygon for a relation from its member ways' node lists, in world coordinates.
///
/// A single shell yields a one-polygon `MultiPolygon`, which Planetiler returns as a plain `Polygon`.
pub fn build<W: AsRef<[i64]>>(ways: &[W], nodes: &NodeStore) -> Result<MultiPolygon, MultipolygonError> {
	if ways.is_empty() {
		return Err(MultipolygonError::Empty);
	}
	let segments = connect_polygon_segments(ways);

	let mut rings = Vec::with_capacity(segments.len());
	for mut segment in segments {
		let first = segment[0];
		let last = segment[segment.len() - 1];
		let closed = first == last || {
			let [ax, ay] = decode_world(nodes.get(first).ok_or(MultipolygonError::MissingNode(first))?);
			let [bx, by] = decode_world(nodes.get(last).ok_or(MultipolygonError::MissingNode(last))?);
			let close = ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt() <= MIN_CLOSE_RING_GAP;
			if close {
				*segment.last_mut().unwrap() = first;
			}
			close
		};
		if closed {
			let polygon = Polygon::new(LineString::from(coordinates(&segment, nodes)?), vec![]);
			let area = polygon.unsigned_area();
			rings.push(Ring {
				polygon,
				area,
				contained_by: None,
				hole_ordinal: None,
				shell_ordinal: None,
			});
		}
	}
	if rings.is_empty() {
		return Err(MultipolygonError::NoClosedRings);
	}

	// Java's List.sort is stable, so equal areas keep their segment order.
	rings.sort_by(|a, b| b.area.total_cmp(&a.area));
	group_parent_child_shells(&mut rings);

	let mut shells: Vec<usize> = (0..rings.len())
		.filter(|&index| rings[index].shell_ordinal.is_some())
		.collect();
	shells.sort_by_key(|&index| rings[index].shell_ordinal);

	let mut holes_by_parent: HashMap<usize, Vec<usize>> = HashMap::new();
	for (index, ring) in rings.iter().enumerate() {
		if let (Some(parent), Some(_)) = (ring.contained_by, ring.hole_ordinal) {
			holes_by_parent.entry(parent).or_default().push(index);
		}
	}

	let polygons = shells
		.iter()
		.map(|&shell| {
			let mut holes = holes_by_parent.remove(&shell).unwrap_or_default();
			holes.sort_by_key(|&index| rings[index].hole_ordinal);
			Polygon::new(
				rings[shell].polygon.exterior().clone(),
				holes
					.iter()
					.map(|&hole| rings[hole].polygon.exterior().clone())
					.collect(),
			)
		})
		.collect();
	Ok(MultiPolygon(polygons))
}

fn is_hole(rings: &[Ring], index: usize) -> bool {
	let mut depth = 0;
	let mut ring = Some(index);
	while let Some(current) = ring {
		depth += 1;
		ring = rings[current].contained_by;
	}
	depth % 2 == 0
}

fn group_parent_child_shells(rings: &mut [Ring]) {
	let mut ordinal = 0u64;
	let mut next = || {
		ordinal += 1;
		ordinal
	};
	let count = rings.len();
	rings[0].shell_ordinal = Some(next());
	if count == 1 {
		return;
	}

	for outer in 0..count {
		if outer < count - 1 {
			let prepared = PreparedGeometry::from(rings[outer].polygon.clone());
			for inner in outer + 1..count {
				if !prepared.relate(&rings[inner].polygon).is_contains() {
					continue;
				}
				// The last ring found to contain this one is the smallest, so it replaces any earlier parent.
				if rings[inner].contained_by.is_some() {
					rings[inner].hole_ordinal = None;
					rings[inner].shell_ordinal = None;
				}
				rings[inner].contained_by = Some(outer);
				if is_hole(rings, inner) {
					rings[inner].hole_ordinal = Some(next());
				} else if rings[inner].shell_ordinal.is_none() {
					rings[inner].shell_ordinal = Some(next());
				}
			}
		}
		if rings[outer].contained_by.is_none() && rings[outer].shell_ordinal.is_none() {
			rings[outer].shell_ordinal = Some(next());
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::coords::encode_flat_location;

	#[test]
	fn ways_join_end_to_end_and_reverse_to_match() {
		let rings = connect_polygon_segments(&[vec![1, 2, 3], vec![5, 4, 3], vec![5, 6, 1]]);
		assert_eq!(rings.len(), 1);
		let ring = &rings[0];
		assert_eq!(ring.first(), ring.last());
		assert_eq!(ring.len(), 7);
	}

	#[test]
	fn short_closed_ways_and_single_nodes_are_dropped() {
		assert!(connect_polygon_segments(&[vec![1, 2, 1], vec![9]]).is_empty());
	}

	fn grid_store(points: &[(i64, f64, f64)]) -> NodeStore {
		NodeStore::from_chunks(vec![points
			.iter()
			.map(|&(id, lon, lat)| (id, encode_flat_location(lon, lat)))
			.collect()])
	}

	#[test]
	fn nesting_depth_decides_shells_and_holes() {
		// Three nested squares: the outer and innermost are shells, and the middle one is a hole in the outer.
		let nodes = grid_store(&[
			(1, 0.0, 0.0),
			(2, 3.0, 0.0),
			(3, 3.0, 3.0),
			(4, 0.0, 3.0),
			(11, 0.5, 0.5),
			(12, 2.5, 0.5),
			(13, 2.5, 2.5),
			(14, 0.5, 2.5),
			(21, 1.0, 1.0),
			(22, 2.0, 1.0),
			(23, 2.0, 2.0),
			(24, 1.0, 2.0),
		]);
		// The roles are deliberately unordered: the innermost ring comes first.
		let ways = vec![vec![21, 22, 23, 24, 21], vec![1, 2, 3, 4, 1], vec![11, 12, 13, 14, 11]];
		let multipolygon = build(&ways, &nodes).unwrap();
		assert_eq!(multipolygon.0.len(), 2);
		assert_eq!(multipolygon.0[0].interiors().len(), 1);
		assert_eq!(multipolygon.0[1].interiors().len(), 0);
		assert!(multipolygon.0[0].unsigned_area() > multipolygon.0[1].unsigned_area());
	}

	#[test]
	fn a_missing_node_fails_the_relation() {
		let nodes = grid_store(&[(1, 0.0, 0.0), (2, 1.0, 0.0), (3, 1.0, 1.0)]);
		assert_eq!(
			build(&[vec![1, 2, 3, 4, 1]], &nodes),
			Err(MultipolygonError::MissingNode(4))
		);
	}

	#[test]
	fn a_gap_under_ten_centimeters_closes() {
		let nudge = 1e-8;
		let nodes = grid_store(&[(1, 0.0, 0.0), (2, 1.0, 0.0), (3, 1.0, 1.0), (4, nudge, nudge)]);
		let multipolygon = build(&[vec![1, 2, 3, 4]], &nodes).unwrap();
		assert_eq!(multipolygon.0.len(), 1);
	}
}
