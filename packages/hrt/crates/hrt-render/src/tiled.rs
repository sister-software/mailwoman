// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Planetiler 0.10.2's TiledGeometry (Apache-2.0, Copyright Michael Barry), which adapts the stripe
// clipping in geojson-vt (ISC, Copyright (c) 2015, Mapbox).

//! Slicing a geometry into the tiles it touches at one zoom, in two passes of stripe clipping.
//!
//! The first pass clips each line or ring into vertical columns one tile wide, plus the buffer on each side. The
//! second pass clips each column into rows. A polygon edge that runs straight down a column's left or right buffer edge marks
//! the rows it passes as candidates for being completely inside the polygon; rows reached from both sides become filled
//! tiles, which the renderer emits as a single square instead of clipped geometry.
//!
//! Coordinates come in tile units at this zoom, from (0, 0) at the north-west corner to (2^z, 2^z) at the south-east
//! corner, and leave in pixels of the tile they land on, 256 to a tile width.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::geom::{Seq, Xy};
use crate::range_set::RangeSet;

const NEIGHBOR_BUFFER_EPS: f64 = 0.1 / 4096.0;

/// The tile rows and columns a build covers at one zoom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileExtents {
	pub min_x: i32,
	pub max_x: i32,
	pub min_y: i32,
	pub max_y: i32,
}

impl TileExtents {
	/// Returns the extents of the whole world at zoom `z`.
	pub fn world(z: u8) -> Self {
		let tiles = 1i32 << z;
		TileExtents {
			min_x: 0,
			max_x: tiles,
			min_y: 0,
			max_y: tiles,
		}
	}

	/// Returns the tiles at zoom `z` that a `[min x, min y, max x, max y]` box in world coordinates touches, as
	/// Planetiler's `TileExtents.computeFromWorldBounds` quantizes it.
	pub fn from_world_bounds(z: u8, [min_x, min_y, max_x, max_y]: [f64; 4]) -> Self {
		let levels = 1i32 << z;
		let down = |value: f64| ((value * f64::from(levels)).floor() as i32).clamp(0, levels);
		let up = |value: f64| ((value * f64::from(levels)).ceil() as i32).clamp(0, levels);
		TileExtents {
			min_x: down(min_x),
			max_x: up(max_x),
			min_y: down(min_y),
			max_y: up(max_y),
		}
	}

	pub fn test_x(&self, x: i32) -> bool {
		x >= self.min_x && x < self.max_x
	}

	pub fn test(&self, x: i32, y: i32) -> bool {
		self.test_x(x) && y >= self.min_y && y < self.max_y
	}
}

/// A polygon a hole could not be placed in, because the hole reached a tile its shell neither crossed nor filled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadPolygonFill {
	pub x: i32,
	pub y: i32,
}

/// The tiles a geometry touches at one zoom, with the clipped coordinate groups on each.
#[derive(Debug, Default)]
pub struct Tiled {
	pub z: u8,
	/// Each touched tile's groups: a polygon's rings, or a line's pieces, in pixel coordinates of that tile.
	pub tiles: BTreeMap<(i32, i32), Vec<Vec<Seq>>>,
	filled: BTreeMap<i32, RangeSet>,
	extents: Option<TileExtents>,
}

impl Tiled {
	/// Returns whether the geometry touches or fills tile (`x`, `y`), as Planetiler's `getCoveredTiles` admits it.
	pub fn covers(&self, x: i32, y: i32) -> bool {
		self.tiles.contains_key(&(x, y)) || self.filled.get(&x).is_some_and(|rows| rows.contains(y))
	}

	/// Returns the tiles that lie wholly inside the polygon and carry no clipped geometry, by x then y.
	pub fn filled_tiles(&self) -> Vec<(i32, i32)> {
		let Some(extents) = self.extents else {
			return Vec::new();
		};
		let mut out = Vec::new();
		for (&x, rows) in &self.filled {
			for y in rows.iter() {
				if extents.test(x, y) && !self.tiles.contains_key(&(x, y)) {
					out.push((x, y));
				}
			}
		}
		out
	}
}

/// A coordinate sequence that ignores a point equal to the previous one, optionally storing points relative to an
/// origin and scaled to pixels.
#[derive(Clone, Debug, Default)]
struct Mutable {
	points: Seq,
	scale: f64,
	rel_y: f64,
	scaling: bool,
}

impl Mutable {
	fn plain() -> Self {
		Mutable {
			scale: 1.0,
			..Mutable::default()
		}
	}

	fn scaling(rel_y: f64, scale: f64) -> Self {
		Mutable {
			points: Vec::new(),
			scale,
			rel_y,
			scaling: true,
		}
	}

	fn add(&mut self, x: f64, y: f64) {
		let (x, y) = if self.scaling {
			(self.scale * x, self.scale * (y - self.rel_y))
		} else {
			(x, y)
		};
		if self.points.last() != Some(&[x, y]) {
			self.points.push([x, y]);
		}
	}

	fn close_ring(&mut self) {
		if let (Some(&first), Some(&last)) = (self.points.first(), self.points.last()) {
			if first != last {
				self.points.push(first);
			}
		}
	}
}

/// Where an in-progress tile shape's sequence lives: the shared fill square or a y-slice still being written.
#[derive(Clone, Copy, Debug)]
enum Part {
	Fill,
	Slice(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
	Left,
	Right,
}

struct Skipped {
	side: Side,
	lo: i32,
	hi: i32,
	ascending: bool,
}

struct Slicer {
	extents: TileExtents,
	buffer: f64,
	neighbor_buffer: f64,
	area: bool,
	max_tiles: i32,
	result: Tiled,
}

fn wrap(value: i32, max: i32) -> i32 {
	value.rem_euclid(max)
}

fn fill(buffer: f64) -> Seq {
	let min = -256.0 * buffer;
	let max = 256.0 - min;
	vec![[min, min], [max, min], [max, max], [min, max], [min, min]]
}

fn intersect_x(out: &mut Mutable, ax: f64, ay: f64, bx: f64, by: f64, x: f64) {
	let t = (x - ax) / (bx - ax);
	out.add(x, ay + (by - ay) * t);
}

fn intersect_y(out: &mut Mutable, ax: f64, ay: f64, bx: f64, by: f64, y: f64) {
	let t = (y - ay) / (by - ay);
	out.add(ax + (bx - ax) * t, y);
}

/// Returns the tiles holding each point at zoom `z`, with `buffer` tile widths of overlap.
pub fn slice_points(extents: TileExtents, buffer: f64, z: u8, points: &[Xy]) -> Tiled {
	let neighbor_buffer = buffer + NEIGHBOR_BUFFER_EPS;
	let max_tiles = 1i32 << z;
	let mut result = Tiled { z, ..Tiled::default() };
	for &[world_x, world_y] in points {
		let min_x = (world_x - neighbor_buffer).floor() as i32;
		let max_x = (world_x + neighbor_buffer).floor() as i32;
		let min_y = extents.min_y.max((world_y - neighbor_buffer).floor() as i32);
		let max_y = (extents.max_y - 1).min((world_y + neighbor_buffer).floor() as i32);
		for x in min_x..=max_x {
			let tile_x = world_x - f64::from(x);
			let wrapped = wrap(x, max_tiles);
			if !extents.test_x(wrapped) {
				continue;
			}
			for y in min_y..=max_y {
				if extents.test(wrapped, y) {
					let tile_y = world_y - f64::from(y);
					let groups = result.tiles.entry((wrapped, y)).or_insert_with(|| vec![Vec::new()]);
					groups[0].push(vec![[tile_x * 256.0, tile_y * 256.0]]);
				}
			}
		}
	}
	result
}

/// Slices line or polygon groups, from `GeometryCoordinateSequences::extract_groups`, into the tiles they touch.
///
/// Content that wraps past the antimeridian is sliced again, shifted by one world width.
pub fn slice_into_tiles(
	groups: &[Vec<Seq>],
	buffer: f64,
	area: bool,
	z: u8,
	extents: TileExtents,
) -> Result<Tiled, BadPolygonFill> {
	let mut slicer = Slicer {
		extents,
		buffer,
		neighbor_buffer: buffer + NEIGHBOR_BUFFER_EPS,
		area,
		max_tiles: 1 << z,
		result: Tiled {
			z,
			extents: Some(extents),
			..Tiled::default()
		},
	};
	let (left, right) = slicer.slice_world_copy(groups, 0)?;
	if right {
		slicer.slice_world_copy(groups, -slicer.max_tiles)?;
	}
	if left {
		slicer.slice_world_copy(groups, slicer.max_tiles)?;
	}
	Ok(slicer.result)
}

impl Slicer {
	/// Slices one copy of the world and reports whether content extended past its west and east edges.
	fn slice_world_copy(&mut self, groups: &[Vec<Seq>], x_offset: i32) -> Result<(bool, bool), BadPolygonFill> {
		let mut overflow_left = false;
		let mut overflow_right = false;
		for group in groups {
			let mut arena: Vec<Mutable> = Vec::new();
			let mut in_progress: HashMap<(i32, i32), Vec<Part>> = HashMap::new();
			for (index, segment) in group.iter().enumerate() {
				let outer = index == 0;
				let columns = self.slice_x(segment);
				for (column, stripes) in columns {
					let x = column + x_offset;
					if x >= self.max_tiles {
						overflow_right = true;
					} else if x < 0 {
						overflow_left = true;
					} else {
						for stripe in &stripes {
							let filled = self.slice_y(&stripe.points, x, outer, &mut in_progress, &mut arena)?;
							if self.area {
								if let Some(filled) = filled {
									if outer {
										self.add_filled(x, filled);
									} else {
										self.remove_filled(x, &filled);
									}
								}
							}
						}
					}
				}
			}
			self.add_shapes(in_progress, &arena);
		}
		Ok((overflow_left, overflow_right))
	}

	fn add_shapes(&mut self, in_progress: HashMap<(i32, i32), Vec<Part>>, arena: &[Mutable]) {
		let fill_seq = fill(self.buffer);
		let min_points = if self.area { 4 } else { 2 };
		for (tile, parts) in in_progress {
			let sequences: Vec<&Seq> = parts
				.iter()
				.map(|part| match part {
					Part::Fill => &fill_seq,
					Part::Slice(index) => &arena[*index].points,
				})
				.collect();
			if self.area && sequences[0].len() < 4 {
				continue;
			}
			let kept: Vec<Seq> = sequences
				.into_iter()
				.filter(|seq| seq.len() >= min_points)
				.cloned()
				.collect();
			if !kept.is_empty() && self.extents.test(tile.0, tile.1) {
				self.result.tiles.entry(tile).or_default().push(kept);
			}
		}
	}

	/// Clips a segment into the columns it crosses, keyed by column x, each with its pieces in order.
	fn slice_x(&self, segment: &Seq) -> BTreeMap<i32, Vec<Mutable>> {
		let left_limit = -self.buffer;
		let right_limit = 1.0 + self.buffer;
		let mut pieces: Vec<Mutable> = Vec::new();
		let mut by_column: BTreeMap<i32, Vec<usize>> = BTreeMap::new();
		let mut open: HashMap<i32, usize> = HashMap::new();

		for pair in segment.windows(2) {
			let [ax, ay] = pair[0];
			let [bx, by] = pair[1];
			let start_x = (ax.min(bx) - self.neighbor_buffer).floor() as i32;
			let end_x = (ax.max(bx) + self.neighbor_buffer).floor() as i32;
			for x in start_x..=end_x {
				let ax_tile = ax - f64::from(x);
				let bx_tile = bx - f64::from(x);
				let slot = *open.entry(x).or_insert_with(|| {
					pieces.push(Mutable::plain());
					let slot = pieces.len() - 1;
					by_column.entry(x).or_default().push(slot);
					slot
				});
				let slice = &mut pieces[slot];
				let mut exited = false;
				if ax_tile < left_limit {
					if bx_tile > left_limit {
						intersect_x(slice, ax_tile, ay, bx_tile, by, left_limit);
					}
				} else if ax_tile > right_limit {
					if bx_tile < right_limit {
						intersect_x(slice, ax_tile, ay, bx_tile, by, right_limit);
					}
				} else {
					slice.add(ax_tile, ay);
				}
				if bx_tile < left_limit && ax_tile >= left_limit {
					intersect_x(slice, ax_tile, ay, bx_tile, by, left_limit);
					exited = true;
				}
				if bx_tile > right_limit && ax_tile <= right_limit {
					intersect_x(slice, ax_tile, ay, bx_tile, by, right_limit);
					exited = true;
				}
				if !self.area && exited {
					open.remove(&x);
				}
			}
		}

		if let Some(&[ax, ay]) = segment.last() {
			let start_x = (ax - self.neighbor_buffer).floor() as i32;
			let end_x = (ax + self.neighbor_buffer).floor() as i32;
			for x in start_x - 1..=end_x + 1 {
				let ax_tile = ax - f64::from(x);
				if let Some(&slot) = open.get(&x) {
					if ax_tile >= left_limit && ax_tile <= right_limit {
						pieces[slot].add(ax_tile, ay);
					}
				}
			}
		}
		if self.area {
			for &slot in open.values() {
				pieces[slot].close_ring();
			}
		}

		let mut out = BTreeMap::new();
		for (x, slots) in by_column {
			if self.extents.test_x(wrap(x, self.max_tiles)) {
				out.insert(
					x,
					slots
						.into_iter()
						.map(|slot| std::mem::take(&mut pieces[slot]))
						.collect(),
				);
			}
		}
		out
	}

	fn is_filled(&self, x: i32, y: i32) -> bool {
		self.result.filled.get(&x).is_some_and(|rows| rows.contains(y))
	}

	fn add_filled(&mut self, x: i32, rows: RangeSet) {
		if rows.is_empty() {
			return;
		}
		match self.result.filled.get_mut(&x) {
			Some(existing) => existing.add_all(&rows),
			None => {
				self.result.filled.insert(x, rows);
			}
		}
	}

	fn remove_filled(&mut self, x: i32, rows: &RangeSet) {
		if let Some(existing) = self.result.filled.get_mut(&x) {
			existing.remove_all(rows);
		}
	}

	/// Clips one column piece into the rows it crosses, recording each row's slice in `in_progress`, and returns the
	/// rows this piece showed to be filled when the geometry is a polygon.
	fn slice_y(
		&self,
		stripe: &Seq,
		x: i32,
		outer: bool,
		in_progress: &mut HashMap<(i32, i32), Vec<Part>>,
		arena: &mut Vec<Mutable>,
	) -> Result<Option<RangeSet>, BadPolygonFill> {
		if stripe.is_empty() || x < 0 || x >= self.max_tiles {
			return Ok(None);
		}
		let left_edge = -self.buffer;
		let right_edge = 1.0 + self.buffer;
		let mut with_detail: Option<BTreeSet<i32>> = None;
		let mut right_filled: Option<RangeSet> = None;
		let mut left_filled: Option<RangeSet> = None;
		let mut y_slices: HashMap<i32, usize> = HashMap::new();
		let mut skipped: Vec<Skipped> = Vec::new();

		for pair in stripe.windows(2) {
			let [ax, ay] = pair[0];
			let [bx, by] = pair[1];
			let min_y = ay.min(by);
			let max_y = ay.max(by);
			let start_y = self.extents.min_y.max((min_y - self.neighbor_buffer).floor() as i32);
			let end_start_y = self.extents.min_y.max((min_y + self.neighbor_buffer).floor() as i32);
			let start_end_y = (self.extents.max_y - 1).min((max_y - self.neighbor_buffer).floor() as i32);
			let end_y = (self.extents.max_y - 1).min((max_y + self.neighbor_buffer).floor() as i32);
			let on_right_edge = self.area && ax == bx && ax == right_edge;
			let on_left_edge = self.area && ax == bx && ax == left_edge;

			let mut y = start_y;
			while y <= end_y {
				if self.area && y > end_start_y && y < start_end_y && (on_right_edge || on_left_edge) {
					let detail = with_detail.get_or_insert_with(|| y_slices.keys().copied().collect());
					let next = detail.range(y..).next().copied();
					let next_non_edge = next.map_or(start_end_y, |next| next.min(start_end_y));
					let end_skip = next_non_edge - 1;
					if end_skip >= y {
						skipped.push(Skipped {
							side: if on_left_edge { Side::Left } else { Side::Right },
							lo: y,
							hi: end_skip,
							ascending: by > ay,
						});
						// A tile is inside the polygon when an odd number of vertical edges lie on each side of it, so each
						// side's rows are toggled and the two sides are intersected at the end.
						if right_filled.is_none() {
							right_filled = Some(RangeSet::new());
							left_filled = Some(RangeSet::new());
						}
						let side = if on_right_edge {
							&mut right_filled
						} else {
							&mut left_filled
						};
						side.as_mut().unwrap().xor_range(y, end_skip);
						y = next_non_edge;
					}
				}

				let top = f64::from(y) - self.buffer;
				let bottom = f64::from(y) + 1.0 + self.buffer;
				let slot = match y_slices.get(&y) {
					Some(&slot) => slot,
					None => {
						if let Some(detail) = with_detail.as_mut() {
							detail.insert(y);
						}
						arena.push(Mutable::scaling(f64::from(y), 256.0));
						let slot = arena.len() - 1;
						y_slices.insert(y, slot);
						let parts = in_progress.entry((x, y)).or_default();
						if self.area && !outer && parts.is_empty() {
							// Shells are sliced before holes, so a hole that is the first thing on a tile must sit in a
							// tile its shell filled. Anything else means the polygon is invalid.
							if !self.is_filled(x, y) {
								return Err(BadPolygonFill { x, y });
							}
							parts.push(Part::Fill);
						}
						parts.push(Part::Slice(slot));

						if self.area {
							if let (Some(left), Some(right)) = (&left_filled, &right_filled) {
								if left.contains(y) || right.contains(y) {
									for skip in &skipped {
										if skip.lo <= y && skip.hi >= y {
											let (start, end) =
												if skip.ascending { (top, bottom) } else { (bottom, top) };
											let edge_x = if skip.side == Side::Left {
												-self.buffer
											} else {
												1.0 + self.buffer
											};
											arena[slot].add(edge_x, start);
											arena[slot].add(edge_x, end);
										}
									}
								}
							}
						}
						slot
					}
				};

				let slice = &mut arena[slot];
				let mut exited = false;
				if ay < top {
					if by > top {
						intersect_y(slice, ax, ay, bx, by, top);
					}
				} else if ay > bottom {
					if by < bottom {
						intersect_y(slice, ax, ay, bx, by, bottom);
					}
				} else {
					slice.add(ax, ay);
				}
				if by < top && ay >= top {
					intersect_y(slice, ax, ay, bx, by, top);
					exited = true;
				}
				if by > bottom && ay <= bottom {
					intersect_y(slice, ax, ay, bx, by, bottom);
					exited = true;
				}
				if !self.area && exited {
					y_slices.remove(&y);
				}
				y += 1;
			}
		}

		let [ax, ay] = stripe[stripe.len() - 1];
		let start_y = (ay - self.neighbor_buffer).floor() as i32;
		let end_y = (ay + self.neighbor_buffer).floor() as i32;
		for y in start_y - 1..=end_y + 1 {
			let k1 = f64::from(y) - self.buffer;
			let k2 = f64::from(y) + 1.0 + self.buffer;
			if let Some(&slot) = y_slices.get(&y) {
				if ay >= k1 && ay <= k2 {
					arena[slot].add(ax, ay);
				}
			}
		}
		if self.area {
			for &slot in y_slices.values() {
				arena[slot].close_ring();
			}
		}
		Ok(right_filled.map(|right| right.intersect(left_filled.as_ref().expect("both fill sides start together"))))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_point_near_a_corner_lands_on_every_tile_within_the_buffer() {
		let tiled = slice_points(TileExtents::world(2), 4.0 / 256.0, 2, &[[1.0 + 1e-4, 1.0 + 1e-4]]);
		assert_eq!(tiled.tiles.len(), 4);
		let offset = (1.0 + 1e-4 - 1.0) * 256.0;
		assert_eq!(tiled.tiles[&(1, 1)][0][0], vec![[offset, offset]]);
	}

	#[test]
	fn a_polygon_covering_many_tiles_fills_the_interior_ones() {
		// A square from tile 1 to tile 7 at zoom 3, rings oriented as extract_groups leaves them.
		let ring = vec![[1.5, 1.5], [6.5, 1.5], [6.5, 6.5], [1.5, 6.5], [1.5, 1.5]];
		let tiled = slice_into_tiles(&[vec![ring]], 4.0 / 256.0, true, 3, TileExtents::world(3)).unwrap();
		let filled = tiled.filled_tiles();
		assert_eq!(filled.len(), 16, "tiles 2..=5 in each direction are inside");
		assert!(filled.contains(&(3, 4)));
		assert_eq!(
			tiled.tiles.len(),
			20,
			"the ring crosses the 20 tiles around the filled block"
		);
	}

	#[test]
	fn a_line_is_clipped_into_each_tile_it_crosses() {
		let line = vec![[0.5, 0.5], [2.5, 0.5]];
		let tiled = slice_into_tiles(&[vec![line]], 0.0, false, 2, TileExtents::world(2)).unwrap();
		let keys: Vec<_> = tiled.tiles.keys().copied().collect();
		assert_eq!(keys, vec![(0, 0), (1, 0), (2, 0)]);
		assert_eq!(tiled.tiles[&(1, 0)][0][0], vec![[0.0, 128.0], [256.0, 128.0]]);
	}
}
