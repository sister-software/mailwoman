// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Planetiler 0.10.2's DouglasPeuckerSimplifier (Apache-2.0, Copyright Michael Barry) and the parts of
// JTS 1.20's GeometryTransformer (EPL-2.0 or EDL-1.0) it relies on.

//! Douglas-Peucker simplification as Planetiler applies it to every line and polygon before slicing.
//!
//! A ring keeps at least four points and a line at least two: the recursion is forced to keep the farthest points
//! until that minimum is met. A polygon ring that ends with fewer than four points is dropped, and a polygon whose
//! shell is dropped turns into the collection of its remaining rings, as JTS's transformer builds it.

use crate::geom::{build_geometry, Geom, Polygon, Seq, Xy};

/// Returns the squared distance from `p` to the segment from `a` to `b`.
fn sq_seg_dist(p: Xy, a: Xy, b: Xy) -> f64 {
	let (mut x, mut y) = (a[0], a[1]);
	let mut dx = b[0] - x;
	let mut dy = b[1] - y;
	if dx != 0.0 || dy != 0.0 {
		let t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
		if t > 1.0 {
			x = b[0];
			y = b[1];
		} else if t > 0.0 {
			x += dx * t;
			y += dy * t;
		}
	}
	dx = p[0] - x;
	dy = p[1] - y;
	dx * dx + dy * dy
}

struct Simplifier {
	sq_tolerance: f64,
}

impl Simplifier {
	fn subsimplify(&self, input: &[Xy], out: &mut Seq, first: usize, last: usize, forced: i32) {
		let force = forced > 0;
		let mut max_sq = if force { -1.0 } else { self.sq_tolerance };
		let mut index = None;
		for i in first + 1..last {
			let sq = sq_seg_dist(input[i], input[first], input[last]);
			if sq > max_sq {
				index = Some(i);
				max_sq = sq;
			}
		}
		if force || max_sq > self.sq_tolerance {
			let index = index.expect("a forced split has an interior point");
			if index - first > 1 {
				self.subsimplify(input, out, first, index, forced - 1);
			}
			out.push(input[index]);
			if last - index > 1 {
				self.subsimplify(input, out, index, last, forced - 2);
			}
		}
	}

	fn coordinates(&self, seq: &Seq, area: bool) -> Seq {
		let min_points = if area { 4 } else { 2 };
		if seq.len() <= min_points {
			return seq.clone();
		}
		let mut out = Vec::with_capacity(seq.len());
		out.push(seq[0]);
		self.subsimplify(seq, &mut out, 0, seq.len() - 1, min_points as i32 - 2);
		out.push(seq[seq.len() - 1]);
		out
	}

	/// JTS's `transformLinearRing` with Planetiler's override: a ring that falls below four points becomes a line
	/// string, or `None` when it belongs to a polygon.
	fn ring(&self, seq: &Seq, in_polygon: bool) -> Option<Geom> {
		let out = self.coordinates(seq, true);
		if !out.is_empty() && out.len() < 4 {
			return if in_polygon { None } else { Some(Geom::LineString(out)) };
		}
		Some(Geom::LinearRing(out))
	}

	fn polygon(&self, polygon: &Polygon) -> Option<Geom> {
		if polygon.shell.is_empty() {
			return None;
		}
		let shell = self.ring(&polygon.shell, true);
		let mut all_rings = matches!(&shell, Some(Geom::LinearRing(seq)) if !seq.is_empty());
		let mut holes = Vec::new();
		for hole in &polygon.holes {
			match self.ring(hole, true) {
				None => {}
				Some(geom) if geom.is_empty() => {}
				Some(geom) => {
					if !matches!(geom, Geom::LinearRing(_)) {
						all_rings = false;
					}
					holes.push(geom);
				}
			}
		}
		if all_rings {
			let Some(Geom::LinearRing(shell)) = shell else {
				unreachable!()
			};
			let holes = holes
				.into_iter()
				.map(|hole| match hole {
					Geom::LinearRing(seq) => seq,
					_ => unreachable!(),
				})
				.collect();
			Some(Geom::Polygon(Polygon { shell, holes }))
		} else {
			let mut parts: Vec<Geom> = shell.into_iter().collect();
			parts.extend(holes);
			Some(build_geometry(parts))
		}
	}

	fn transform(&self, geom: &Geom) -> Geom {
		match geom {
			Geom::Point(_) | Geom::MultiPoint(_) => geom.clone(),
			Geom::LineString(seq) => Geom::LineString(self.coordinates(seq, false)),
			Geom::LinearRing(seq) => self.ring(seq, false).unwrap_or_else(Geom::empty),
			Geom::MultiLineString(lines) => {
				// JTS transforms each member as a line string, so a member ring loses its ring type but keeps the
				// four-point minimum, because the coordinates' parent is still a ring.
				let parts: Vec<Geom> = lines
					.iter()
					.map(|line| Geom::LineString(self.coordinates(&line.seq, line.ring)))
					.filter(|part| !part.is_empty())
					.collect();
				if parts.is_empty() {
					Geom::MultiLineString(Vec::new())
				} else {
					build_geometry(parts)
				}
			}
			Geom::Polygon(polygon) => self.polygon(polygon).unwrap_or_else(Geom::empty),
			Geom::MultiPolygon(polygons) => {
				let parts: Vec<Geom> = polygons
					.iter()
					.filter_map(|polygon| self.polygon(polygon))
					.filter(|part| !part.is_empty())
					.collect();
				if parts.is_empty() {
					Geom::MultiPolygon(Vec::new())
				} else {
					build_geometry(parts)
				}
			}
			Geom::Collection(parts) => Geom::Collection(
				parts
					.iter()
					.map(|part| self.transform(part))
					.filter(|part| !part.is_empty())
					.collect(),
			),
		}
	}
}

/// Simplifies `geom` with Douglas-Peucker at `tolerance`, in the geometry's own units.
pub fn douglas_peucker(geom: &Geom, tolerance: f64) -> Geom {
	if geom.is_empty() || tolerance < 0.0 {
		return geom.clone();
	}
	Simplifier {
		sq_tolerance: tolerance * tolerance.abs(),
	}
	.transform(geom)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_nearly_straight_line_reduces_to_its_ends() {
		let line = Geom::LineString(vec![[0.0, 0.0], [1.0, 0.01], [2.0, 0.0]]);
		assert_eq!(
			douglas_peucker(&line, 0.1),
			Geom::LineString(vec![[0.0, 0.0], [2.0, 0.0]])
		);
	}

	#[test]
	fn a_ring_keeps_four_points_however_small_it_is() {
		let ring = vec![
			[0.0, 0.0],
			[0.0, 0.001],
			[0.0, 0.002],
			[0.001, 0.002],
			[0.002, 0.002],
			[0.002, 0.0],
			[0.0, 0.0],
		];
		let simplified = douglas_peucker(
			&Geom::Polygon(Polygon {
				shell: ring,
				holes: vec![],
			}),
			10.0,
		);
		match simplified {
			Geom::Polygon(polygon) => assert_eq!(polygon.shell.len(), 4),
			other => panic!("expected a polygon, got {other:?}"),
		}
	}
}
