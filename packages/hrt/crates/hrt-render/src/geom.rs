// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A geometry model with JTS's type distinctions, and the JTS measurements the renderer depends on.
//!
//! Planetiler's rendering decisions branch on JTS geometry classes: a `LinearRing` inside a `MultiLineString` is
//! treated as a polygon when sliced, and a polygon whose shell collapses becomes a collection of rings. This model keeps
//! those distinctions so the port follows the same branches.

use robust::{orient2d, Coord};

/// A coordinate pair.
pub type Xy = [f64; 2];

/// A coordinate sequence.
pub type Seq = Vec<Xy>;

/// A polygon: a shell ring and hole rings, each closed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Polygon {
	pub shell: Seq,
	pub holes: Vec<Seq>,
}

/// One member of a `MultiLineString`, which JTS allows to be a `LinearRing`.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
	pub seq: Seq,
	pub ring: bool,
}

/// A geometry, with the classes Planetiler's renderer distinguishes.
#[derive(Clone, Debug, PartialEq)]
pub enum Geom {
	Point(Xy),
	MultiPoint(Vec<Xy>),
	LineString(Seq),
	LinearRing(Seq),
	MultiLineString(Vec<Line>),
	Polygon(Polygon),
	MultiPolygon(Vec<Polygon>),
	Collection(Vec<Geom>),
}

/// The vector tile geometry type of a geometry, as Planetiler's `GeometryType.typeOf` assigns it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GeometryType {
	Unknown,
	Point,
	Line,
	Polygon,
}

impl GeometryType {
	/// Returns the fewest points an encoded part needs before the encoder keeps it.
	pub fn min_points(self) -> usize {
		match self {
			GeometryType::Point => 1,
			GeometryType::Line => 2,
			GeometryType::Polygon => 4,
			GeometryType::Unknown => 0,
		}
	}
}

impl Geom {
	/// Returns an empty geometry collection, which JTS's `buildGeometry` returns for an empty list.
	pub fn empty() -> Self {
		Geom::Collection(Vec::new())
	}

	pub fn is_empty(&self) -> bool {
		match self {
			Geom::Point(_) => false,
			Geom::MultiPoint(points) => points.is_empty(),
			Geom::LineString(seq) | Geom::LinearRing(seq) => seq.is_empty(),
			Geom::MultiLineString(lines) => lines.iter().all(|line| line.seq.is_empty()),
			Geom::Polygon(polygon) => polygon.shell.is_empty(),
			Geom::MultiPolygon(polygons) => polygons.iter().all(|polygon| polygon.shell.is_empty()),
			Geom::Collection(parts) => parts.iter().all(Geom::is_empty),
		}
	}

	pub fn is_puntal(&self) -> bool {
		matches!(self, Geom::Point(_) | Geom::MultiPoint(_))
	}

	pub fn is_lineal(&self) -> bool {
		matches!(
			self,
			Geom::LineString(_) | Geom::LinearRing(_) | Geom::MultiLineString(_)
		)
	}

	pub fn is_polygonal(&self) -> bool {
		matches!(self, Geom::Polygon(_) | Geom::MultiPolygon(_))
	}

	/// Returns the number of component geometries, as JTS's `getNumGeometries` counts them.
	pub fn num_geometries(&self) -> usize {
		match self {
			Geom::MultiPoint(points) => points.len(),
			Geom::MultiLineString(lines) => lines.len(),
			Geom::MultiPolygon(polygons) => polygons.len(),
			Geom::Collection(parts) => parts.len(),
			_ => 1,
		}
	}

	/// Returns the vector tile type: the shared type of every part of a collection, else `Unknown`.
	pub fn geometry_type(&self) -> GeometryType {
		match self {
			Geom::Collection(parts) if !parts.is_empty() => {
				let first = parts[0].geometry_type();
				if parts[1..].iter().all(|part| part.geometry_type() == first) {
					first
				} else {
					GeometryType::Unknown
				}
			}
			Geom::Point(_) | Geom::MultiPoint(_) => GeometryType::Point,
			Geom::LineString(_) | Geom::LinearRing(_) | Geom::MultiLineString(_) => GeometryType::Line,
			Geom::Polygon(_) | Geom::MultiPolygon(_) => GeometryType::Polygon,
			Geom::Collection(_) => GeometryType::Unknown,
		}
	}

	/// Returns the geometry with every coordinate multiplied by `scale`.
	pub fn scaled(&self, scale: f64) -> Geom {
		let seq = |seq: &Seq| seq.iter().map(|&[x, y]| [x * scale, y * scale]).collect::<Seq>();
		let polygon = |polygon: &Polygon| Polygon {
			shell: seq(&polygon.shell),
			holes: polygon.holes.iter().map(seq).collect(),
		};
		match self {
			Geom::Point([x, y]) => Geom::Point([x * scale, y * scale]),
			Geom::MultiPoint(points) => Geom::MultiPoint(seq(points)),
			Geom::LineString(s) => Geom::LineString(seq(s)),
			Geom::LinearRing(s) => Geom::LinearRing(seq(s)),
			Geom::MultiLineString(lines) => Geom::MultiLineString(
				lines
					.iter()
					.map(|line| Line {
						seq: seq(&line.seq),
						ring: line.ring,
					})
					.collect(),
			),
			Geom::Polygon(p) => Geom::Polygon(polygon(p)),
			Geom::MultiPolygon(polygons) => Geom::MultiPolygon(polygons.iter().map(polygon).collect()),
			Geom::Collection(parts) => Geom::Collection(parts.iter().map(|part| part.scaled(scale)).collect()),
		}
	}

	/// Returns the total length of every line and ring, as JTS's `getLength` measures it.
	pub fn length(&self) -> f64 {
		match self {
			Geom::Point(_) | Geom::MultiPoint(_) => 0.0,
			Geom::LineString(seq) | Geom::LinearRing(seq) => line_length(seq),
			Geom::MultiLineString(lines) => lines.iter().map(|line| line_length(&line.seq)).sum(),
			Geom::Polygon(polygon) => polygon_length(polygon),
			Geom::MultiPolygon(polygons) => polygons.iter().map(polygon_length).sum(),
			Geom::Collection(parts) => parts.iter().map(Geom::length).sum(),
		}
	}

	/// Returns the area of every polygon, holes subtracted, as JTS's `getArea` measures it.
	pub fn area(&self) -> f64 {
		match self {
			Geom::Polygon(polygon) => polygon_area(polygon),
			Geom::MultiPolygon(polygons) => polygons.iter().map(polygon_area).sum(),
			Geom::Collection(parts) => parts.iter().map(Geom::area).sum(),
			_ => 0.0,
		}
	}

	/// Returns the number of coordinates, as JTS's `getNumPoints` counts them.
	pub fn num_points(&self) -> usize {
		match self {
			Geom::Point(_) => 1,
			Geom::MultiPoint(points) => points.len(),
			Geom::LineString(seq) | Geom::LinearRing(seq) => seq.len(),
			Geom::MultiLineString(lines) => lines.iter().map(|line| line.seq.len()).sum(),
			Geom::Polygon(polygon) => polygon_points(polygon),
			Geom::MultiPolygon(polygons) => polygons.iter().map(polygon_points).sum(),
			Geom::Collection(parts) => parts.iter().map(Geom::num_points).sum(),
		}
	}
}

fn polygon_points(polygon: &Polygon) -> usize {
	polygon.shell.len() + polygon.holes.iter().map(Vec::len).sum::<usize>()
}

fn polygon_length(polygon: &Polygon) -> f64 {
	line_length(&polygon.shell) + polygon.holes.iter().map(|hole| line_length(hole)).sum::<f64>()
}

fn polygon_area(polygon: &Polygon) -> f64 {
	let mut area = ring_signed_area(&polygon.shell).abs();
	for hole in &polygon.holes {
		area -= ring_signed_area(hole).abs();
	}
	area
}

/// Returns JTS's `Length.ofLine`: the sum of `hypot` over consecutive points.
pub fn line_length(seq: &[Xy]) -> f64 {
	seq.windows(2)
		.map(|pair| (pair[1][0] - pair[0][0]).hypot(pair[1][1] - pair[0][1]))
		.sum()
}

/// Returns JTS's `Area.ofRingSigned`, positive for a ring that runs clockwise with y pointing up.
///
/// The shoelace sum is taken relative to the first x, in JTS's order of operations, so the sign of a near-zero area
/// matches.
pub fn ring_signed_area(ring: &[Xy]) -> f64 {
	let n = ring.len();
	if n < 3 {
		return 0.0;
	}
	let x0 = ring[0][0];
	let mut p1 = ring[0];
	let mut p2 = [ring[1][0] - x0, ring[1][1]];
	let mut sum = 0.0;
	for next in &ring[2..] {
		let p0y = p1[1];
		p1 = p2;
		p2 = [next[0] - x0, next[1]];
		sum += p1[0] * (p0y - p2[1]);
	}
	sum / 2.0
}

/// Returns true when `a`, `b`, `c` turn counter-clockwise with y pointing up, using Shewchuk's exact predicate where
/// JTS uses double-double arithmetic; both give the exact sign.
fn turns_counter_clockwise(a: Xy, b: Xy, c: Xy) -> bool {
	orient2d(
		Coord { x: a[0], y: a[1] },
		Coord { x: b[0], y: b[1] },
		Coord { x: c[0], y: c[1] },
	) > 0.0
}

/// Returns JTS's `Orientation.isCCW` for a closed ring: counter-clockwise with y pointing up.
///
/// The test finds the highest point reached by a rising segment and reads the turn there, so it handles flat caps and
/// repeated points as JTS does. A flat ring returns false.
pub fn is_ccw(ring: &[Xy]) -> bool {
	if ring.len() < 4 {
		return false;
	}
	let n = ring.len() - 1;
	let mut up_hi = ring[0];
	let mut prev_y = up_hi[1];
	let mut up_low = None;
	let mut i_up_hi = 0;
	for (i, point) in ring.iter().enumerate().take(n + 1).skip(1) {
		let py = point[1];
		if py > prev_y && py >= up_hi[1] {
			up_hi = *point;
			i_up_hi = i;
			up_low = Some(ring[i - 1]);
		}
		prev_y = py;
	}
	let Some(up_low) = up_low else {
		return false;
	};

	let mut i_down_low = i_up_hi;
	loop {
		i_down_low = (i_down_low + 1) % n;
		if i_down_low == i_up_hi || ring[i_down_low][1] != up_hi[1] {
			break;
		}
	}
	let down_low = ring[i_down_low];
	let i_down_hi = if i_down_low > 0 { i_down_low - 1 } else { n - 1 };
	let down_hi = ring[i_down_hi];

	if up_hi == down_hi {
		if up_low == up_hi || down_low == up_hi || up_low == down_low {
			return false;
		}
		turns_counter_clockwise(up_low, up_hi, down_low)
	} else {
		down_hi[0] - up_hi[0] < 0.0
	}
}

/// Builds a geometry from parts the way JTS's `GeometryFactory.buildGeometry` does.
///
/// An empty list yields an empty collection and a single part yields itself. Parts of one class combine into the
/// matching multi-geometry, where a ring counts as a line string. Parts of different classes, or any collection,
/// yield a collection.
pub fn build_geometry(mut parts: Vec<Geom>) -> Geom {
	if parts.is_empty() {
		return Geom::empty();
	}
	let class = |geom: &Geom| std::mem::discriminant(geom);
	let first = class(&parts[0]);
	let heterogeneous = parts.iter().any(|part| class(part) != first);
	let has_collection = parts.iter().any(|part| {
		matches!(
			part,
			Geom::Collection(_) | Geom::MultiPoint(_) | Geom::MultiLineString(_) | Geom::MultiPolygon(_)
		)
	});
	if heterogeneous || has_collection {
		return Geom::Collection(parts);
	}
	if parts.len() == 1 {
		return parts.pop().unwrap();
	}
	match &parts[0] {
		Geom::Polygon(_) => Geom::MultiPolygon(
			parts
				.into_iter()
				.map(|part| match part {
					Geom::Polygon(polygon) => polygon,
					_ => unreachable!(),
				})
				.collect(),
		),
		Geom::LineString(_) | Geom::LinearRing(_) => Geom::MultiLineString(
			parts
				.into_iter()
				.map(|part| match part {
					Geom::LineString(seq) => Line { seq, ring: false },
					Geom::LinearRing(seq) => Line { seq, ring: true },
					_ => unreachable!(),
				})
				.collect(),
		),
		Geom::Point(_) => Geom::MultiPoint(
			parts
				.into_iter()
				.map(|part| match part {
					Geom::Point(point) => point,
					_ => unreachable!(),
				})
				.collect(),
		),
		_ => Geom::Collection(parts),
	}
}

/// Rounds half toward positive infinity, as Java's `Math.round` does.
pub fn java_round(value: f64) -> f64 {
	let floor = value.floor();
	if value - floor >= 0.5 {
		floor + 1.0
	} else {
		floor
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn java_rounding_sends_ties_up() {
		assert_eq!(java_round(2.5), 3.0);
		assert_eq!(java_round(-2.5), -2.0);
		assert_eq!(java_round(0.49999999999999994), 0.0);
		assert_eq!(java_round(-0.5), 0.0);
	}

	#[test]
	fn signed_area_is_positive_for_clockwise_with_y_up() {
		let clockwise = vec![[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]];
		assert_eq!(ring_signed_area(&clockwise), 1.0);
		assert!(!is_ccw(&clockwise));
		let counter: Seq = clockwise.iter().rev().copied().collect();
		assert_eq!(ring_signed_area(&counter), -1.0);
		assert!(is_ccw(&counter));
	}

	#[test]
	fn rings_build_into_a_multilinestring_and_mixed_parts_into_a_collection() {
		let ring = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]];
		let built = build_geometry(vec![Geom::LinearRing(ring.clone()), Geom::LinearRing(ring.clone())]);
		assert!(matches!(built, Geom::MultiLineString(ref lines) if lines.len() == 2 && lines[0].ring));
		let mixed = build_geometry(vec![Geom::LineString(ring.clone()), Geom::LinearRing(ring)]);
		assert!(matches!(mixed, Geom::Collection(_)));
	}
}
