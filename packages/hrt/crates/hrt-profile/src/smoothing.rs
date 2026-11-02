// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's feature/Smoothing.java (BSD-3-Clause, Protomaps).

//! Rounding road corners with three capped passes of Chaikin's algorithm.
//!
//! Each pass replaces every interior vertex with two points, one on each adjoining segment, a quarter of the way along
//! it but never more than 6 meters from the vertex. End vertices stay where they are, so junctions stay connected.

use std::f64::consts::PI;

use hrt_render::geom::{Geom, Line, Xy};
use hrt_render::java_math;

/// The farthest a replacement point sits from the vertex it replaces, in meters.
const MAX_INSET_METERS: f64 = 6.0;
const PASSES: usize = 3;
/// Meters per world unit at the equator.
const EQUATOR_METERS: f64 = 40_075_016.686;

// The Java functions are used where Java calls them: a last-bit difference in a smoothed point can change the vertex
// a later simplification keeps.
fn max_inset_world_units(world_y: f64) -> f64 {
	let latitude = java_math::atan(java_math::sinh(PI * (1.0 - 2.0 * world_y)));
	MAX_INSET_METERS / (EQUATOR_METERS * latitude.cos())
}

fn towards(from: Xy, to: Xy, max_inset: f64) -> Xy {
	let dx = to[0] - from[0];
	let dy = to[1] - from[1];
	let length = java_math::hypot(dx, dy);
	if length == 0.0 {
		return from;
	}
	let distance = (length * 0.25).min(max_inset);
	[from[0] + dx / length * distance, from[1] + dy / length * distance]
}

fn smooth(line: &[Xy]) -> Vec<Xy> {
	if line.len() < 3 {
		return line.to_vec();
	}
	let max_inset = max_inset_world_units(line[0][1]);
	let mut coords = line.to_vec();
	for _ in 0..PASSES {
		let mut out = Vec::with_capacity(coords.len() * 2);
		out.push(coords[0]);
		for window in coords.windows(3) {
			out.push(towards(window[1], window[0], max_inset));
			out.push(towards(window[1], window[2], max_inset));
		}
		out.push(coords[coords.len() - 1]);
		coords = out;
	}
	coords
}

/// The fork's `smoothWorldLine`: rounds the corners of a line or multi-line in world coordinates.
pub fn smooth_world_line(geometry: &Geom) -> Geom {
	match geometry {
		Geom::LineString(seq) => Geom::LineString(smooth(seq)),
		Geom::MultiLineString(lines) => Geom::MultiLineString(
			lines
				.iter()
				.map(|line| Line {
					seq: smooth(&line.seq),
					ring: false,
				})
				.collect(),
		),
		other => other.clone(),
	}
}
