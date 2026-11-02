// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's VectorTile.CommandEncoder (Apache-2.0, Copyright Michael Barry).

//! Mapbox Vector Tile geometry commands, encoded as Planetiler encodes them.
//!
//! Coordinates arrive in tile pixels, 256 to a tile width, and are rounded to the 4096-unit extent times `2^scale`.
//! The pen position carries from one part of a feature to the next. A repeated point is dropped, and a ring's closing
//! point is replaced by `ClosePath`. A part left with fewer points than its type needs is removed and the pen restored.
//! Hole rings are held to the two-point minimum of a line rather than the polygon minimum of four.

use crate::geom::{java_round, Geom, GeometryType, Line, Xy};

const EXTENT: i32 = 4096;
const SIZE: f64 = 256.0;
const MOVE_TO: u32 = 1;
const LINE_TO: u32 = 2;
const CLOSE_PATH: u32 = 7;

/// An encoded geometry: its commands, its type, and the extra bits of precision `scale` it was encoded with.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct VectorGeometry {
	pub commands: Vec<u32>,
	pub geom_type: GeometryType,
	pub scale: u32,
}

fn command(id: u32, count: usize) -> u32 {
	((count as u32) << 3) | id
}

/// Zig-zag encodes a 32-bit value with Java's wrapping integer arithmetic.
pub fn zig_zag(value: i32) -> u32 {
	(value.wrapping_shl(1) ^ (value >> 31)) as u32
}

struct Encoder {
	out: Vec<u32>,
	scale: f64,
	x: i32,
	y: i32,
}

impl Encoder {
	fn accept(&mut self, geom: &Geom) {
		match geom {
			Geom::MultiLineString(lines) => {
				for Line { seq, .. } in lines {
					self.encode(seq, false, false, GeometryType::Line);
				}
			}
			Geom::Polygon(polygon) => {
				self.encode(&polygon.shell, true, false, GeometryType::Polygon);
				for hole in &polygon.holes {
					self.encode(hole, true, false, GeometryType::Line);
				}
			}
			Geom::MultiPolygon(polygons) => {
				for polygon in polygons {
					self.accept(&Geom::Polygon(polygon.clone()));
				}
			}
			Geom::LineString(seq) => self.encode(seq, false, false, GeometryType::Line),
			Geom::LinearRing(seq) => self.encode(seq, true, false, GeometryType::Line),
			Geom::Point(point) => self.encode(&[*point], false, false, GeometryType::Point),
			Geom::MultiPoint(points) => self.encode(points, false, true, GeometryType::Point),
			// Planetiler's encoder logs a geometry collection as unrecognized and writes no commands for it.
			Geom::Collection(_) => {}
		}
	}

	fn encode(&mut self, seq: &[Xy], close_path: bool, multi_point: bool, geom_type: GeometryType) {
		assert!(!seq.is_empty(), "empty geometry");
		let start = self.out.len();
		let (start_x, start_y) = (self.x, self.y);
		let mut points = 0;
		let mut line_to_index = 0;
		let mut line_to_length: i64 = 0;

		for (i, &[cx, cy]) in seq.iter().enumerate() {
			if i == 0 {
				self.out.push(command(MOVE_TO, if multi_point { seq.len() } else { 1 }));
			}
			let x = java_round(cx * self.scale) as i32;
			let y = java_round(cy * self.scale) as i32;
			if i > 0 && x == self.x && y == self.y && !multi_point {
				line_to_length -= 1;
				continue;
			}
			if close_path && seq.len() > 1 && i == seq.len() - 1 && seq[0] == [cx, cy] {
				line_to_length -= 1;
				continue;
			}
			self.out.push(zig_zag(x.wrapping_sub(self.x)));
			self.out.push(zig_zag(y.wrapping_sub(self.y)));
			points += 1;
			self.x = x;
			self.y = y;
			if i == 0 && seq.len() > 1 && !multi_point {
				line_to_index = self.out.len();
				line_to_length = seq.len() as i64 - 1;
				self.out.push(command(LINE_TO, line_to_length as usize));
			}
		}

		if line_to_index > 0 {
			if line_to_length == 0 {
				self.out.remove(line_to_index);
			} else {
				self.out[line_to_index] = command(LINE_TO, line_to_length as usize);
			}
		}
		if close_path {
			self.out.push(command(CLOSE_PATH, 1));
			points += 1;
		}
		if points < geom_type.min_points() {
			self.out.truncate(start);
			self.x = start_x;
			self.y = start_y;
		}
	}
}

/// Encodes `geom`, in tile pixels, at `2^scale` times the 4096-unit extent.
pub fn encode_geometry(geom: &Geom, scale: u32) -> VectorGeometry {
	let mut encoder = Encoder {
		out: Vec::new(),
		scale: f64::from(EXTENT << scale) / SIZE,
		x: 0,
		y: 0,
	};
	encoder.accept(geom);
	VectorGeometry {
		commands: encoder.out,
		geom_type: geom.geometry_type(),
		scale,
	}
}

fn zig_zag_decode(value: u32) -> i32 {
	((value >> 1) as i32) ^ -((value & 1) as i32)
}

/// Reduces a geometry encoded at `2^scale` times the extent back to the plain extent, as Planetiler's
/// `VectorTile.unscale` does before a line is written to a tile.
///
/// A point that rounds onto the previous one in a `LineTo` run is dropped by lowering the run's count, and a run that
/// loses every point is removed. A part left with fewer points than its type needs is removed when the next `MoveTo`
/// arrives or the geometry ends.
pub fn unscale(geometry: &VectorGeometry) -> VectorGeometry {
	if geometry.scale == 0 {
		return geometry.clone();
	}
	let commands = &geometry.commands;
	let min_points = geometry.geom_type.min_points();
	let factor = 2f64.powi(-(geometry.scale as i32));
	let mut out: Vec<u32> = Vec::with_capacity(commands.len());
	let (mut length, mut command, mut i) = (0i64, 0u32, 0usize);
	let (mut in_x, mut in_y, mut out_x, mut out_y, mut start_x, mut start_y) = (0i32, 0i32, 0i32, 0i32, 0i32, 0i32);
	let (mut length_index, mut move_to_index, mut points_in_shape) = (0usize, 0usize, 0usize);
	let mut first = true;

	while i < commands.len() {
		if length <= 0 {
			let header = commands[i];
			i += 1;
			length_index = out.len();
			out.push(header);
			command = header & 7;
			length = i64::from(header >> 3);
		}
		if length > 0 {
			if command == MOVE_TO {
				if !first && points_in_shape < min_points {
					let header = out[length_index];
					out.truncate(move_to_index);
					out.push(header);
					out_x = start_x;
					out_y = start_y;
				}
				points_in_shape = 0;
				start_x = out_x;
				start_y = out_y;
				move_to_index = out.len() - 1;
			}
			first = false;
			if command == CLOSE_PATH {
				points_in_shape += 1;
				length -= 1;
				continue;
			}
			let dx = zig_zag_decode(commands[i]);
			let dy = zig_zag_decode(commands[i + 1]);
			i += 2;
			length -= 1;
			in_x = in_x.wrapping_add(dx);
			in_y = in_y.wrapping_add(dy);
			let next_x = java_round(f64::from(in_x) * factor) as i32;
			let next_y = java_round(f64::from(in_y) * factor) as i32;
			if next_x == out_x && next_y == out_y && command == LINE_TO {
				let lowered = out[length_index] as i64 - 8;
				if lowered < 8 {
					out.truncate(length_index);
				} else {
					out[length_index] = lowered as u32;
				}
			} else {
				points_in_shape += 1;
				out.push(zig_zag(next_x - out_x));
				out.push(zig_zag(next_y - out_y));
				out_x = next_x;
				out_y = next_y;
			}
		}
	}
	if points_in_shape < min_points {
		out.truncate(move_to_index);
	}
	VectorGeometry {
		commands: out,
		geom_type: geometry.geom_type,
		scale: 0,
	}
}

/// Returns the square that covers a whole tile plus `buffer_pixels` on each side.
pub fn encode_fill(buffer_pixels: f64) -> VectorGeometry {
	let min = java_round(f64::from(EXTENT) * buffer_pixels / 256.0) as i32;
	let width = EXTENT + min + min;
	VectorGeometry {
		commands: vec![
			command(MOVE_TO, 1),
			zig_zag(-min),
			zig_zag(-min),
			command(LINE_TO, 3),
			zig_zag(width),
			0,
			0,
			zig_zag(width),
			zig_zag(-width),
			0,
			command(CLOSE_PATH, 1),
		],
		geom_type: GeometryType::Polygon,
		scale: 0,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::geom::Polygon;

	#[test]
	fn a_square_encodes_with_close_path_in_place_of_its_last_point() {
		let square = Geom::Polygon(Polygon {
			shell: vec![[0.0, 0.0], [0.0, 16.0], [16.0, 16.0], [16.0, 0.0], [0.0, 0.0]],
			holes: vec![],
		});
		let encoded = encode_geometry(&square, 0);
		assert_eq!(encoded.commands, vec![9, 0, 0, 26, 0, 512, 512, 0, 0, 511, 15]);
	}

	#[test]
	fn a_line_collapsing_to_one_point_is_dropped() {
		let line = Geom::LineString(vec![[0.0, 0.0], [0.001, 0.001]]);
		assert!(encode_geometry(&line, 0).commands.is_empty());
	}

	#[test]
	fn unscaling_rounds_and_drops_points_that_meet() {
		// A line encoded at scale 2: (0,0) -> (1,0) -> (8,0) in the plain extent's quarter units.
		let line = Geom::LineString(vec![[0.0, 0.0], [1.0 / 64.0, 0.0], [8.0 / 64.0, 0.0]]);
		let scaled = encode_geometry(&line, 2);
		assert_eq!(scaled.commands, vec![9, 0, 0, 18, 2, 0, 14, 0]);
		let plain = unscale(&scaled);
		// (1,0) rounds to (0,0) and is dropped; (8,0) becomes (2,0).
		assert_eq!(plain.commands, vec![9, 0, 0, 10, 4, 0]);
		assert_eq!(plain.scale, 0);
	}

	#[test]
	fn zig_zag_wraps_like_java_ints() {
		assert_eq!(zig_zag(-1), 1);
		assert_eq!(zig_zag(1), 2);
		assert_eq!(zig_zag(i32::MIN), u32::MAX);
	}
}
