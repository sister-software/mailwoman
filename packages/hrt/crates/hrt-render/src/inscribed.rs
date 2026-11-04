// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from JTS 1.20.0's MaximumInscribedCircle, Distance.pointToSegment and RayCrossingCounter (EPL-2.0 or
// EDL-1.0, Copyright Martin Davis and the JTS contributors).

//! The center of a polygon's maximum inscribed circle, found as JTS 1.20's `MaximumInscribedCircle.getCenter` finds it.
//!
//! The search splits square cells in the order of a priority queue, keyed by the largest distance from the boundary any
//! point in a cell could have. Its answer is the first cell whose distance no later cell beats by more than the
//! tolerance, so the result depends on the exact distance of every cell and on the order the queue returns cells
//! with equal keys. GEOS's port differs from JTS in both: it measures distances with `sqrt(dx*dx + dy*dy)` where JTS
//! uses `Math.hypot`, its queue is a `std::priority_queue`, and it solves triangles and convex quadrilaterals exactly.
//! This module measures with Java's `hypot` and orders cells with the binary heap of `java.util.PriorityQueue`.

use std::cmp::Ordering;

use rstar::{PointDistance, RTree, RTreeObject, AABB};

use crate::geom::{Polygon, Xy};
use crate::java_math::hypot;

/// One boundary segment, from `a` to `b` in ring order.
struct Segment {
	a: Xy,
	b: Xy,
}

impl RTreeObject for Segment {
	type Envelope = AABB<Xy>;

	fn envelope(&self) -> Self::Envelope {
		AABB::from_corners(self.a, self.b)
	}
}

impl PointDistance for Segment {
	fn distance_2(&self, point: &Xy) -> f64 {
		let distance = point_to_segment(*point, self.a, self.b);
		distance * distance
	}
}

/// `Coordinate.distance`.
fn distance(p: Xy, q: Xy) -> f64 {
	hypot(p[0] - q[0], p[1] - q[1])
}

/// `Distance.pointToSegment`.
fn point_to_segment(p: Xy, a: Xy, b: Xy) -> f64 {
	if a[0] == b[0] && a[1] == b[1] {
		return distance(p, a);
	}
	let len2 = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
	let r = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
	if r <= 0.0 {
		return distance(p, a);
	}
	if r >= 1.0 {
		return distance(p, b);
	}
	let s = ((a[1] - p[1]) * (b[0] - a[0]) - (a[0] - p[0]) * (b[1] - a[1])) / len2;
	s.abs() * len2.sqrt()
}

/// `Orientation.index`: 1 when `q` lies left of the vector from `p1` to `p2`, -1 when right, 0 when on its line.
fn orientation(p1: Xy, p2: Xy, q: Xy) -> i32 {
	let det = robust::orient2d(
		robust::Coord { x: p1[0], y: p1[1] },
		robust::Coord { x: p2[0], y: p2[1] },
		robust::Coord { x: q[0], y: q[1] },
	);
	if det > 0.0 {
		1
	} else if det < 0.0 {
		-1
	} else {
		0
	}
}

/// The boundary of a polygonal geometry, indexed for the two questions the search asks of every cell.
struct Boundary {
	segments: RTree<Segment>,
}

impl Boundary {
	fn new(polygons: &[Polygon]) -> Boundary {
		let mut segments = Vec::new();
		for polygon in polygons {
			for ring in std::iter::once(&polygon.shell).chain(&polygon.holes) {
				segments.extend(ring.windows(2).map(|pair| Segment { a: pair[0], b: pair[1] }));
			}
		}
		Boundary {
			segments: RTree::bulk_load(segments),
		}
	}

	/// `IndexedFacetDistance.distance`: the smallest point-to-segment distance over every boundary segment.
	fn distance(&self, p: Xy) -> f64 {
		// The tree orders candidates by the square of the same distance; equal squares can come from distances a last
		// bit apart, so every candidate whose square is within rounding of the first is measured.
		let mut best = f64::INFINITY;
		let mut limit = f64::INFINITY;
		for (segment, distance_2) in self.segments.nearest_neighbor_iter_with_distance_2(&p) {
			if distance_2 > limit {
				break;
			}
			if limit.is_infinite() {
				limit = distance_2 * (1.0 + 1e-9);
			}
			best = best.min(point_to_segment(p, segment.a, segment.b));
		}
		best
	}

	/// Whether `p` is outside the area, by `RayCrossingCounter`: a point on the boundary is not outside.
	fn is_outside(&self, p: Xy) -> bool {
		let mut crossings = 0u32;
		let ray = AABB::from_corners(p, [f64::MAX, p[1]]);
		for segment in self.segments.locate_in_envelope_intersecting(&ray) {
			let (p1, p2) = (segment.a, segment.b);
			if p1[0] < p[0] && p2[0] < p[0] {
				continue;
			}
			if p[0] == p2[0] && p[1] == p2[1] {
				return false;
			}
			if p1[1] == p[1] && p2[1] == p[1] {
				if p[0] >= p1[0].min(p2[0]) && p[0] <= p1[0].max(p2[0]) {
					return false;
				}
				continue;
			}
			if (p1[1] > p[1] && p2[1] <= p[1]) || (p2[1] > p[1] && p1[1] <= p[1]) {
				let mut orient = orientation(p1, p2, p);
				if orient == 0 {
					return false;
				}
				if p2[1] < p1[1] {
					orient = -orient;
				}
				if orient == 1 {
					crossings += 1;
				}
			}
		}
		crossings.is_multiple_of(2)
	}

	/// The distance from `p` to the boundary, negative outside the area.
	fn signed_distance(&self, p: Xy) -> f64 {
		let distance = self.distance(p);
		if self.is_outside(p) {
			-distance
		} else {
			distance
		}
	}
}

#[derive(Clone, Copy)]
struct Cell {
	x: f64,
	y: f64,
	h_side: f64,
	distance: f64,
	max_distance: f64,
}

impl Cell {
	fn new(x: f64, y: f64, h_side: f64, distance: f64) -> Cell {
		// JTS's SQRT2 constant, 1.4142135623730951, has the same bits.
		Cell {
			x,
			y,
			h_side,
			distance,
			max_distance: distance + h_side * std::f64::consts::SQRT_2,
		}
	}
}

/// `Double.compare`: numeric order, with -0.0 below 0.0 and NaN above everything.
fn java_double_compare(a: f64, b: f64) -> Ordering {
	if a < b {
		return Ordering::Less;
	}
	if a > b {
		return Ordering::Greater;
	}
	let canonical = |value: f64| {
		if value.is_nan() {
			0x7ff8_0000_0000_0000
		} else {
			value.to_bits() as i64
		}
	};
	canonical(a).cmp(&canonical(b))
}

/// `java.util.PriorityQueue<Cell>` with `Cell.compareTo`, which puts the largest `max_distance` first.
#[derive(Default)]
struct CellQueue {
	heap: Vec<Cell>,
}

impl CellQueue {
	fn order(a: &Cell, b: &Cell) -> Ordering {
		java_double_compare(a.max_distance, b.max_distance).reverse()
	}

	fn add(&mut self, cell: Cell) {
		let mut k = self.heap.len();
		self.heap.push(cell);
		while k > 0 {
			let parent = (k - 1) >> 1;
			if CellQueue::order(&cell, &self.heap[parent]) != Ordering::Less {
				break;
			}
			self.heap[k] = self.heap[parent];
			k = parent;
		}
		self.heap[k] = cell;
	}

	fn remove(&mut self) -> Option<Cell> {
		let last = self.heap.pop()?;
		if self.heap.is_empty() {
			return Some(last);
		}
		let result = self.heap[0];
		let n = self.heap.len();
		let mut k = 0;
		let half = n >> 1;
		while k < half {
			let mut child = 2 * k + 1;
			let right = child + 1;
			if right < n && CellQueue::order(&self.heap[child], &self.heap[right]) == Ordering::Greater {
				child = right;
			}
			if CellQueue::order(&last, &self.heap[child]) != Ordering::Greater {
				break;
			}
			self.heap[k] = self.heap[child];
			k = child;
		}
		self.heap[k] = last;
		Some(result)
	}
}

/// `MaximumInscribedCircle.getCenter(polygonal, tolerance)` for a non-empty polygon or multipolygon, with the search
/// seeded at `interior_point`, the geometry's `getInteriorPoint`. Returns `None` for a non-positive tolerance, which
/// JTS rejects, or for no polygons.
pub fn maximum_inscribed_circle_center(polygons: &[Polygon], interior_point: Xy, tolerance: f64) -> Option<Xy> {
	if tolerance <= 0.0 || polygons.is_empty() {
		return None;
	}
	let (mut min_x, mut min_y, mut max_x, mut max_y) =
		(f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
	for &[x, y] in polygons.iter().flat_map(|polygon| &polygon.shell) {
		min_x = min_x.min(x);
		min_y = min_y.min(y);
		max_x = max_x.max(x);
		max_y = max_y.max(y);
	}
	let boundary = Boundary::new(polygons);
	let mut queue = CellQueue::default();
	let (width, height) = (max_x - min_x, max_y - min_y);
	let cell_size = width.max(height);
	if cell_size != 0.0 {
		let (x, y) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
		queue.add(Cell::new(x, y, cell_size / 2.0, boundary.signed_distance([x, y])));
	}
	let mut farthest = Cell::new(
		interior_point[0],
		interior_point[1],
		0.0,
		boundary.signed_distance(interior_point),
	);

	// `computeMaximumIterations`: 2,000 cells per unit of the logarithm of the cells across the diameter.
	let cells_across = hypot(width, height) / tolerance;
	let factor = (cells_across.ln() as i32).max(1);
	let max_iterations = 2000 + 2000 * i64::from(factor);
	let mut iterations = 0;
	while iterations < max_iterations {
		let Some(cell) = queue.remove() else {
			break;
		};
		iterations += 1;
		if cell.max_distance < farthest.distance {
			break;
		}
		if cell.distance > farthest.distance {
			farthest = cell;
		}
		if cell.max_distance - farthest.distance > tolerance {
			let h2 = cell.h_side / 2.0;
			for (x, y) in [
				(cell.x - h2, cell.y - h2),
				(cell.x + h2, cell.y - h2),
				(cell.x - h2, cell.y + h2),
				(cell.x + h2, cell.y + h2),
			] {
				queue.add(Cell::new(x, y, h2, boundary.signed_distance([x, y])));
			}
		}
	}
	Some([farthest.x, farthest.y])
}

#[cfg(test)]
mod tests {
	use super::*;

	fn square(x0: f64, y0: f64, side: f64) -> Vec<Xy> {
		vec![
			[x0, y0],
			[x0 + side, y0],
			[x0 + side, y0 + side],
			[x0, y0 + side],
			[x0, y0],
		]
	}

	#[test]
	fn the_queue_returns_cells_in_java_priority_queue_order() {
		// Equal keys come back in the order java.util.PriorityQueue's sift-up and sift-down leave them: offering
		// keys 1, 3, 3, 2, 3 tagged by x 0..4 polls x = 1, 4, 2, 3, 0 (checked against JDK 21).
		let mut queue = CellQueue::default();
		for (x, key) in [1.0, 3.0, 3.0, 2.0, 3.0].into_iter().enumerate() {
			queue.add(Cell::new(x as f64, 0.0, 0.0, key));
		}
		let order: Vec<f64> = std::iter::from_fn(|| queue.remove()).map(|cell| cell.x).collect();
		assert_eq!(order, [1.0, 4.0, 2.0, 3.0, 0.0]);
	}

	#[test]
	fn a_square_with_a_hole_keeps_its_center_off_the_hole() {
		let polygon = Polygon {
			shell: square(0.0, 0.0, 10.0),
			holes: vec![square(4.0, 4.0, 2.0).into_iter().rev().collect()],
		};
		let [x, y] = maximum_inscribed_circle_center(&[polygon], [1.0, 1.0], 0.01).unwrap();
		let boundary = Boundary::new(&[Polygon {
			shell: square(0.0, 0.0, 10.0),
			holes: vec![square(4.0, 4.0, 2.0).into_iter().rev().collect()],
		}]);
		assert!(!boundary.is_outside([x, y]));
		// The largest empty circle between the hole and the shell has radius about 2.1, near a corner region.
		assert!(boundary.distance([x, y]) > 2.0, "center ({x}, {y})");
	}

	#[test]
	fn points_outside_get_negative_distances() {
		let boundary = Boundary::new(&[Polygon {
			shell: square(0.0, 0.0, 4.0),
			holes: vec![],
		}]);
		assert_eq!(boundary.signed_distance([2.0, 2.0]), 2.0);
		assert_eq!(boundary.signed_distance([6.0, 2.0]), -2.0);
		assert_eq!(boundary.signed_distance([4.0, 2.0]), 0.0);
	}
}
