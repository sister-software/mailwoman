// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Planetiler 0.10.2's GeoUtils.snapAndFixPolygon and fixPolygon (Apache-2.0, Copyright Michael Barry).

//! Snapping a tile's polygon to the 4096-unit grid and repairing it, as Planetiler does before encoding.
//!
//! Most polygons take the first step only: each point is rounded to the grid, repeated points are dropped, and when
//! the result is valid its rings are turned so shells run clockwise and holes counter-clockwise with y pointing up. A
//! polygon that rounding made invalid goes through GEOS: repaired with `buffer(0)` if the unrounded polygon was itself
//! invalid, then reduced to the grid with GEOS's precision reducer, which keeps the result valid. GEOS ports the JTS
//! classes Planetiler calls for these steps.

use geos::{CoordSeq, Geom as _, Geometry, GeometryTypes, MakeValidMethod, MakeValidParams, Precision};

use crate::geom::{build_geometry, is_ccw, java_round, Geom, Line, Polygon, Seq};

/// The grid scale of a tile: 4096 units over 256 pixels.
const TILE_SCALE: f64 = 4096.0 / 256.0;

/// Counts of the polygons that left the rounding fast path, with Planetiler's statistic names.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SnapCounts {
	/// Polygons whose rounded form was invalid and went to the precision reducer.
	pub reduced: u64,
	/// `render_snap_fix_input`: the unrounded polygon was invalid and was buffered by zero first.
	pub fix_input: u64,
	/// `render_snap_fix_input2`: the precision reducer failed and GEOS's repair ran.
	pub fix_input2: u64,
	/// `render_snap_fix_input3`: the second reduction failed and the polygon was buffered out and back in.
	pub fix_input3: u64,
}

/// A polygon that every repair step failed on: `snap_third_time_failed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapError(pub String);

fn round_point(value: f64) -> f64 {
	java_round(value * TILE_SCALE) / TILE_SCALE
}

/// Planetiler's `PointwiseRounder`: a ring of under four points becomes `None`; otherwise every point is rounded and
/// consecutive repeats are dropped.
fn round_ring(seq: &Seq) -> Option<Seq> {
	if seq.len() < 4 {
		return None;
	}
	let mut out: Seq = Vec::with_capacity(seq.len());
	// Java's Double.MIN_VALUE, the smallest subnormal double.
	let mut last = [f64::from_bits(1), f64::from_bits(1)];
	for &[x, y] in seq {
		let point = [round_point(x), round_point(y)];
		if point != last {
			out.push(point);
		}
		last = point;
	}
	if out.len() < 4 {
		None
	} else {
		Some(out)
	}
}

/// JTS `GeometryTransformer.transformLinearRing` over a coordinate function that may return `None`.
fn transform_ring(seq: Option<Seq>) -> Geom {
	match seq {
		None => Geom::LinearRing(Vec::new()),
		Some(seq) if !seq.is_empty() && seq.len() < 4 => Geom::LineString(seq),
		Some(seq) => Geom::LinearRing(seq),
	}
}

/// JTS `GeometryTransformer.transformPolygon` with the default transformer flags.
fn transform_polygon(polygon: &Polygon, ring: &impl Fn(&Seq, bool) -> Geom) -> Geom {
	let shell = ring(&polygon.shell, true);
	let shell_empty = shell.is_empty();
	if polygon.shell.is_empty() && shell_empty {
		return Geom::Polygon(Polygon::default());
	}
	let mut all_rings = !shell_empty && matches!(shell, Geom::LinearRing(_));
	let mut holes = Vec::new();
	for hole in &polygon.holes {
		let hole = ring(hole, false);
		if hole.is_empty() {
			continue;
		}
		if !matches!(hole, Geom::LinearRing(_)) {
			all_rings = false;
		}
		holes.push(hole);
	}
	if all_rings {
		let unwrap = |geom: Geom| match geom {
			Geom::LinearRing(seq) => seq,
			_ => unreachable!(),
		};
		Geom::Polygon(Polygon {
			shell: unwrap(shell),
			holes: holes.into_iter().map(unwrap).collect(),
		})
	} else {
		let mut parts = vec![shell];
		parts.extend(holes);
		build_geometry(parts)
	}
}

fn transform(geom: &Geom, ring: &impl Fn(&Seq, bool) -> Geom) -> Geom {
	match geom {
		Geom::Polygon(polygon) => transform_polygon(polygon, ring),
		Geom::MultiPolygon(polygons) => {
			let parts: Vec<Geom> = polygons
				.iter()
				.map(|polygon| transform_polygon(polygon, ring))
				.filter(|part| !part.is_empty())
				.collect();
			if parts.is_empty() {
				Geom::MultiPolygon(Vec::new())
			} else {
				build_geometry(parts)
			}
		}
		Geom::LinearRing(seq) => ring(seq, true),
		Geom::Collection(parts) => Geom::Collection(
			parts
				.iter()
				.map(|part| transform(part, ring))
				.filter(|part| !part.is_empty())
				.collect(),
		),
		Geom::MultiLineString(lines) => Geom::MultiLineString(lines.clone()),
		other => other.clone(),
	}
}

/// Planetiler's `OrientationFixer`: shells end clockwise and holes counter-clockwise, with y pointing up.
fn fix_orientation(geom: &Geom) -> Geom {
	transform(geom, &|seq: &Seq, outer: bool| {
		let mut ring = seq.clone();
		if is_ccw(&ring) == outer {
			ring.reverse();
		}
		Geom::LinearRing(ring)
	})
}

/// Reverses every ring and line, as JTS's `Geometry.reverse` does.
pub fn reverse(geom: &Geom) -> Geom {
	let rev = |seq: &Seq| seq.iter().rev().copied().collect::<Seq>();
	let rev_polygon = |polygon: &Polygon| Polygon {
		shell: rev(&polygon.shell),
		holes: polygon.holes.iter().map(rev).collect(),
	};
	match geom {
		Geom::LineString(seq) => Geom::LineString(rev(seq)),
		Geom::LinearRing(seq) => Geom::LinearRing(rev(seq)),
		Geom::MultiLineString(lines) => Geom::MultiLineString(
			lines
				.iter()
				.map(|line| Line {
					seq: rev(&line.seq),
					ring: line.ring,
				})
				.collect(),
		),
		Geom::Polygon(polygon) => Geom::Polygon(rev_polygon(polygon)),
		Geom::MultiPolygon(polygons) => Geom::MultiPolygon(polygons.iter().map(rev_polygon).collect()),
		Geom::Collection(parts) => Geom::Collection(parts.iter().map(reverse).collect()),
		other => other.clone(),
	}
}

fn to_geos_seq(seq: &Seq) -> geos::GResult<CoordSeq> {
	CoordSeq::new_from_vec(seq)
}

fn to_geos_polygon(polygon: &Polygon) -> geos::GResult<Geometry> {
	if polygon.shell.is_empty() {
		return Geometry::create_empty_polygon();
	}
	let shell = Geometry::create_linear_ring(to_geos_seq(&polygon.shell)?)?;
	let holes = polygon
		.holes
		.iter()
		.map(|hole| Geometry::create_linear_ring(to_geos_seq(hole)?))
		.collect::<geos::GResult<Vec<_>>>()?;
	Geometry::create_polygon(shell, holes)
}

/// Converts a geometry to GEOS.
pub fn to_geos(geom: &Geom) -> geos::GResult<Geometry> {
	match geom {
		Geom::Point(point) => Geometry::create_point(CoordSeq::new_from_vec(&[point])?),
		Geom::MultiPoint(points) => Geometry::create_multipoint(
			points
				.iter()
				.map(|point| Geometry::create_point(CoordSeq::new_from_vec(&[point])?))
				.collect::<geos::GResult<_>>()?,
		),
		Geom::LineString(seq) => {
			if seq.is_empty() {
				Geometry::create_empty_line_string()
			} else {
				Geometry::create_line_string(to_geos_seq(seq)?)
			}
		}
		Geom::LinearRing(seq) => {
			if seq.is_empty() {
				Geometry::create_empty_collection(GeometryTypes::GeometryCollection)
			} else {
				Geometry::create_linear_ring(to_geos_seq(seq)?)
			}
		}
		Geom::MultiLineString(lines) => Geometry::create_multiline_string(
			lines
				.iter()
				.map(|line| Geometry::create_line_string(to_geos_seq(&line.seq)?))
				.collect::<geos::GResult<_>>()?,
		),
		Geom::Polygon(polygon) => to_geos_polygon(polygon),
		Geom::MultiPolygon(polygons) => {
			Geometry::create_multipolygon(polygons.iter().map(to_geos_polygon).collect::<geos::GResult<_>>()?)
		}
		Geom::Collection(parts) => {
			Geometry::create_geometry_collection(parts.iter().map(to_geos).collect::<geos::GResult<_>>()?)
		}
	}
}

fn from_geos_seq(geom: &impl geos::Geom) -> geos::GResult<Seq> {
	let seq = geom.get_coord_seq()?;
	let size = seq.size()?;
	(0..size)
		.map(|index| Ok([seq.get_x(index)?, seq.get_y(index)?]))
		.collect()
}

fn from_geos_polygon(geom: &impl geos::Geom) -> geos::GResult<Polygon> {
	if geom.is_empty()? {
		return Ok(Polygon::default());
	}
	let shell = from_geos_seq(&geom.get_exterior_ring()?)?;
	let holes = (0..geom.get_num_interior_rings()?)
		.map(|index| from_geos_seq(&geom.get_interior_ring_n(index)?))
		.collect::<geos::GResult<_>>()?;
	Ok(Polygon { shell, holes })
}

/// Converts a GEOS geometry back.
pub fn from_geos(geom: &impl geos::Geom) -> geos::GResult<Geom> {
	Ok(match geom.geometry_type()? {
		GeometryTypes::Point => {
			let seq = from_geos_seq(geom)?;
			if seq.is_empty() {
				Geom::MultiPoint(Vec::new())
			} else {
				Geom::Point(seq[0])
			}
		}
		GeometryTypes::LineString => Geom::LineString(from_geos_seq(geom)?),
		GeometryTypes::LinearRing => Geom::LinearRing(from_geos_seq(geom)?),
		GeometryTypes::Polygon => Geom::Polygon(from_geos_polygon(geom)?),
		GeometryTypes::MultiPoint => Geom::MultiPoint(
			(0..geom.get_num_geometries()?)
				.map(|index| Ok(from_geos_seq(&geom.get_geometry_n(index)?)?[0]))
				.collect::<geos::GResult<_>>()?,
		),
		GeometryTypes::MultiLineString => Geom::MultiLineString(
			(0..geom.get_num_geometries()?)
				.map(|index| {
					let part = geom.get_geometry_n(index)?;
					Ok(Line {
						seq: from_geos_seq(&part)?,
						ring: part.geometry_type()? == GeometryTypes::LinearRing,
					})
				})
				.collect::<geos::GResult<_>>()?,
		),
		GeometryTypes::MultiPolygon => Geom::MultiPolygon(
			(0..geom.get_num_geometries()?)
				.map(|index| from_geos_polygon(&geom.get_geometry_n(index)?))
				.collect::<geos::GResult<_>>()?,
		),
		_ => Geom::Collection(
			(0..geom.get_num_geometries()?)
				.map(|index| from_geos(&geom.get_geometry_n(index)?))
				.collect::<geos::GResult<_>>()?,
		),
	})
}

/// Planetiler's `fixPolygon`: GEOS `buffer(0)` with JTS's default eight segments per quadrant.
pub fn fix_polygon(geom: &Geom) -> geos::GResult<Geom> {
	from_geos(&to_geos(geom)?.buffer(0.0, 8)?)
}

fn reduce(geom: &Geometry) -> geos::GResult<Geom> {
	from_geos(&geom.set_precision(1.0 / TILE_SCALE, Precision::ValidOutput)?)
}

/// Returns whether GEOS considers `geom` valid.
pub fn is_valid(geom: &Geom) -> geos::GResult<bool> {
	to_geos(geom)?.is_valid()
}

/// Snaps a tile's polygon, in tile pixels, to the grid and repairs it, counting the polygons that left the fast path.
pub fn snap_and_fix_polygon(geom: &Geom, counts: &mut SnapCounts) -> Result<Geom, SnapError> {
	let naive = transform(geom, &|seq: &Seq, _outer: bool| transform_ring(round_ring(seq)));
	let mut attempt = || -> geos::GResult<Geom> {
		if is_valid(&naive)? {
			return Ok(fix_orientation(&naive));
		}
		counts.reduced += 1;
		let mut input = to_geos(geom)?;
		if !input.is_valid()? {
			input = input.buffer(0.0, 8)?;
			counts.fix_input += 1;
		}
		reduce(&input)
	};
	let error = match attempt() {
		Ok(result) => return Ok(result),
		Err(error) => error,
	};

	// GEOS reports the robustness failures JTS raises as exceptions through the same error channel.
	let mut repair = || -> geos::GResult<Geom> {
		let mut params = MakeValidParams::new()?;
		params.set_method(MakeValidMethod::Structure)?;
		params.set_keep_collapsed(false)?;
		let fixed = to_geos(geom)?.make_valid_with_params(&params)?;
		counts.fix_input2 += 1;
		match reduce(&fixed) {
			Ok(result) => Ok(result),
			Err(_) => {
				let half = 1.0 / TILE_SCALE / 2.0;
				let buffered = fixed.buffer(half, 8)?.buffer(-half, 8)?;
				counts.fix_input3 += 1;
				reduce(&buffered)
			}
		}
	};
	repair().map_err(|second| SnapError(format!("{error}; {second}")))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_valid_square_rounds_to_the_grid_and_turns_clockwise() {
		let square = Geom::Polygon(Polygon {
			shell: vec![[0.01, 0.01], [10.02, 0.01], [10.02, 10.03], [0.01, 10.03], [0.01, 0.01]],
			holes: vec![],
		});
		let mut counts = SnapCounts::default();
		let Geom::Polygon(snapped) = snap_and_fix_polygon(&square, &mut counts).unwrap() else {
			panic!("expected a polygon");
		};
		assert_eq!(counts, SnapCounts::default());
		assert!(!is_ccw(&snapped.shell));
		assert!(snapped
			.shell
			.iter()
			.all(|&[x, y]| (x * 16.0).fract() == 0.0 && (y * 16.0).fract() == 0.0));
	}

	#[test]
	fn a_bow_tie_goes_to_the_precision_reducer() {
		let bow_tie = Geom::Polygon(Polygon {
			shell: vec![[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0], [0.0, 0.0]],
			holes: vec![],
		});
		let mut counts = SnapCounts::default();
		let fixed = snap_and_fix_polygon(&bow_tie, &mut counts).unwrap();
		assert_eq!(counts.reduced, 1);
		assert_eq!(counts.fix_input, 1);
		assert!(is_valid(&fixed).unwrap());
	}
}
