// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Planetiler 0.10.2's GeometryCoordinateSequences (Apache-2.0, Copyright Michael Barry).

//! Converting between geometries and the coordinate-sequence groups the slicer works on.
//!
//! A group is one polygon, as its shell followed by its holes, or one line. Before slicing, every shell is turned to a
//! non-positive JTS signed area and every hole likewise, and rings and lines below the minimum size are dropped. After
//! slicing, each tile's groups are rebuilt into geometry, with the holes reversed again.

use crate::geom::{ring_signed_area, Geom, Line, Polygon, Seq};

/// A tile's polygon groups that could not form valid rings: `reassemble_polygon_failed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReassembleError;

/// Returns the slicing groups of `geom`, dropping lines shorter than `min_size` and rings with less area.
pub fn extract_groups(geom: &Geom, min_size: f64) -> Vec<Vec<Seq>> {
	let mut groups = Vec::new();
	extract(geom, min_size, &mut groups);
	groups
}

fn extract(geom: &Geom, min_size: f64, groups: &mut Vec<Vec<Seq>>) {
	if geom.is_empty() {
		return;
	}
	match geom {
		Geom::Collection(parts) => parts.iter().for_each(|part| extract(part, min_size, groups)),
		Geom::MultiPolygon(polygons) => polygons
			.iter()
			.for_each(|polygon| from_polygon(polygon, min_size, groups)),
		Geom::MultiLineString(lines) => {
			for Line { seq, ring } in lines {
				let part = if *ring {
					Geom::LinearRing(seq.clone())
				} else {
					Geom::LineString(seq.clone())
				};
				extract(&part, min_size, groups);
			}
		}
		Geom::Polygon(polygon) => from_polygon(polygon, min_size, groups),
		Geom::LinearRing(seq) => from_polygon(
			&Polygon {
				shell: seq.clone(),
				holes: Vec::new(),
			},
			min_size,
			groups,
		),
		Geom::LineString(seq) => {
			if crate::geom::line_length(seq) >= min_size {
				groups.push(vec![seq.clone()]);
			}
		}
		Geom::Point(_) | Geom::MultiPoint(_) => panic!("points are sliced with slice_points"),
	}
}

fn oriented(seq: &Seq) -> (Seq, f64) {
	let area = ring_signed_area(seq);
	let mut ring = seq.clone();
	if area > 0.0 {
		ring.reverse();
	}
	(ring, area.abs())
}

fn from_polygon(polygon: &Polygon, min_area: f64, groups: &mut Vec<Vec<Seq>>) {
	let (outer, outer_area) = oriented(&polygon.shell);
	if outer_area < min_area {
		return;
	}
	let mut group = Vec::with_capacity(1 + polygon.holes.len());
	group.push(outer);
	for hole in &polygon.holes {
		let (inner, inner_area) = oriented(hole);
		if inner_area >= min_area {
			group.push(inner);
		}
	}
	groups.push(group);
}

/// Rebuilds a tile's line pieces into a line string, or a multi-line string when there are several.
pub fn reassemble_lines(groups: &[Vec<Seq>]) -> Geom {
	let mut lines: Vec<Seq> = groups.iter().flatten().filter(|seq| seq.len() > 1).cloned().collect();
	if lines.len() == 1 {
		Geom::LineString(lines.pop().unwrap())
	} else {
		Geom::MultiLineString(lines.into_iter().map(|seq| Line { seq, ring: false }).collect())
	}
}

/// Rebuilds a tile's points into a point, or a multi-point when there are several.
pub fn reassemble_points(groups: &[Vec<Seq>]) -> Geom {
	let mut points: Vec<[f64; 2]> = groups
		.iter()
		.flatten()
		.filter(|seq| seq.len() == 1)
		.map(|seq| seq[0])
		.collect();
	if points.len() == 1 {
		Geom::Point(points.pop().unwrap())
	} else {
		Geom::MultiPoint(points)
	}
}

fn linear_ring(seq: Seq) -> Result<Seq, ReassembleError> {
	// JTS refuses a ring that is open or has one to three points.
	if seq.is_empty() || (seq.len() >= 4 && seq.first() == seq.last()) {
		Ok(seq)
	} else {
		Err(ReassembleError)
	}
}

fn reassemble_polygon(group: &[Seq]) -> Result<Polygon, ReassembleError> {
	let shell = linear_ring(group[0].clone())?;
	let holes = group[1..]
		.iter()
		.map(|hole| {
			let mut ring = hole.clone();
			ring.reverse();
			linear_ring(ring)
		})
		.collect::<Result<_, _>>()?;
	Ok(Polygon { shell, holes })
}

/// Rebuilds a tile's polygon groups into a polygon, or a multi-polygon when there are several.
pub fn reassemble_polygons(groups: &[Vec<Seq>]) -> Result<Geom, ReassembleError> {
	if groups.len() == 1 {
		return Ok(Geom::Polygon(reassemble_polygon(&groups[0])?));
	}
	Ok(Geom::MultiPolygon(
		groups
			.iter()
			.map(|group| reassemble_polygon(group))
			.collect::<Result<_, _>>()?,
	))
}
