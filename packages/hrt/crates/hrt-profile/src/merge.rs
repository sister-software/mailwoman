// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's FeatureMerge, Hilbert and VectorTile decoding (Apache-2.0, Copyright Michael Barry).

//! Planetiler's per-tile feature merges: lines with equal attributes joined end to end, and nearby polygons with
//! equal attributes unioned.
//!
//! Both work on a layer's features in one tile. Features are grouped by their exact attribute map in order of first
//! appearance; features of other geometry types pass through first, in their original order. A merged group keeps the
//! first feature's attributes and an id ending in 0, and its parts are ordered along a Hilbert curve by first vertex.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use geos::{BufferParams, Geom as _, Geometry, JoinStyle};
use hrt_e::Value;
use hrt_render::commands::{encode_geometry, VectorGeometry};
use hrt_render::geom::{
	build_geometry, is_ccw, java_round, ring_signed_area, Geom, GeometryType, Line, Polygon, Seq, Xy,
};
use hrt_render::snap::{from_geos, reverse, snap_and_fix_polygon, to_geos, SnapCounts};

use crate::line_merger::{merge_lines, LineMergerSettings};
use crate::TileFeature;

const EXTENT: f64 = 4096.0;
const SIZE: f64 = 256.0;

fn zig_zag_decode(value: u32) -> i32 {
	((value >> 1) as i32) ^ -((value & 1) as i32)
}

/// Decodes a feature's commands to tile pixels, as `VectorGeometry.decode` does.
///
/// Polygon rings are grouped by orientation: each ring turning the same way as the first starts a new polygon, and
/// each ring turning the other way is a hole in the polygon before it.
pub fn decode(geometry: &VectorGeometry) -> Geom {
	let scale = f64::from(4096u32 << geometry.scale) / SIZE;
	let commands = &geometry.commands;
	let mut sequences: Vec<Seq> = Vec::new();
	let (mut x, mut y, mut i, mut length, mut command) = (0i32, 0i32, 0usize, 0u32, 0u32);
	while i < commands.len() {
		if length == 0 {
			command = commands[i] & 7;
			length = commands[i] >> 3;
			i += 1;
		}
		if length > 0 {
			if command == 1 {
				sequences.push(Vec::new());
			}
			if command == 7 {
				if geometry.geom_type != GeometryType::Point {
					if let Some(sequence) = sequences.last_mut() {
						if let (Some(&first), Some(&last)) = (sequence.first(), sequence.last()) {
							if first != last {
								sequence.push(first);
							}
						}
					}
				}
				length -= 1;
				continue;
			}
			if i + 1 >= commands.len() {
				break;
			}
			x = x.wrapping_add(zig_zag_decode(commands[i]));
			y = y.wrapping_add(zig_zag_decode(commands[i + 1]));
			i += 2;
			length -= 1;
			if let Some(sequence) = sequences.last_mut() {
				sequence.push([f64::from(x) / scale, f64::from(y) / scale]);
			}
		}
	}
	match geometry.geom_type {
		GeometryType::Line => {
			let mut lines: Vec<Seq> = sequences.into_iter().filter(|sequence| sequence.len() > 1).collect();
			match lines.len() {
				0 => Geom::empty(),
				1 => Geom::LineString(lines.pop().unwrap()),
				_ => Geom::MultiLineString(lines.into_iter().map(|seq| Line { seq, ring: false }).collect()),
			}
		}
		GeometryType::Point => {
			let mut points: Vec<Xy> = sequences
				.iter()
				.filter_map(|sequence| sequence.first().copied())
				.collect();
			match points.len() {
				0 => Geom::empty(),
				1 => Geom::Point(points.pop().unwrap()),
				_ => Geom::MultiPoint(points),
			}
		}
		GeometryType::Polygon => {
			let mut polygons: Vec<Polygon> = Vec::new();
			let mut outer_ccw = None;
			for sequence in sequences {
				if !polygons.is_empty() && sequence.len() < 2 {
					continue;
				}
				let ccw = is_ccw(&sequence);
				let outer = *outer_ccw.get_or_insert(ccw);
				if ccw == outer || polygons.is_empty() {
					polygons.push(Polygon {
						shell: sequence,
						holes: Vec::new(),
					});
				} else {
					polygons.last_mut().unwrap().holes.push(sequence);
				}
			}
			match polygons.len() {
				0 => Geom::empty(),
				1 => Geom::Polygon(polygons.pop().unwrap()),
				_ => Geom::MultiPolygon(polygons),
			}
		}
		GeometryType::Unknown => Geom::empty(),
	}
}

fn interleave(mut value: u32) -> u32 {
	value = (value | (value << 8)) & 0x00FF_00FF;
	value = (value | (value << 4)) & 0x0F0F_0F0F;
	value = (value | (value << 2)) & 0x3333_3333;
	value = (value | (value << 1)) & 0x5555_5555;
	value
}

/// Planetiler's `Hilbert.hilbertXYToIndex`, with Java's 32-bit integer arithmetic.
pub fn hilbert_xy_to_index(level: u32, x: u32, y: u32) -> u64 {
	let x = x.wrapping_shl(16 - level);
	let y = y.wrapping_shl(16 - level);
	let a1 = x ^ y;
	let b1 = 0xFFFF ^ a1;
	let c1 = 0xFFFF ^ (x | y);
	let d1 = x & (y ^ 0xFFFF);
	let mut ha = a1 | (b1 >> 1);
	let mut hb = (a1 >> 1) ^ a1;
	let mut hc = ((c1 >> 1) ^ (b1 & (d1 >> 1))) ^ c1;
	let mut hd = ((a1 & (c1 >> 1)) ^ (d1 >> 1)) ^ d1;

	let (a2, b2, c2, d2) = (ha, hb, hc, hd);
	ha = (a2 & (a2 >> 2)) ^ (b2 & (b2 >> 2));
	hb = (a2 & (b2 >> 2)) ^ (b2 & ((a2 ^ b2) >> 2));
	hc ^= (a2 & (c2 >> 2)) ^ (b2 & (d2 >> 2));
	hd ^= (b2 & (c2 >> 2)) ^ ((a2 ^ b2) & (d2 >> 2));

	let (a3, b3, c3, d3) = (ha, hb, hc, hd);
	ha = (a3 & (a3 >> 4)) ^ (b3 & (b3 >> 4));
	hb = (a3 & (b3 >> 4)) ^ (b3 & ((a3 ^ b3) >> 4));
	hc ^= (a3 & (c3 >> 4)) ^ (b3 & (d3 >> 4));
	hd ^= (b3 & (c3 >> 4)) ^ ((a3 ^ b3) & (d3 >> 4));

	let (a4, b4, c4, d4) = (ha, hb, hc, hd);
	hc ^= (a4 & (c4 >> 8)) ^ (b4 & (d4 >> 8));
	hd ^= (b4 & (c4 >> 8)) ^ ((a4 ^ b4) & (d4 >> 8));

	let a = hc ^ (hc >> 1);
	let b = hd ^ (hd >> 1);
	let i0 = x ^ y;
	let i1 = b | (0xFFFF ^ (i0 | a));
	u64::from(((interleave(i1) << 1) | interleave(i0)) >> (32 - 2 * level))
}

fn first_coordinate(geom: &Geom) -> Option<Xy> {
	match geom {
		Geom::Point(point) => Some(*point),
		Geom::MultiPoint(points) => points.first().copied(),
		Geom::LineString(seq) | Geom::LinearRing(seq) => seq.first().copied(),
		Geom::MultiLineString(lines) => lines.iter().find_map(|line| line.seq.first().copied()),
		Geom::Polygon(polygon) => polygon.shell.first().copied(),
		Geom::MultiPolygon(polygons) => polygons.iter().find_map(|polygon| polygon.shell.first().copied()),
		Geom::Collection(parts) => parts.iter().find_map(first_coordinate),
	}
}

/// `VectorTile.hilbertIndex`: the position of the geometry's first vertex along a level-15 Hilbert curve.
pub fn hilbert_index(geom: &Geom) -> i32 {
	let Some([x, y]) = first_coordinate(geom) else {
		return 0;
	};
	let zig_zag = |value: f64| {
		let v = java_round(value * EXTENT / SIZE) as i32;
		(v.wrapping_shl(1) ^ (v >> 31)) as u32
	};
	hilbert_xy_to_index(15, zig_zag(x), zig_zag(y)) as i32
}

/// The id Planetiler gives a merged feature: the original with its last decimal digit set to 0.
fn merged_id(id: i64) -> i64 {
	(id / 10) * 10
}

fn same_attributes(a: &[(String, Value)], b: &[(String, Value)]) -> bool {
	a.len() == b.len() && a.iter().all(|entry| b.contains(entry))
}

/// Groups features of `geom_type` by attribute map in order of first appearance; others go to `passed`.
fn group_by_attributes(
	features: Vec<TileFeature>,
	geom_type: GeometryType,
	passed: &mut Vec<TileFeature>,
) -> Vec<Vec<TileFeature>> {
	let mut groups: Vec<Vec<TileFeature>> = Vec::new();
	// Groups are found by a hash of their attribute map, so a tile of thousands of distinctly named roads is not compared
	// against every earlier group. Attribute maps that `same_attributes` calls equal have the same hash.
	let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
	for feature in features {
		if feature.geometry.geom_type != geom_type {
			passed.push(feature);
			continue;
		}
		let candidates = by_hash.entry(attributes_hash(&feature.attributes)).or_default();
		match candidates
			.iter()
			.copied()
			.find(|&group| same_attributes(&groups[group][0].attributes, &feature.attributes))
		{
			Some(group) => groups[group].push(feature),
			None => {
				candidates.push(groups.len());
				groups.push(vec![feature]);
			}
		}
	}
	groups
}

/// A hash of an attribute map that ignores the order of its entries: the wrapping sum of each entry's hash.
///
/// Floats hash by the bits of the value plus zero, so 0.0 and -0.0, which compare equal, hash alike.
fn attributes_hash(attributes: &[(String, Value)]) -> u64 {
	attributes.iter().fold(0u64, |sum, (key, value)| {
		let mut hasher = DefaultHasher::new();
		key.hash(&mut hasher);
		match value {
			Value::String(text) => (0u8, text).hash(&mut hasher),
			Value::Float(number) => (1u8, (number + 0.0).to_bits()).hash(&mut hasher),
			Value::Double(number) => (2u8, (number + 0.0).to_bits()).hash(&mut hasher),
			Value::Int(number) => (3u8, number).hash(&mut hasher),
			Value::UInt(number) => (4u8, number).hash(&mut hasher),
			Value::Bool(flag) => (5u8, flag).hash(&mut hasher),
		}
		sum.wrapping_add(hasher.finish())
	})
}

fn with_geometry(feature: &TileFeature, id: i64, geom: &Geom) -> TileFeature {
	TileFeature {
		id,
		geometry: encode_geometry(geom, 0),
		attributes: feature.attributes.clone(),
	}
}

fn lines_of(geom: &Geom, out: &mut Vec<Seq>) {
	match geom {
		Geom::LineString(seq) | Geom::LinearRing(seq) => out.push(seq.clone()),
		Geom::MultiLineString(lines) => out.extend(lines.iter().map(|line| line.seq.clone())),
		Geom::Collection(parts) => parts.iter().for_each(|part| lines_of(part, out)),
		_ => {}
	}
}

/// Planetiler's `removeDetailOutsideTile`: drops runs of segments that lie wholly outside the tile plus `buffer`.
fn remove_detail_outside_tile(line: &Seq, buffer: f64, out: &mut Vec<Seq>) {
	let (min, max) = (-buffer, 256.0 + buffer);
	let intersects =
		|[ax, ay]: Xy, [bx, by]: Xy| !(ax.min(bx) > max || ax.max(bx) < min || ay.min(by) > max || ay.max(by) < min);
	let push = |current: &mut Seq, point: Xy| {
		if current.last() != Some(&point) {
			current.push(point);
		}
	};
	let mut current: Seq = Vec::new();
	let mut was_in = false;
	let mut point = line[0];
	for &next in &line[1..] {
		let now_in = intersects(point, next);
		if now_in || was_in {
			push(&mut current, point);
		} else if !current.is_empty() {
			if current.len() >= 2 {
				out.push(std::mem::take(&mut current));
			}
			current.clear();
		}
		was_in = now_in;
		point = next;
	}
	let last = line[line.len() - 1];
	if intersects(point, last) || was_in {
		push(&mut current, last);
	}
	if current.len() >= 2 {
		out.push(current);
	}
}

fn sort_by_hilbert<T>(items: Vec<T>, geom: impl Fn(&T) -> Geom) -> Vec<T> {
	let mut indexed: Vec<(i32, T)> = items
		.into_iter()
		.map(|item| (hilbert_index(&geom(&item)), item))
		.collect();
	indexed.sort_by_key(|(index, _)| *index);
	indexed.into_iter().map(|(_, item)| item).collect()
}

/// `FeatureMerge.mergeLineStrings(features, minLength, tolerance, buffer, resimplify)`. With `resimplify` false, the
/// four-argument Java overload, a lone line that needs no clipping or length filter passes through unsimplified.
pub fn merge_line_strings(
	features: Vec<TileFeature>,
	min_length: f64,
	tolerance: f64,
	buffer: f64,
	resimplify: bool,
) -> Vec<TileFeature> {
	let mut result = Vec::new();
	let groups = group_by_attributes(features, GeometryType::Line, &mut result);
	for group in groups {
		let first = &group[0];
		// A lone line skips the merger when it needs no clipping, length filter or resimplification.
		if group.len() == 1 && buffer <= 0.0 && min_length <= 0.0 && (!resimplify || tolerance <= 0.0) {
			result.push(first.clone());
			continue;
		}
		let mut lines = Vec::new();
		for feature in &group {
			lines_of(&decode(&feature.geometry), &mut lines);
		}
		let merged = merge_lines(
			&lines,
			LineMergerSettings {
				min_length,
				loop_min_length: min_length,
				stub_min_length: min_length.min(0.5),
				tolerance,
				merge_strokes: true,
			},
		);
		let mut segments = Vec::new();
		for line in &merged {
			if buffer >= 0.0 {
				remove_detail_outside_tile(line, buffer, &mut segments);
			} else {
				segments.push(line.clone());
			}
		}
		if segments.is_empty() {
			continue;
		}
		let segments = sort_by_hilbert(segments, |seq| Geom::LineString(seq.clone()));
		let geom = if segments.len() == 1 {
			Geom::LineString(segments.into_iter().next().unwrap())
		} else {
			Geom::MultiLineString(segments.into_iter().map(|seq| Line { seq, ring: false }).collect())
		};
		let id = if group.len() > 1 { merged_id(first.id) } else { first.id };
		result.push(with_geometry(first, id, &geom));
	}
	result
}

/// Buffer parameters with miter joins, as Planetiler's `FeatureMerge` sets them.
fn miter_params() -> geos::GResult<BufferParams> {
	let mut params = BufferParams::new()?;
	params.set_join_style(JoinStyle::Mitre)?;
	Ok(params)
}

/// The area of a geometry's bounding box, JTS's `getEnvelopeInternal().getArea()`; 0 for an empty geometry.
fn envelope_area(geom: &Geom) -> f64 {
	geom.envelope()
		.map_or(0.0, |[min_x, min_y, max_x, max_y]| (max_x - min_x) * (max_y - min_y))
}

/// `FeatureMerge.bufferUnionUnbuffer`: each polygon grown by `buffer` with miter joins, the union shrunk back.
fn buffer_union_unbuffer(buffer: f64, group: &[Geom]) -> geos::GResult<Geom> {
	let params = miter_params()?;
	let mut max_area_before: f64 = 0.0;
	let mut buffered = Vec::with_capacity(group.len());
	for geom in group {
		max_area_before = max_area_before.max(geom.area());
		buffered.push(to_geos(geom)?.buffer_with_params(buffer, &params)?);
	}
	let before_union = Geometry::create_geometry_collection(buffered)?;
	let union = match before_union.unary_union() {
		Ok(union) => union,
		Err(_) => before_union.make_valid()?.unary_union()?,
	};
	let mut merged = from_geos(&union.buffer_with_params(-buffer, &params)?)?;
	if max_area_before > 100.0 {
		let area_after = merged.area();
		if area_after < max_area_before * 0.95 {
			let second = from_geos(&before_union.buffer_with_params(-buffer, &params)?)?;
			let area_second = second.area();
			if area_second < max_area_before * 0.95 {
				let all =
					Geometry::create_geometry_collection(group.iter().map(to_geos).collect::<geos::GResult<_>>()?)?;
				return from_geos(&all.unary_union()?);
			}
			if area_second > area_after {
				merged = second;
			}
		}
	}
	Ok(merged)
}

fn is_fill(outer_area: f64, ring: &Seq) -> Option<f64> {
	const LEFT: u8 = 1;
	const RIGHT: u8 = 2;
	const TOP: u8 = 4;
	const BOTTOM: u8 = 8;
	if outer_area < 256.0 * 256.0 {
		return None;
	}
	let proposed = (outer_area.sqrt() - 256.0) / 2.0;
	let (min, max) = (-(proposed * 0.9), 256.0 + proposed * 0.9);
	let side = |[x, y]: Xy| {
		(if x < min {
			LEFT
		} else if x > max {
			RIGHT
		} else {
			0
		}) | (if y < min {
			TOP
		} else if y > max {
			BOTTOM
		} else {
			0
		})
	};
	let mut visited = 0;
	let mut next = side(ring[0]);
	for point in &ring[1..] {
		let current = next;
		visited |= current;
		next = side(*point);
		if current & next == 0 {
			return None;
		}
	}
	(visited == LEFT | RIGHT | TOP | BOTTOM).then_some(proposed)
}

fn fill_ring(buffer: f64) -> Seq {
	let (min, max) = (-buffer, buffer + 256.0);
	vec![[min, min], [max, min], [max, max], [min, max], [min, min]]
}

/// `FeatureMerge.extractPolygons`. Planetiler compares a hole's area against `min_area`, not `min_hole_area`, once
/// hole filtering is on; the port keeps that.
fn extract_polygons(geom: &Geom, out: &mut Vec<Polygon>, min_area: f64, min_hole_area: f64) {
	match geom {
		Geom::Polygon(polygon) => {
			let outer_area = ring_signed_area(&polygon.shell).abs();
			if outer_area <= min_area {
				return;
			}
			let holes: Vec<Seq> = polygon
				.holes
				.iter()
				.filter(|hole| min_hole_area <= 0.0 || ring_signed_area(hole).abs() > min_area)
				.cloned()
				.collect();
			let shell = match is_fill(outer_area, &polygon.shell) {
				Some(buffer) => fill_ring(buffer),
				None => polygon.shell.clone(),
			};
			out.push(Polygon { shell, holes });
		}
		Geom::MultiPolygon(polygons) => {
			for polygon in polygons {
				extract_polygons(&Geom::Polygon(polygon.clone()), out, min_area, min_hole_area);
			}
		}
		Geom::Collection(parts) => parts
			.iter()
			.for_each(|part| extract_polygons(part, out, min_area, min_hole_area)),
		_ => {}
	}
}

/// Lists, for each polygon, the indexes of the polygons within `distance` of it in ascending order, itself included.
///
/// Each polygon is converted to GEOS once. Polygons are swept in order of their boxes' west edges, and GEOS measures
/// the distance only for pairs whose boxes lie within `distance` of each other, because the distance between two
/// geometries is at least the gap between their boxes. A polygon without a box, which is empty, is measured against
/// every polygon. The lists equal those of measuring every pair.
fn adjacency_within(geometries: &[Geom], distance: f64) -> Vec<Vec<usize>> {
	let count = geometries.len();
	let converted: Vec<Option<Geometry>> = geometries.iter().map(|geom| to_geos(geom).ok()).collect();
	let within = |i: usize, j: usize| match (&converted[i], &converted[j]) {
		(Some(a), Some(b)) => a.distance(b).is_ok_and(|d| d <= distance),
		_ => false,
	};
	let boxes: Vec<Option<[f64; 4]>> = geometries.iter().map(Geom::envelope).collect();
	let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); count];

	let mut sweep: Vec<(usize, [f64; 4])> = boxes
		.iter()
		.enumerate()
		.filter_map(|(index, bounds)| bounds.map(|bounds| (index, bounds)))
		.collect();
	sweep.sort_by(|a, b| a.1[0].total_cmp(&b.1[0]));
	for (position, &(i, [_, min_y, max_x, max_y])) in sweep.iter().enumerate() {
		for &(j, [other_min_x, other_min_y, _, other_max_y]) in &sweep[position..] {
			if other_min_x > max_x + distance {
				break;
			}
			if other_min_y > max_y + distance || other_max_y < min_y - distance || !within(i, j) {
				continue;
			}
			adjacency[i].push(j);
			if i != j {
				adjacency[j].push(i);
			}
		}
	}
	for i in (0..count).filter(|&i| boxes[i].is_none()) {
		for j in 0..count {
			if within(i, j) {
				adjacency[i].push(j);
				if boxes[j].is_some() {
					adjacency[j].push(i);
				}
			}
		}
	}
	for neighbors in &mut adjacency {
		neighbors.sort_unstable();
	}
	adjacency
}

/// Groups polygons into clusters whose members lie within `min_distance` of another member, in Planetiler's order:
/// clusters by their lowest index, members in depth-first discovery order.
fn group_by_proximity(geometries: &[Geom], min_distance: f64) -> Vec<Vec<usize>> {
	let adjacency = adjacency_within(geometries, min_distance);
	let mut visited = vec![false; geometries.len()];
	let mut groups = Vec::new();
	for start in 0..geometries.len() {
		if visited[start] {
			continue;
		}
		visited[start] = true;
		let mut group = vec![start];
		let mut stack = vec![start];
		while let Some(node) = stack.pop() {
			for &next in &adjacency[node] {
				if !visited[next] {
					visited[next] = true;
					group.push(next);
					stack.push(next);
				}
			}
		}
		groups.push(group);
	}
	groups
}

/// `FeatureMerge.mergeNearbyPolygons(features, minArea, minHoleArea, minDist, buffer)`.
pub fn merge_nearby_polygons(
	features: Vec<TileFeature>,
	min_area: f64,
	min_hole_area: f64,
	min_distance: f64,
	buffer: f64,
	counts: &mut SnapCounts,
) -> Vec<TileFeature> {
	let mut result = Vec::new();
	let groups = group_by_attributes(features, GeometryType::Polygon, &mut result);
	for group in groups {
		let first = &group[0];
		let geometries: Vec<Geom> = group.iter().map(|feature| decode(&feature.geometry)).collect();
		let mut polygons: Vec<Polygon> = Vec::new();
		for members in group_by_proximity(&geometries, min_distance) {
			let merged = if members.len() > 1 {
				let member_geometries: Vec<Geom> = members.iter().map(|&index| geometries[index].clone()).collect();
				let merged = if buffer > 0.0 {
					buffer_union_unbuffer(buffer, &member_geometries)
				} else {
					to_geos(&build_geometry(member_geometries.clone()))
						.and_then(|collection| collection.buffer_with_params(buffer, &miter_params()?))
						.and_then(|geometry| from_geos(&geometry))
				};
				let Ok(merged) = merged else {
					continue;
				};
				if !merged.is_polygonal() || envelope_area(&merged) < min_area {
					continue;
				}
				match snap_and_fix_polygon(&merged, counts) {
					Ok(snapped) => reverse(&snapped),
					Err(_) => continue,
				}
			} else {
				let single = geometries[members[0]].clone();
				if !single.is_polygonal() || envelope_area(&single) < min_area {
					continue;
				}
				single
			};
			extract_polygons(&merged, &mut polygons, min_area, min_hole_area);
		}
		if polygons.is_empty() {
			continue;
		}
		let polygons = sort_by_hilbert(polygons, |polygon| Geom::Polygon(polygon.clone()));
		let geom = if polygons.len() == 1 {
			Geom::Polygon(polygons.into_iter().next().unwrap())
		} else {
			Geom::MultiPolygon(polygons)
		};
		let id = if group.len() > 1 { merged_id(first.id) } else { first.id };
		result.push(with_geometry(first, id, &geom));
	}
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	fn line_feature(id: i64, points: &[Xy]) -> TileFeature {
		TileFeature {
			id,
			geometry: encode_geometry(&Geom::LineString(points.to_vec()), 0),
			attributes: vec![("kind".into(), Value::String("river".into()))],
		}
	}

	#[test]
	fn two_touching_lines_merge_into_one_feature_with_a_merged_id() {
		let merged = merge_line_strings(
			vec![
				line_feature(12, &[[10.0, 10.0], [50.0, 10.0]]),
				line_feature(22, &[[50.0, 10.0], [90.0, 10.0]]),
			],
			0.5,
			0.2,
			4.0,
			false,
		);
		assert_eq!(merged.len(), 1);
		assert_eq!(merged[0].id, 10);
		assert_eq!(
			decode(&merged[0].geometry),
			Geom::LineString(vec![[10.0, 10.0], [90.0, 10.0]])
		);
	}

	#[test]
	fn features_group_by_attribute_map_in_order_of_first_appearance_whatever_the_entry_order() {
		let feature = |id: i64, attributes: &[(&str, Value)]| TileFeature {
			id,
			geometry: encode_geometry(&Geom::LineString(vec![[0.0, 0.0], [1.0, 1.0]]), 0),
			attributes: attributes
				.iter()
				.map(|(key, value)| (key.to_string(), value.clone()))
				.collect(),
		};
		let name = |text: &str| Value::String(text.into());
		let mut passed = Vec::new();
		let groups = group_by_attributes(
			vec![
				feature(1, &[("kind", name("road")), ("name", name("A"))]),
				feature(2, &[("kind", name("road")), ("name", name("B"))]),
				feature(3, &[("name", name("A")), ("kind", name("road"))]),
				feature(4, &[("width", Value::Double(-0.0))]),
				feature(5, &[("width", Value::Double(0.0))]),
				feature(6, &[("width", Value::Float(0.0))]),
			],
			GeometryType::Line,
			&mut passed,
		);
		let ids: Vec<Vec<i64>> = groups
			.iter()
			.map(|group| group.iter().map(|f| f.id).collect())
			.collect();
		assert_eq!(ids, vec![vec![1, 3], vec![2], vec![4, 5], vec![6]]);
		assert!(passed.is_empty());
	}

	#[test]
	fn the_box_sweep_finds_the_same_neighbors_as_measuring_every_pair() {
		// A deterministic scatter of squares and thin bars, some touching, some within the distance, some apart, plus an
		// empty polygon.
		let mut geometries = Vec::new();
		let mut seed: u64 = 7;
		let mut next = || {
			seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
			(seed >> 33) as f64 / f64::from(1u32 << 31)
		};
		for _ in 0..300 {
			let (x, y) = (next() * 400.0, next() * 400.0);
			let (w, h) = (0.5 + next() * 30.0, 0.5 + next() * 4.0);
			geometries.push(Geom::Polygon(Polygon {
				shell: vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
				holes: vec![],
			}));
		}
		geometries.push(Geom::MultiPolygon(vec![]));
		for distance in [0.0, 0.5, 3.0] {
			let swept = adjacency_within(&geometries, distance);
			let every_pair: Vec<Vec<usize>> = (0..geometries.len())
				.map(|i| {
					(0..geometries.len())
						.filter(|&j| match (to_geos(&geometries[i]), to_geos(&geometries[j])) {
							(Ok(a), Ok(b)) => a.distance(&b).is_ok_and(|d| d <= distance),
							_ => false,
						})
						.collect()
				})
				.collect();
			assert_eq!(swept, every_pair, "distance {distance}");
		}
	}

	#[test]
	fn hilbert_index_matches_planetiler_on_small_cases() {
		// Level-1 curve order: (0,0), (0,1), (1,1), (1,0).
		assert_eq!(hilbert_xy_to_index(1, 0, 0), 0);
		assert_eq!(hilbert_xy_to_index(1, 0, 1), 1);
		assert_eq!(hilbert_xy_to_index(1, 1, 1), 2);
		assert_eq!(hilbert_xy_to_index(1, 1, 0), 3);
	}

	#[test]
	fn nearby_squares_with_equal_attributes_union() {
		let square = |x0: f64| TileFeature {
			id: 31,
			geometry: encode_geometry(
				&reverse(&Geom::Polygon(Polygon {
					shell: vec![[x0, 10.0], [x0 + 20.0, 10.0], [x0 + 20.0, 30.0], [x0, 30.0], [x0, 10.0]],
					holes: vec![],
				})),
				0,
			),
			attributes: vec![("kind".into(), Value::String("water".into()))],
		};
		let mut counts = SnapCounts::default();
		// A 0.1 pixel gap closes under the 0.0625 pixel buffer applied to both sides.
		let merged = merge_nearby_polygons(vec![square(10.0), square(30.1)], 1.0, 1.0, 0.5, 0.0625, &mut counts);
		assert_eq!(merged.len(), 1);
		assert_eq!(merged[0].id, 30);
		assert!(matches!(decode(&merged[0].geometry), Geom::Polygon(_)));
		// A 0.25 pixel gap is within the grouping distance but wider than the buffer closes: one feature, two parts.
		let apart = merge_nearby_polygons(vec![square(10.0), square(30.25)], 1.0, 1.0, 0.5, 0.0625, &mut counts);
		assert_eq!(apart.len(), 1);
		assert!(matches!(decode(&apart[0].geometry), Geom::MultiPolygon(ref parts) if parts.len() == 2));
	}
}
