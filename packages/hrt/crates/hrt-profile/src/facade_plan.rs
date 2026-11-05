// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Adapted from Arnis (https://github.com/louis-e/arnis) at commit d8e8b662, Apache-2.0:
// `src/element_processing/building_facade.rs` (`compute_facade_plan`, `detect_street_corner`),
// `src/element_processing/buildings.rs` (`compute_outward_normal`, `outward_side`, the `RoofContext` `attached` and
// `enclosed` rules), `src/element_processing/highways.rs` (`highway_block_range`, `surface_highway_type`,
// `renders_as_highway_tunnel`, the road surface stamp) and `src/bresenham.rs`.
// Modifications: the grid is one cell per meter in a z14 tile's frame rather than a Minecraft world, roads come from
// OpenStreetMap lines the build reads, a tunnel is never drawn at the surface, and footprint cells come from an even-odd
// scanline test instead of Arnis's seeded flood fill.

//! Street and neighbor awareness for compact building tiles.
//!
//! Each building's exterior ring is classified edge by edge as a street, rear, party or open wall, on a grid of one cell
//! per meter that holds every footprint and road surface near one z14 tile. The facade shader reads the classes to place
//! shopfronts and lobbies on street walls and blank walls on party walls. The roof and wall style read `attached` and
//! `enclosed`.

use std::collections::HashSet;

/// Farthest outward distance, in meters, sampled when testing for a fronting street (Arnis at scale 1).
const STREET_SETBACK_MAX: i32 = 8;
/// Fraction of an edge's cells that must touch another footprint for the edge to be a party wall.
const PARTY_SEGMENT_MIN_FRACTION: f32 = 0.5;
/// Minimum length in meters of both legs of a street corner.
const CORNER_MIN_SEG_LEN: i32 = 6;
/// The widest half-width a road surface takes, in meters.
const MAX_BLOCK_RANGE: i32 = 8;
/// The most lanes a road's width counts.
const MAX_LANES: i32 = 16;

/// What a wall edge faces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FacadeClass {
	/// A road surface within the setback distance.
	Street = 0,
	/// No street on this side while another side has one.
	Rear = 1,
	/// Another building's footprint on at least half the edge.
	Party = 2,
	/// A free-standing side on a building with no street anywhere.
	Open = 3,
}

/// One edge's classification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SegmentFacade {
	pub class: FacadeClass,
	/// Nearest sampled road surface, in meters, on a street edge.
	pub road_dist: Option<i32>,
	/// The axis-snapped outward normal.
	pub normal: (i32, i32),
	/// The Chebyshev length in meters.
	pub len: i32,
}

/// A building's facade plan, with one entry per exterior ring edge.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FacadePlan {
	/// `segments[i]` covers vertex `i` to vertex `i + 1`, wrapping; `None` for an edge shorter than a meter.
	pub segments: Vec<Option<SegmentFacade>>,
	/// The street edge nearest a road, longer winning ties.
	pub front_segment: Option<usize>,
	/// The two consecutive street edges that meet at a convex street corner.
	pub corner: Option<(usize, usize)>,
	pub has_any_street: bool,
	/// Party edges total at least 4 m and at least 15% of the ring.
	pub attached: bool,
	/// At least 90% of the cells around the footprint belong to other footprints.
	pub enclosed: bool,
}

/// A road line for the road surface stamp: vertices in grid meters and its OpenStreetMap tags.
pub struct Road<'a> {
	pub points: Vec<(i32, i32)>,
	pub tags: &'a dyn Fn(&str) -> Option<String>,
}

/// The cells along a line from `(x1, z1)` to `(x2, z2)`, both ends included, as Arnis's `bresenham_line` walks them.
pub fn bresenham(x1: i32, z1: i32, x2: i32, z2: i32) -> Vec<(i32, i32)> {
	let dx = (x2 - x1).abs();
	let dz = (z2 - z1).abs();
	let xs = if x1 < x2 { 1 } else { -1 };
	let zs = if z1 < z2 { 1 } else { -1 };
	let mut points = Vec::with_capacity(dx.max(dz) as usize + 1);
	let (mut x, mut z) = (x1, z1);
	if dx >= dz {
		let mut p = 2 * dz - dx;
		while x != x2 {
			points.push((x, z));
			if p >= 0 {
				z += zs;
				p -= 2 * dx;
			}
			p += 2 * dz;
			x += xs;
		}
	} else {
		let mut p = 2 * dx - dz;
		while z != z2 {
			points.push((x, z));
			if p >= 0 {
				x += xs;
				p -= 2 * dz;
			}
			p += 2 * dx;
			z += zs;
		}
	}
	points.push((x2, z2));
	points
}

/// The highway type a road surface is stamped for, or `None` for a way the stamp skips.
pub fn surface_highway_type(tag: &dyn Fn(&str) -> Option<String>) -> Option<String> {
	let highway = tag("highway")?;
	if matches!(highway.as_str(), "street_lamp" | "crossing" | "bus_stop") {
		return None;
	}
	let is = |key: &str, value: &str| tag(key).is_some_and(|text| text == value);
	if is("area", "yes") || is("indoor", "yes") || is("aeroway", "jet_bridge") || is("man_made", "pier") {
		return None;
	}
	if tag("level").and_then(|level| level.parse::<i32>().ok()).is_some_and(|level| level < 0) {
		return None;
	}
	// Arnis bores a tunnel underground unless the terrain leaves no room; a map draws no terrain bore, so a tunnel is
	// never a surface.
	if is("tunnel", "yes") {
		return None;
	}
	Some(highway)
}

/// Lanes a highway type has when it states none.
fn default_lanes(highway: &str) -> i32 {
	match highway {
		"motorway" | "primary" | "trunk" | "secondary" | "tertiary" => 2,
		_ => 1,
	}
}

/// A road surface's half-width in meters, not counting its center cell.
pub fn highway_block_range(highway: &str, tag: &dyn Fn(&str) -> Option<String>) -> i32 {
	let construction = tag("construction");
	let highway = if highway == "construction" {
		construction.as_deref().unwrap_or(highway)
	} else {
		highway
	};
	let (mut range, scales_with_lanes) = match highway {
		"footway" | "pedestrian" | "path" | "cycleway" | "track" | "escape" | "steps" => (1, false),
		"motorway" | "primary" | "trunk" => (5, true),
		"secondary" => (4, true),
		"tertiary" | "service" => (2, true),
		"secondary_link" | "tertiary_link" => (1, true),
		// Arnis reads a raceway's half-width from its own table; 2 is its default road.
		_ => (2, true),
	};
	let lanes = tag("lanes")
		.and_then(|text| text.parse::<i32>().ok())
		.unwrap_or_else(|| default_lanes(highway))
		.clamp(1, MAX_LANES);
	let width = tag("width").and_then(|raw| {
		let text = raw.trim().trim_end_matches('m').trim().to_owned();
		text.parse::<f64>().ok().filter(|value| value.is_finite() && *value > 0.0)
	});
	if let Some(width) = width {
		range = (width / 2.0).round() as i32;
	} else if scales_with_lanes {
		let by_lanes = ((lanes as f32 * 3.5 - 1.0) / 2.0).round() as i32;
		range = range.max(by_lanes);
	}
	range.clamp(1, MAX_BLOCK_RANGE)
}

/// A bitmap over a square of grid cells.
pub struct Bitmap {
	min: (i32, i32),
	width: i32,
	height: i32,
	bits: Vec<u64>,
}

impl Bitmap {
	/// A bitmap covering `min` to `max`, both inclusive.
	pub fn new(min: (i32, i32), max: (i32, i32)) -> Self {
		let width = (max.0 - min.0 + 1).max(0);
		let height = (max.1 - min.1 + 1).max(0);
		let cells = width as usize * height as usize;
		Self {
			min,
			width,
			height,
			bits: vec![0; cells.div_ceil(64)],
		}
	}

	fn index(&self, x: i32, z: i32) -> Option<usize> {
		let (dx, dz) = (x - self.min.0, z - self.min.1);
		(dx >= 0 && dz >= 0 && dx < self.width && dz < self.height).then(|| dz as usize * self.width as usize + dx as usize)
	}

	pub fn set(&mut self, x: i32, z: i32) {
		if let Some(index) = self.index(x, z) {
			self.bits[index / 64] |= 1 << (index % 64);
		}
	}

	pub fn contains(&self, x: i32, z: i32) -> bool {
		self.index(x, z).is_some_and(|index| self.bits[index / 64] & (1 << (index % 64)) != 0)
	}
}

/// Stamps a road line's surface: each cell along each edge, widened by the half-width on both axes.
pub fn stamp_road(mask: &mut Bitmap, points: &[(i32, i32)], half_width: i32) {
	for pair in points.windows(2) {
		for (x, z) in bresenham(pair[0].0, pair[0].1, pair[1].0, pair[1].1) {
			for dx in -half_width..=half_width {
				for dz in -half_width..=half_width {
					mask.set(x + dx, z + dz);
				}
			}
		}
	}
}

/// The cells strictly inside a closed ring, by an even-odd scanline on the integer lattice. Cells on the ring itself
/// are left out, as Arnis's fill leaves them to the outline pass.
pub fn fill_cells(ring: &[(i32, i32)]) -> Vec<(i32, i32)> {
	if ring.len() < 3 {
		return Vec::new();
	}
	let closed: Vec<(i32, i32)> = ring.iter().copied().chain(std::iter::once(ring[0])).collect();
	let min_z = ring.iter().map(|p| p.1).min().unwrap();
	let max_z = ring.iter().map(|p| p.1).max().unwrap();
	let mut cells = Vec::new();
	let mut crossings: Vec<f64> = Vec::new();
	for z in min_z..=max_z {
		let zf = f64::from(z);
		crossings.clear();
		for pair in closed.windows(2) {
			let (x0, z0) = (f64::from(pair[0].0), f64::from(pair[0].1));
			let (x1, z1) = (f64::from(pair[1].0), f64::from(pair[1].1));
			if (z0 <= zf) == (z1 <= zf) {
				continue;
			}
			crossings.push(x0 + (zf - z0) / (z1 - z0) * (x1 - x0));
		}
		crossings.sort_unstable_by(f64::total_cmp);
		// A cell on a horizontal edge lies on the ring, which the ray test cannot see.
		let on_horizontal_edge = |x: i32| {
			closed.windows(2).any(|pair| {
				pair[0].1 == z && pair[1].1 == z && x >= pair[0].0.min(pair[1].0) && x <= pair[0].0.max(pair[1].0)
			})
		};
		for &[left, right] in crossings.as_chunks::<2>().0 {
			let start = left.floor() as i32 + 1;
			let end = right.ceil() as i32 - 1;
			for x in start..=end {
				if f64::from(x) > left && f64::from(x) < right && !on_horizontal_edge(x) {
					cells.push((x, z));
				}
			}
		}
	}
	cells
}

/// Which side of its edges a ring's outside lies on: the factor that turns each edge's left-hand normal outward.
fn outward_side(ring: &[(i32, i32)]) -> i32 {
	let mut area2 = 0i64;
	for i in 0..ring.len() {
		let j = (i + 1) % ring.len();
		area2 += i64::from(ring[i].0) * i64::from(ring[j].1) - i64::from(ring[j].0) * i64::from(ring[i].1);
	}
	if area2 > 0 {
		-1
	} else {
		1
	}
}

/// An edge's outward normal snapped to its dominant axis, or `(0, 0)` for a zero-length edge.
fn outward_normal(from: (i32, i32), to: (i32, i32), outward: i32) -> (i32, i32) {
	let (dx, dz) = (to.0 - from.0, to.1 - from.1);
	let (nx, nz) = (-dz * outward, dx * outward);
	if nx.abs() >= nz.abs() {
		(nx.signum(), 0)
	} else {
		(0, nz.signum())
	}
}

/// What a building's neighborhood holds: every footprint cell and every road surface cell near it.
pub struct Neighborhood<'a> {
	pub footprints: &'a Bitmap,
	pub roads: &'a Bitmap,
}

/// Classifies every edge of `ring`, a building's exterior in grid meters without its closing vertex. `own` holds the
/// cells of the building and of its part-group mates, which never count as a neighbor.
pub fn compute_facade_plan(ring: &[(i32, i32)], own: &HashSet<(i32, i32)>, near: &Neighborhood<'_>) -> FacadePlan {
	if ring.len() < 3 {
		return FacadePlan::default();
	}
	let outward = outward_side(ring);
	let foreign = |x: i32, z: i32| near.footprints.contains(x, z) && !own.contains(&(x, z));
	let mut segments: Vec<Option<SegmentFacade>> = Vec::with_capacity(ring.len());
	for i in 0..ring.len() {
		let (from, to) = (ring[i], ring[(i + 1) % ring.len()]);
		let normal = outward_normal(from, to, outward);
		if normal == (0, 0) {
			segments.push(None);
			continue;
		}
		let len = (to.0 - from.0).abs().max((to.1 - from.1).abs());
		let points = bresenham(from.0, from.1, to.0, to.1);
		let party_cells = points
			.iter()
			.filter(|(x, z)| (1..=2).any(|d| foreign(x + normal.0 * d, z + normal.1 * d)))
			.count();
		let party_fraction = party_cells as f32 / points.len() as f32;
		let samples: Vec<usize> = if points.len() > 24 {
			(0..points.len()).step_by(8).collect()
		} else {
			let n = points.len();
			let mut picks = vec![n / 4, n / 2, (3 * n) / 4];
			picks.dedup();
			picks
		};
		let mut hits = 0;
		let mut min_dist: Option<i32> = None;
		for &index in &samples {
			let (x, z) = points[index.min(points.len() - 1)];
			for d in 1..=STREET_SETBACK_MAX {
				let (px, pz) = (x + normal.0 * d, z + normal.1 * d);
				if near.roads.contains(px, pz) {
					hits += 1;
					min_dist = Some(min_dist.map_or(d, |nearest| nearest.min(d)));
					break;
				}
				// A neighbor in the way means the road behind it belongs to that building.
				if foreign(px, pz) {
					break;
				}
			}
		}
		let needed = if len < 6 { 1 } else { samples.len().div_ceil(2) };
		let is_street = hits >= needed && min_dist.is_some();
		let class = if party_fraction >= PARTY_SEGMENT_MIN_FRACTION {
			FacadeClass::Party
		} else if is_street {
			FacadeClass::Street
		} else {
			FacadeClass::Open
		};
		segments.push(Some(SegmentFacade {
			class,
			road_dist: if is_street { min_dist } else { None },
			normal,
			len,
		}));
	}
	let has_any_street = segments.iter().flatten().any(|segment| segment.class == FacadeClass::Street);
	if has_any_street {
		for segment in segments.iter_mut().flatten() {
			if segment.class == FacadeClass::Open {
				segment.class = FacadeClass::Rear;
			}
		}
	}
	let mut front_segment: Option<usize> = None;
	for (i, segment) in segments.iter().enumerate() {
		let Some(segment) = segment else { continue };
		if segment.class != FacadeClass::Street {
			continue;
		}
		let better = match front_segment.and_then(|j| segments[j].as_ref()) {
			None => true,
			Some(best) => match (segment.road_dist, best.road_dist) {
				(Some(a), Some(b)) => a < b || (a == b && segment.len > best.len),
				(Some(_), None) => true,
				_ => false,
			},
		};
		if better {
			front_segment = Some(i);
		}
	}
	let corner = street_corner(ring, &segments, own, near);
	let (mut party, mut total) = (0, 0);
	for segment in segments.iter().flatten() {
		total += segment.len;
		if segment.class == FacadeClass::Party {
			party += segment.len;
		}
	}
	let fill: HashSet<(i32, i32)> = fill_cells(ring).into_iter().collect();
	let (mut around, mut walled) = (0usize, 0usize);
	for &(x, z) in &fill {
		for cell in [(x + 1, z), (x - 1, z), (x, z + 1), (x, z - 1)] {
			if !fill.contains(&cell) {
				around += 1;
				if near.footprints.contains(cell.0, cell.1) {
					walled += 1;
				}
			}
		}
	}
	FacadePlan {
		segments,
		front_segment,
		corner,
		has_any_street,
		attached: party >= 4 && party * 100 >= total * 15,
		enclosed: around > 0 && walled * 10 >= around * 9,
	}
}

/// Two consecutive street edges with perpendicular normals, both at least 6 m, meeting at a convex vertex. The pair
/// nearest the road wins.
fn street_corner(
	ring: &[(i32, i32)],
	segments: &[Option<SegmentFacade>],
	own: &HashSet<(i32, i32)>,
	near: &Neighborhood<'_>,
) -> Option<(usize, usize)> {
	let mut best: Option<(i32, (usize, usize))> = None;
	for i in 0..segments.len() {
		let j = (i + 1) % segments.len();
		let (Some(a), Some(b)) = (&segments[i], &segments[j]) else {
			continue;
		};
		if a.class != FacadeClass::Street || b.class != FacadeClass::Street {
			continue;
		}
		if a.len < CORNER_MIN_SEG_LEN || b.len < CORNER_MIN_SEG_LEN {
			continue;
		}
		if a.normal.0 * b.normal.0 + a.normal.1 * b.normal.1 != 0 {
			continue;
		}
		let (vx, vz) = ring[j];
		let diagonal = (vx + a.normal.0 + b.normal.0, vz + a.normal.1 + b.normal.1);
		if own.contains(&diagonal) || near.footprints.contains(diagonal.0, diagonal.1) {
			continue;
		}
		let score = a.road_dist.unwrap_or(i32::MAX / 2) + b.road_dist.unwrap_or(i32::MAX / 2);
		if best.is_none_or(|(nearest, _)| score < nearest) {
			best = Some((score, (i, j)));
		}
	}
	best.map(|(_, pair)| pair)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn rect(x0: i32, z0: i32, x1: i32, z1: i32) -> Vec<(i32, i32)> {
		vec![(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
	}

	fn grid() -> Bitmap {
		Bitmap::new((-100, -100), (100, 100))
	}

	#[test]
	fn bresenham_matches_arnis_on_a_shallow_and_a_steep_line() {
		// Traced by hand through Arnis's `bresenham_line` with y fixed at 0.
		assert_eq!(bresenham(0, 0, 4, 1), [(0, 0), (1, 0), (2, 1), (3, 1), (4, 1)]);
		assert_eq!(bresenham(0, 0, 1, 3), [(0, 0), (0, 1), (1, 2), (1, 3)]);
		assert_eq!(bresenham(2, 2, 2, 2), [(2, 2)]);
	}

	#[test]
	fn fill_keeps_only_cells_strictly_inside() {
		let cells: HashSet<_> = fill_cells(&rect(0, 0, 3, 3)).into_iter().collect();
		assert_eq!(cells, HashSet::from([(1, 1), (2, 1), (1, 2), (2, 2)]));
	}

	#[test]
	fn a_road_south_of_a_house_makes_that_wall_the_street_and_the_rest_rear() {
		let ring = rect(0, 0, 20, 10);
		let mut roads = grid();
		stamp_road(&mut roads, &[(-50, 14), (50, 14)], 2);
		let mut footprints = grid();
		let own: HashSet<_> = fill_cells(&ring).into_iter().collect();
		for &(x, z) in &own {
			footprints.set(x, z);
		}
		let plan = compute_facade_plan(&ring, &own, &Neighborhood { footprints: &footprints, roads: &roads });
		let classes: Vec<_> = plan.segments.iter().map(|s| s.unwrap().class).collect();
		// Edges: north (0,0)-(20,0), east, south (20,10)-(0,10), west. The road surface starts 2 m south of the wall.
		assert_eq!(classes, [FacadeClass::Rear, FacadeClass::Rear, FacadeClass::Street, FacadeClass::Rear]);
		assert_eq!(plan.front_segment, Some(2));
		assert_eq!(plan.segments[2].unwrap().road_dist, Some(2));
		assert!(plan.has_any_street && !plan.attached && !plan.enclosed);
	}

	#[test]
	fn terraced_neighbors_make_party_walls_and_attach() {
		let left = rect(0, 0, 10, 20);
		let right = rect(10, 0, 20, 20);
		let mut footprints = grid();
		for cell in fill_cells(&left).into_iter().chain(fill_cells(&right)) {
			footprints.set(cell.0, cell.1);
		}
		let roads = grid();
		let own: HashSet<_> = fill_cells(&left).into_iter().collect();
		let plan = compute_facade_plan(&left, &own, &Neighborhood { footprints: &footprints, roads: &roads });
		let classes: Vec<_> = plan.segments.iter().map(|s| s.unwrap().class).collect();
		assert_eq!(classes, [FacadeClass::Open, FacadeClass::Party, FacadeClass::Open, FacadeClass::Open]);
		assert!(plan.attached);
		assert!(!plan.has_any_street);
	}

	#[test]
	fn two_perpendicular_street_walls_make_a_corner() {
		let ring = rect(0, 0, 20, 20);
		let mut roads = grid();
		stamp_road(&mut roads, &[(-50, 24), (50, 24)], 2);
		stamp_road(&mut roads, &[(24, -50), (24, 50)], 2);
		let mut footprints = grid();
		let own: HashSet<_> = fill_cells(&ring).into_iter().collect();
		for &(x, z) in &own {
			footprints.set(x, z);
		}
		let plan = compute_facade_plan(&ring, &own, &Neighborhood { footprints: &footprints, roads: &roads });
		// East edge (index 1) then south edge (index 2) meet at (20, 20).
		assert_eq!(plan.corner, Some((1, 2)));
	}

	#[test]
	fn a_road_half_width_follows_lanes_and_width() {
		let tags = |pairs: &'static [(&'static str, &'static str)]| {
			move |key: &str| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| (*v).to_owned())
		};
		assert_eq!(highway_block_range("residential", &tags(&[])), 2);
		assert_eq!(highway_block_range("primary", &tags(&[("lanes", "4")])), 7);
		assert_eq!(highway_block_range("primary", &tags(&[("width", "6 m")])), 3);
		assert_eq!(highway_block_range("footway", &tags(&[])), 1);
		assert_eq!(surface_highway_type(&tags(&[("highway", "primary"), ("tunnel", "yes")])), None);
	}
}
