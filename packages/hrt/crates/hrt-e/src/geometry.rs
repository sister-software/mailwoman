// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Geometry in tile coordinates and its command encoding.

use crate::proto::zigzag32;

const MOVE_TO: u32 = 1;
const LINE_TO: u32 = 2;
const CLOSE_PATH: u32 = 7;

/// A feature's geometry, in integer tile coordinates with the origin at the tile's top-left corner and y increasing
/// downward. Coordinates may lie outside `0..extent`, in the buffer around the tile.
#[derive(Clone, Debug, PartialEq)]
pub enum Geometry {
	/// One or more points.
	Points(Vec<[i32; 2]>),
	/// One or more lines, each of at least two distinct points.
	Lines(Vec<Vec<[i32; 2]>>),
	/// Polygons, each a list of rings: the exterior first, then its holes. A ring may repeat its first point at the end
	/// or not; the encoder closes it with a close-path command either way.
	Polygons(Vec<Vec<Vec<[i32; 2]>>>),
}

/// The geometry type field's value: 1 point, 2 line string, 3 polygon.
impl Geometry {
	pub(crate) fn type_code(&self) -> u64 {
		match self {
			Geometry::Points(_) => 1,
			Geometry::Lines(_) => 2,
			Geometry::Polygons(_) => 3,
		}
	}
}

fn command(id: u32, count: u32) -> u32 {
	(id & 0x7) | (count << 3)
}

/// Twice the signed area of a ring by the shoelace formula, in tile coordinates where y grows downward.
///
/// The specification requires an exterior ring's area to be positive by this formula and a hole's to be negative,
/// which on screen is a clockwise exterior.
fn twice_area(ring: &[[i32; 2]]) -> i64 {
	let mut sum = 0i64;

	for index in 0..ring.len() {
		let [x1, y1] = ring[index];
		let [x2, y2] = ring[(index + 1) % ring.len()];
		sum += i64::from(x1) * i64::from(y2) - i64::from(x2) * i64::from(y1);
	}

	sum
}

/// The ring's points without a repeated closing point and without consecutive duplicates.
fn open_ring(ring: &[[i32; 2]]) -> Vec<[i32; 2]> {
	let mut points: Vec<[i32; 2]> = Vec::with_capacity(ring.len());

	for &point in ring {
		if points.last() != Some(&point) {
			points.push(point);
		}
	}

	if points.len() > 1 && points.first() == points.last() {
		points.pop();
	}

	points
}

struct Cursor {
	x: i32,
	y: i32,
	commands: Vec<u32>,
}

impl Cursor {
	fn delta(&mut self, [x, y]: [i32; 2]) {
		self.commands.push(zigzag32(x - self.x));
		self.commands.push(zigzag32(y - self.y));
		self.x = x;
		self.y = y;
	}

	/// A move to the first point, then one line-to command covering the rest.
	fn path(&mut self, points: &[[i32; 2]]) {
		self.commands.push(command(MOVE_TO, 1));
		self.delta(points[0]);

		if points.len() > 1 {
			self.commands.push(command(LINE_TO, (points.len() - 1) as u32));
			for &point in &points[1..] {
				self.delta(point);
			}
		}
	}
}

/// The geometry's command integers, or an empty list when nothing drawable remains: a line shorter than two distinct
/// points, or a ring of fewer than three or with no area.
pub(crate) fn encode(geometry: &Geometry) -> Vec<u32> {
	let mut cursor = Cursor {
		x: 0,
		y: 0,
		commands: Vec::new(),
	};

	match geometry {
		Geometry::Points(points) => {
			if !points.is_empty() {
				cursor.commands.push(command(MOVE_TO, points.len() as u32));
				for &point in points {
					cursor.delta(point);
				}
			}
		}
		Geometry::Lines(lines) => {
			for line in lines {
				let mut points: Vec<[i32; 2]> = Vec::with_capacity(line.len());
				for &point in line {
					if points.last() != Some(&point) {
						points.push(point);
					}
				}

				if points.len() >= 2 {
					cursor.path(&points);
				}
			}
		}
		Geometry::Polygons(polygons) => {
			for polygon in polygons {
				for (index, ring) in polygon.iter().enumerate() {
					let mut points = open_ring(ring);
					let area = twice_area(&points);

					if points.len() < 3 || area == 0 {
						// A degenerate exterior drops the polygon with its holes; a degenerate hole drops only itself.
						if index == 0 {
							break;
						}
						continue;
					}

					let exterior = index == 0;
					if (area > 0) != exterior {
						points.reverse();
					}

					cursor.path(&points);
					cursor.commands.push(command(CLOSE_PATH, 1));
				}
			}
		}
	}

	cursor.commands
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn encodes_the_specification_examples() {
		// Vector tile specification 2.1, section 4.3.5.1: a point at (25, 17).
		assert_eq!(encode(&Geometry::Points(vec![[25, 17]])), vec![9, 50, 34]);

		// Section 4.3.5.3: a line from (2,2) through (2,10) to (10,10).
		assert_eq!(
			encode(&Geometry::Lines(vec![vec![[2, 2], [2, 10], [10, 10]]])),
			vec![9, 4, 4, 18, 0, 16, 16, 0]
		);

		// Section 4.3.5.5: a polygon (3,6), (8,12), (20,34).
		assert_eq!(
			encode(&Geometry::Polygons(vec![vec![vec![[3, 6], [8, 12], [20, 34], [3, 6]]]])),
			vec![9, 6, 12, 18, 10, 12, 24, 44, 15]
		);
	}

	#[test]
	fn orients_an_exterior_positive_and_a_hole_negative() {
		let counter_clockwise_square = vec![[0, 0], [0, 10], [10, 10], [10, 0]];
		let clockwise_hole = vec![[2, 2], [8, 2], [8, 8], [2, 8]];
		let commands = encode(&Geometry::Polygons(vec![vec![
			counter_clockwise_square,
			clockwise_hole,
		]]));

		// Decode the two rings back to absolute points and check their signed areas.
		let mut rings = Vec::new();
		let (mut x, mut y, mut index) = (0i32, 0i32, 0usize);
		let decode = |value: u32| ((value >> 1) as i32) ^ -((value & 1) as i32);

		while index < commands.len() {
			let id = commands[index] & 0x7;
			let count = commands[index] >> 3;
			index += 1;
			if id == MOVE_TO {
				rings.push(Vec::new());
			}
			if id == CLOSE_PATH {
				continue;
			}
			for _ in 0..count {
				x += decode(commands[index]);
				y += decode(commands[index + 1]);
				index += 2;
				rings.last_mut().unwrap().push([x, y]);
			}
		}

		assert!(twice_area(&rings[0]) > 0);
		assert!(twice_area(&rings[1]) < 0);
	}

	#[test]
	fn drops_a_degenerate_line_and_ring() {
		assert!(encode(&Geometry::Lines(vec![vec![[1, 1], [1, 1]]])).is_empty());
		assert!(encode(&Geometry::Polygons(vec![vec![vec![[0, 0], [5, 5], [10, 10]]]])).is_empty());
	}
}
