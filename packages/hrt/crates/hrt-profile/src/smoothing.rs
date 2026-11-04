// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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

/// Rounds every corner of a closed ring, its first vertex included, and closes it again.
fn round_ring(closed: &[Xy], max_inset: f64, passes: usize) -> Vec<Xy> {
	if closed.len() < 4 {
		return closed.to_vec();
	}
	let mut ring = closed[..closed.len() - 1].to_vec();
	for _ in 0..passes {
		let n = ring.len();
		let mut out = Vec::with_capacity(n * 2);
		for i in 0..n {
			let previous = ring[(i + n - 1) % n];
			let next = ring[(i + 1) % n];
			out.push(towards(ring[i], previous, max_inset));
			out.push(towards(ring[i], next, max_inset));
		}
		ring = out;
	}
	ring.push(ring[0]);
	ring
}

/// The fork's `roundWorldPolygon`: rounds every corner of a polygon in world coordinates by `passes` capped passes,
/// moving each corner at most `max_inset_meters`. Any geometry other than one polygon, and a result GEOS finds invalid,
/// comes back unchanged.
pub fn round_world_polygon(geometry: &Geom, max_inset_meters: f64, passes: usize) -> Geom {
	use geos::Geom as _;
	let Geom::Polygon(polygon) = geometry else {
		return geometry.clone();
	};
	if polygon.shell.is_empty() {
		return geometry.clone();
	}
	let Some(centroid_y) = hrt_render::snap::to_geos(geometry)
		.ok()
		.and_then(|shape| shape.get_centroid().ok())
		.and_then(|centroid| centroid.get_y().ok())
	else {
		return geometry.clone();
	};
	// The 6-meter cap in world units, scaled to this call's cap, multiplied and divided in the Java order.
	let max_inset = max_inset_world_units(centroid_y) * max_inset_meters / MAX_INSET_METERS;
	let rounded = Geom::Polygon(hrt_render::Polygon {
		shell: round_ring(&polygon.shell, max_inset, passes),
		holes: polygon
			.holes
			.iter()
			.map(|hole| round_ring(hole, max_inset, passes))
			.collect(),
	});
	let valid = hrt_render::snap::to_geos(&rounded)
		.ok()
		.and_then(|shape| shape.is_valid().ok())
		.unwrap_or(false);
	if valid {
		rounded
	} else {
		geometry.clone()
	}
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
