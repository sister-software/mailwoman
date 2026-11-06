// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// The rises and profiles are adapted from Arnis (https://github.com/louis-e/arnis) at commit d8e8b662, Apache-2.0,
// `src/element_processing/buildings.rs`: `generate_gabled_roof` and its `GableProfile`s, `generate_hipped_roof_inner`
// and `mansard_boost`, `generate_skillion_roof`, `generate_pyramidal_roof`, `generate_dome_roof`, `generate_cone_roof`
// and `onion_profile_radius`. Modifications: Arnis fills a height field over one-meter cells; this module builds the
// same surfaces as triangle meshes over the footprint, with the radial shapes as rings of the footprint scaled about
// its centroid, and the gable family on a four-vertex footprint only.

//! Roof meshes for compact building tiles.
//!
//! [`roof_mesh`] takes a footprint's exterior ring in meters, the wall height and a [`RoofSpec`], and returns the
//! roof's rise, its extra vertices with their heights above the eave, and its triangles. Triangle indexes below the
//! ring's vertex count name footprint vertices, which sit at the eave; the rest name extra vertices.

/// A roof shape as the record's roof shape byte stores it. The values differ from `hrt_facade::RoofType`'s order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RoofShape {
	Flat = 0,
	Gabled = 1,
	Hipped = 2,
	Pyramidal = 3,
	Dome = 4,
	Cone = 5,
	Onion = 6,
	Skillion = 7,
	Mansard = 8,
	Gambrel = 9,
	Round = 10,
	HalfHipped = 11,
}

/// What a roof's shape and size depend on besides the footprint.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RoofSpec {
	pub shape: RoofShape,
	/// A mapped `roof:height` in meters, which sets the rise.
	pub stated_rise: Option<f64>,
	/// A church gable, capped at 90% of the wall height rather than 60%.
	pub steep: bool,
	/// The downhill bearing of a skillion in degrees clockwise from north.
	pub skillion_bearing: f64,
	/// The height of a mansard's steep band in meters.
	pub mansard_steep: f64,
}

impl RoofSpec {
	/// A spec for `shape` with Arnis's defaults: no stated rise, a standard gable, a skillion falling south and a 4 m
	/// mansard band.
	pub fn of(shape: RoofShape) -> Self {
		Self {
			shape,
			stated_rise: None,
			steep: false,
			skillion_bearing: 180.0,
			mansard_steep: 4.0,
		}
	}
}

/// A roof above the eave.
#[derive(Clone, Debug, PartialEq)]
pub struct RoofMesh {
	/// The highest point above the eave, in meters.
	pub rise: f64,
	/// Extra vertices: position in meters and height above the eave in meters.
	pub extra: Vec<([f64; 2], f64)>,
	pub triangles: Vec<u32>,
}

/// Arnis's tallest inferred gable or hip, in meters.
const MAX_INFERRED_RISE: f64 = 9.0;
/// Segments of an onion's rings.
const ONION_SEGMENTS: usize = 16;
/// Rings of a dome between its eave and crown.
const DOME_RINGS: usize = 6;

fn lerp(a: [f64; 2], b: [f64; 2], t: f64) -> [f64; 2] {
	[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
	(a[0] - b[0]).hypot(a[1] - b[1])
}

/// The area centroid of a ring, or the vertex mean of a degenerate one.
fn centroid(ring: &[[f64; 2]]) -> [f64; 2] {
	let (mut area, mut cx, mut cy) = (0.0, 0.0, 0.0);
	for i in 0..ring.len() {
		let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
		let cross = a[0] * b[1] - b[0] * a[1];
		area += cross;
		cx += (a[0] + b[0]) * cross;
		cy += (a[1] + b[1]) * cross;
	}
	if area.abs() < 1e-9 {
		let n = ring.len() as f64;
		return [
			ring.iter().map(|p| p[0]).sum::<f64>() / n,
			ring.iter().map(|p| p[1]).sum::<f64>() / n,
		];
	}
	[cx / (3.0 * area), cy / (3.0 * area)]
}

/// The axis-aligned width and length of a ring.
fn extents(ring: &[[f64; 2]]) -> (f64, f64) {
	let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
	for p in ring {
		(x0, y0, x1, y1) = (x0.min(p[0]), y0.min(p[1]), x1.max(p[0]), y1.max(p[1]));
	}
	(x1 - x0, y1 - y0)
}

/// The rise cap Arnis puts on a gable or hip: 60% of the wall height, 90% for a church, and at most 9 m.
fn wall_cap(wall_height: f64, steep: bool) -> f64 {
	(wall_height * if steep { 0.9 } else { 0.6 })
		.round()
		.clamp(1.0, MAX_INFERRED_RISE)
}

/// A roof built from rings of the footprint scaled about its centroid: `rings` gives each ring's scale and height,
/// from the eave inward, and the last ring collapses to an apex when its scale is 0.
fn radial(ring: &[[f64; 2]], rings: &[(f64, f64)]) -> RoofMesh {
	let n = ring.len();
	let center = centroid(ring);
	let mut extra = Vec::new();
	let mut triangles = Vec::new();
	// The index of each ring's first vertex; the footprint is ring 0 at the eave.
	let mut previous: Option<u32> = None;
	for &(scale, height) in rings {
		if scale <= 1e-6 {
			let apex = (n + extra.len()) as u32;
			extra.push((center, height));
			for i in 0..n as u32 {
				let j = (i + 1) % n as u32;
				let (a, b) = previous.map_or((i, j), |start| (start + i, start + j));
				triangles.extend([a, b, apex]);
			}
			return RoofMesh {
				rise: rings.iter().map(|r| r.1).fold(0.0, f64::max),
				extra,
				triangles,
			};
		}
		let start = (n + extra.len()) as u32;
		for &p in ring {
			extra.push((lerp(center, p, scale), height));
		}
		for i in 0..n as u32 {
			let j = (i + 1) % n as u32;
			let (a, b) = previous.map_or((i, j), |prev| (prev + i, prev + j));
			triangles.extend([a, b, start + j, a, start + j, start + i]);
		}
		previous = Some(start);
	}
	// A ring that ends without an apex gets a flat lid.
	if let Some(start) = previous {
		for i in 1..n as u32 - 1 {
			triangles.extend([start, start + i, start + i + 1]);
		}
	}
	RoofMesh {
		rise: rings.iter().map(|r| r.1).fold(0.0, f64::max),
		extra,
		triangles,
	}
}

/// A roof mesh under construction over a footprint of `footprint` vertices, which take the first indexes.
struct Builder {
	footprint: u32,
	extra: Vec<([f64; 2], f64)>,
	triangles: Vec<u32>,
}

impl Builder {
	fn new(footprint: usize) -> Self {
		Self {
			footprint: footprint as u32,
			extra: Vec::new(),
			triangles: Vec::new(),
		}
	}

	fn push(&mut self, point: [f64; 2], height: f64) -> u32 {
		self.extra.push((point, height));
		self.footprint + self.extra.len() as u32 - 1
	}

	fn finish(self, rise: f64) -> RoofMesh {
		RoofMesh {
			rise,
			extra: self.extra,
			triangles: self.triangles,
		}
	}
}

/// A rectangle's corners with their vertex indexes, ordered so corner 0 to corner 1 runs along the ridge and corners
/// 3 and 2 lie across from 0 and 1.
type Corners = [([f64; 2], u32); 4];

/// The corners of a four-vertex footprint, turned so the first side is a long side.
fn footprint_corners(ring: &[[f64; 2]]) -> Corners {
	let start = if distance(ring[0], ring[1]) >= distance(ring[1], ring[2]) {
		0
	} else {
		1
	};
	std::array::from_fn(|offset| (ring[(start + offset) % 4], ((start + offset) % 4) as u32))
}

/// A gable-family roof over a rectangle: lines parallel to the ridge at the profile's breakpoints, `profile` giving
/// the height at each distance from the eave, up to the ridge at half the span. `close` says which ends get a gable
/// wall: an end shortened to a larger wing's ridge stays open. Returns the rise.
fn add_gable(
	builder: &mut Builder,
	c: Corners,
	breakpoints: &[f64],
	profile: &dyn Fn(f64) -> f64,
	close: (bool, bool),
) -> f64 {
	let short = distance(c[1].0, c[2].0).max(0.1);
	let half = short / 2.0;
	let mut distances: Vec<f64> = breakpoints.iter().copied().filter(|d| *d > 0.0 && *d < half).collect();
	distances.push(half);
	// Lines from the c0-c1 side toward the ridge, then from the c3-c2 side; the ridge is shared.
	let mut side_a = vec![(c[0].1, c[1].1)];
	for &d in &distances {
		let t = d / short;
		let a = builder.push(lerp(c[0].0, c[3].0, t), profile(d));
		let b = builder.push(lerp(c[1].0, c[2].0, t), profile(d));
		side_a.push((a, b));
	}
	let mut side_b = vec![(c[3].1, c[2].1)];
	for &d in &distances[..distances.len() - 1] {
		let t = d / short;
		let a = builder.push(lerp(c[3].0, c[0].0, t), profile(d));
		let b = builder.push(lerp(c[2].0, c[1].0, t), profile(d));
		side_b.push((a, b));
	}
	side_b.push(*side_a.last().unwrap());
	for side in [&side_a, &side_b] {
		for pair in side.windows(2) {
			let ((a0, a1), (b0, b1)) = (pair[0], pair[1]);
			builder.triangles.extend([a0, a1, b1, a0, b1, b0]);
		}
	}
	// Each closed end is a vertical polygon: a fan from its first eave corner up one side and down the other.
	for (end, closed) in [(0usize, close.0), (1, close.1)] {
		if !closed {
			continue;
		}
		let pick = |pair: (u32, u32)| if end == 0 { pair.0 } else { pair.1 };
		let outline: Vec<u32> = side_a
			.iter()
			.map(|&p| pick(p))
			.chain(side_b.iter().rev().skip(1).map(|&p| pick(p)))
			.collect();
		for k in 1..outline.len() - 1 {
			builder.triangles.extend([outline[0], outline[k], outline[k + 1]]);
		}
	}
	profile(half)
}

/// A hipped roof over a rectangle: the ridge runs from corner 0's end to corner 1's, each end pulled in by its inset.
fn add_hipped(builder: &mut Builder, c: Corners, rise: f64, insets: (f64, f64)) {
	let long = distance(c[0].0, c[1].0).max(0.1);
	let direction = [(c[1].0[0] - c[0].0[0]) / long, (c[1].0[1] - c[0].0[1]) / long];
	let (low, high) = (insets.0.clamp(0.0, long / 2.0), insets.1.clamp(0.0, long / 2.0));
	let (m0, m1) = (lerp(c[3].0, c[0].0, 0.5), lerp(c[1].0, c[2].0, 0.5));
	let r0 = builder.push([m0[0] + direction[0] * low, m0[1] + direction[1] * low], rise);
	let r1 = builder.push([m1[0] - direction[0] * high, m1[1] - direction[1] * high], rise);
	let [i0, i1, i2, i3] = c.map(|corner| corner.1);
	builder
		.triangles
		.extend([i0, i1, r1, i0, r1, r0, i2, i3, r0, i2, r0, r1, i3, i0, r0, i1, i2, r1]);
}

/// A gable-family roof on a four-vertex footprint.
fn gable(ring: &[[f64; 2]], breakpoints: &[f64], profile: &dyn Fn(f64) -> f64) -> RoofMesh {
	let mut builder = Builder::new(4);
	let rise = add_gable(
		&mut builder,
		footprint_corners(ring),
		breakpoints,
		profile,
		(true, true),
	);
	builder.finish(rise)
}

/// A hipped roof on a four-vertex footprint, each ridge end pulled in by `inset`.
fn hipped(ring: &[[f64; 2]], rise: f64, inset: f64) -> RoofMesh {
	let mut builder = Builder::new(4);
	add_hipped(&mut builder, footprint_corners(ring), rise, (inset, inset));
	builder.finish(rise)
}

/// One rectangular wing of a footprint in its frame, roofed along its own ridge. Arnis's `RoofWing`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Wing {
	u: (f64, f64),
	v: (f64, f64),
	/// The ridge runs along `u`, else along `v`.
	along_u: bool,
	/// Ridge ends shortened to the ridge of a larger wing this one runs into.
	clipped: (bool, bool),
}

impl Wing {
	fn along(&self) -> (f64, f64) {
		if self.along_u {
			self.u
		} else {
			self.v
		}
	}

	fn across(&self) -> (f64, f64) {
		if self.along_u {
			self.v
		} else {
			self.u
		}
	}

	fn length(&self) -> f64 {
		self.along().1 - self.along().0
	}

	fn area(&self) -> f64 {
		(self.u.1 - self.u.0) * (self.v.1 - self.v.0)
	}
}

/// The length-weighted dominant edge angle in radians, folded to (-45, 45] degrees. Arnis's `dominant_axis_angle`.
fn dominant_axis_angle(ring: &[[f64; 2]]) -> f64 {
	let (mut sum_c, mut sum_s) = (0.0, 0.0);
	for i in 0..ring.len() {
		let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
		let (dx, dz) = (b[0] - a[0], b[1] - a[1]);
		let len = dx.hypot(dz);
		if len < 3.0 {
			continue;
		}
		let angle = dz.atan2(dx);
		sum_c += len * (4.0 * angle).cos();
		sum_s += len * (4.0 * angle).sin();
	}
	if sum_c == 0.0 && sum_s == 0.0 {
		return 0.0;
	}
	sum_s.atan2(sum_c) / 4.0
}

/// Wall lines along one axis merged into the lines of a coarse grid: lines within 2 m of each other are one wall with
/// a jog. `None` for fewer than two grid lines or more than a dozen. Arnis's `merge_wall_lines`.
fn merge_wall_lines(mut lines: Vec<(f64, f64)>) -> Option<Vec<f64>> {
	lines.sort_by(|a, b| a.0.total_cmp(&b.0));
	let mut groups: Vec<Vec<(f64, f64)>> = Vec::new();
	for line in lines {
		match groups.last_mut() {
			Some(group) if line.0 - group[group.len() - 1].0 <= 2.0 && line.0 - group[0].0 <= 3.0 => group.push(line),
			_ => groups.push(vec![line]),
		}
	}
	let n = groups.len();
	if !(2..=12).contains(&n) {
		return None;
	}
	Some(
		groups
			.iter()
			.enumerate()
			.map(|(i, group)| {
				if i == 0 {
					group.iter().map(|l| l.0).fold(f64::MAX, f64::min)
				} else if i == n - 1 {
					group.iter().map(|l| l.0).fold(f64::MIN, f64::max)
				} else {
					let weight: f64 = group.iter().map(|l| l.1).sum();
					group.iter().map(|l| l.0 * l.1).sum::<f64>() / weight.max(1e-9)
				}
			})
			.collect(),
	)
}

/// Whether a point lies inside a ring, by ray crossing. Arnis's `polygon_contains`.
fn polygon_contains(ring: &[(f64, f64)], x: f64, z: f64) -> bool {
	let mut inside = false;
	for i in 0..ring.len() {
		let ((x0, z0), (x1, z1)) = (ring[i], ring[(i + 1) % ring.len()]);
		if (z0 > z) != (z1 > z) && x0 + (z - z0) * (x1 - x0) / (z1 - z0) > x {
			inside = !inside;
		}
	}
	inside
}

/// Splits an L, T, U or other right-angled footprint into overlapping rectangular wings, each roofed along its own
/// length, with a wing that runs into a longer perpendicular wing shortened to that wing's ridge. `None` for a plain
/// rectangle, a footprint with long oblique walls, one too intricate to split, or wings that all run one way.
/// Arnis's `roof_wings`, on a footprint without courtyards. Returns the frame angle and the wings.
fn roof_wings(ring: &[[f64; 2]]) -> Option<(f64, Vec<Wing>)> {
	if ring.len() < 6 {
		return None;
	}
	let mut angle = dominant_axis_angle(ring);
	if angle.to_degrees().abs() < 1.0 {
		angle = 0.0;
	}
	let (c, s) = (angle.cos(), angle.sin());
	let uv: Vec<(f64, f64)> = ring
		.iter()
		.map(|p| (p[0] * c + p[1] * s, -p[0] * s + p[1] * c))
		.collect();
	let skew = 15f64.to_radians().tan();
	let (mut u_lines, mut v_lines) = (Vec::new(), Vec::new());
	let (mut perimeter, mut oblique) = (0.0, 0.0);
	for i in 0..uv.len() {
		let (a, b) = (uv[i], uv[(i + 1) % uv.len()]);
		let (du, dv) = (b.0 - a.0, b.1 - a.1);
		let len = du.hypot(dv);
		if len < 0.5 {
			continue;
		}
		perimeter += len;
		if dv.abs() <= du.abs() * skew {
			v_lines.push(((a.1 + b.1) / 2.0, len));
		} else if du.abs() <= dv.abs() * skew {
			u_lines.push(((a.0 + b.0) / 2.0, len));
		} else {
			oblique += len;
		}
	}
	if perimeter <= 0.0 || oblique > 0.15 * perimeter {
		return None;
	}
	let us = merge_wall_lines(u_lines)?;
	let vs = merge_wall_lines(v_lines)?;
	let (nu, nv) = (us.len() - 1, vs.len() - 1);
	let occupied: Vec<bool> = (0..nv)
		.flat_map(|j| (0..nu).map(move |i| (i, j)))
		.map(|(i, j)| polygon_contains(&uv, (us[i] + us[i + 1]) / 2.0, (vs[j] + vs[j + 1]) / 2.0))
		.collect();
	let mut prefix = vec![0i32; (nu + 1) * (nv + 1)];
	for j in 0..nv {
		for i in 0..nu {
			prefix[(j + 1) * (nu + 1) + i + 1] =
				i32::from(occupied[j * nu + i]) + prefix[j * (nu + 1) + i + 1] + prefix[(j + 1) * (nu + 1) + i]
					- prefix[j * (nu + 1) + i];
		}
	}
	let full = |i0: usize, i1: usize, j0: usize, j1: usize| -> bool {
		let sum =
			prefix[(j1 + 1) * (nu + 1) + i1 + 1] - prefix[j0 * (nu + 1) + i1 + 1] - prefix[(j1 + 1) * (nu + 1) + i0]
				+ prefix[j0 * (nu + 1) + i0];
		sum == ((i1 - i0 + 1) * (j1 - j0 + 1)) as i32
	};
	if full(0, nu - 1, 0, nv - 1) {
		return None;
	}
	type Rect = (usize, usize, usize, usize);
	let mut rects: Vec<Rect> = Vec::new();
	for i0 in 0..nu {
		for i1 in i0..nu {
			for j0 in 0..nv {
				for j1 in j0..nv {
					if !full(i0, i1, j0, j1) {
						break;
					}
					let grows = (i0 > 0 && full(i0 - 1, i1, j0, j1))
						|| (i1 + 1 < nu && full(i0, i1 + 1, j0, j1))
						|| (j0 > 0 && full(i0, i1, j0 - 1, j1))
						|| (j1 + 1 < nv && full(i0, i1, j0, j1 + 1));
					if !grows {
						rects.push((i0, i1, j0, j1));
					}
				}
			}
		}
	}
	let cell_area = |i: usize, j: usize| (us[i + 1] - us[i]) * (vs[j + 1] - vs[j]);
	let mut covered = vec![false; nu * nv];
	let mut chosen: Vec<Rect> = Vec::new();
	loop {
		let gain = |r: &Rect| -> f64 {
			let mut gain = 0.0;
			for j in r.2..=r.3 {
				for i in r.0..=r.1 {
					if !covered[j * nu + i] {
						gain += cell_area(i, j);
					}
				}
			}
			gain
		};
		let Some(best) = rects
			.iter()
			.filter(|r| !chosen.contains(r))
			.max_by(|a, b| gain(a).total_cmp(&gain(b)))
			.copied()
		else {
			break;
		};
		if gain(&best) <= 0.0 {
			break;
		}
		chosen.push(best);
		if chosen.len() > 8 {
			return None;
		}
		for j in best.2..=best.3 {
			for i in best.0..=best.1 {
				covered[j * nu + i] = true;
			}
		}
	}
	if (0..nu * nv).any(|k| occupied[k] && !covered[k]) {
		return None;
	}
	let mut k = chosen.len();
	while k > 0 {
		k -= 1;
		let r = chosen[k];
		let redundant = (r.2..=r.3).all(|j| {
			(r.0..=r.1).all(|i| {
				chosen
					.iter()
					.enumerate()
					.any(|(m, o)| m != k && (o.0..=o.1).contains(&i) && (o.2..=o.3).contains(&j))
			})
		});
		if redundant {
			chosen.remove(k);
		}
	}
	if chosen.len() < 2 {
		return None;
	}
	let mut wings: Vec<Wing> = chosen
		.iter()
		.map(|r| {
			let (u, v) = ((us[r.0], us[r.1 + 1]), (vs[r.2], vs[r.3 + 1]));
			Wing {
				u,
				v,
				along_u: u.1 - u.0 >= v.1 - v.0,
				clipped: (false, false),
			}
		})
		.collect();
	if wings.iter().all(|w| w.along_u == wings[0].along_u) {
		return None;
	}
	let snapshot = wings.clone();
	let dominates = |s: usize, r: usize| -> bool {
		let (a, b) = (&snapshot[s], &snapshot[r]);
		if (a.length() - b.length()).abs() > 0.5 {
			a.length() > b.length()
		} else if (a.area() - b.area()).abs() > 0.5 {
			a.area() > b.area()
		} else {
			s < r
		}
	};
	for r in 0..snapshot.len() {
		let (ra0, ra1) = snapshot[r].along();
		let (rb0, rb1) = snapshot[r].across();
		let (mut lo, mut hi) = (None::<f64>, None::<f64>);
		for s in 0..snapshot.len() {
			if s == r || snapshot[s].along_u == snapshot[r].along_u || !dominates(s, r) {
				continue;
			}
			let (sa0, sa1) = snapshot[s].along();
			if sa0 > rb0 + 0.5 || sa1 < rb1 - 0.5 {
				continue;
			}
			let (sc0, sc1) = snapshot[s].across();
			let ridge = (sc0 + sc1) / 2.0;
			if ra1 <= sc1 + 0.5 && ra1 > ridge && ra0 < ridge {
				hi = Some(hi.map_or(ridge, |h| h.max(ridge)));
			}
			if ra0 >= sc0 - 0.5 && ra0 < ridge && ra1 > ridge {
				lo = Some(lo.map_or(ridge, |l| l.min(ridge)));
			}
		}
		let (a0, a1) = (lo.unwrap_or(ra0), hi.unwrap_or(ra1));
		if a1 - a0 < 1.0 {
			continue;
		}
		let wing = &mut wings[r];
		if wing.along_u {
			wing.u = (a0, a1);
		} else {
			wing.v = (a0, a1);
		}
		wing.clipped = (lo.is_some(), hi.is_some());
	}
	Some((angle, wings))
}

/// The roof of a footprint split into wings: each wing a rectangle roofed by `roof`, its corners new vertices at the
/// eave. Where wings overlap, the higher roof covers the lower, which forms the valleys Arnis takes as the highest
/// sample of each cell.
fn winged(
	footprint: usize,
	angle: f64,
	wings: &[Wing],
	roof: &dyn Fn(&mut Builder, Corners, &Wing) -> f64,
) -> RoofMesh {
	let (c, s) = (angle.cos(), angle.sin());
	let to_xy = |u: f64, v: f64| [u * c - v * s, u * s + v * c];
	let mut builder = Builder::new(footprint);
	let mut rise: f64 = 0.0;
	for wing in wings {
		let (u, v) = (wing.u, wing.v);
		// Corner 0 to corner 1 runs along the ridge, from the wing's low end to its high end.
		let points = if wing.along_u {
			[to_xy(u.0, v.0), to_xy(u.1, v.0), to_xy(u.1, v.1), to_xy(u.0, v.1)]
		} else {
			[to_xy(u.0, v.0), to_xy(u.0, v.1), to_xy(u.1, v.1), to_xy(u.1, v.0)]
		};
		let corners: Corners = std::array::from_fn(|k| (points[k], builder.push(points[k], 0.0)));
		rise = rise.max(roof(&mut builder, corners, wing));
	}
	builder.finish(rise)
}

/// An onion's radius over the footprint's half-width at relative height `t`, Arnis's `onion_profile_radius`.
pub fn onion_profile_radius(t: f64) -> f64 {
	if t < 0.05 {
		1.0
	} else if t < 0.15 {
		1.0 - (t - 0.05) / 0.10 * 0.45
	} else if t < 0.55 {
		0.55 + ((t - 0.15) / 0.40 * std::f64::consts::PI).sin() * 0.65
	} else if t < 0.78 {
		0.55 - (t - 0.55) / 0.23 * 0.37
	} else {
		(0.18 * (1.0 - (t - 0.78) / 0.22)).max(0.0)
	}
}

/// The roof over `ring`, an exterior ring in meters without its closing vertex, on walls `wall_height` meters tall,
/// or `None` for a flat roof or a shape the footprint cannot take.
pub fn roof_mesh(ring: &[[f64; 2]], has_holes: bool, wall_height: f64, spec: &RoofSpec) -> Option<RoofMesh> {
	if spec.shape == RoofShape::Flat || has_holes || ring.len() < 3 {
		return None;
	}
	let (width, length) = extents(ring);
	let (half_w, half_l) = ((width / 2.0).max(1.0), (length / 2.0).max(1.0));
	let four = ring.len() == 4;
	let short_half = if four {
		let start = if distance(ring[0], ring[1]) >= distance(ring[1], ring[2]) {
			0
		} else {
			1
		};
		distance(ring[(start + 1) % 4], ring[(start + 2) % 4]) / 2.0
	} else {
		half_w.min(half_l)
	};
	let cap = spec.stated_rise.unwrap_or_else(|| wall_cap(wall_height, spec.steep));
	// An L, T or U footprint takes a ridge per wing for the gable family, as Arnis's `roof_wings` gives it. Arnis
	// roofs a hipped footprint of more than four corners from each cell's distance to the walls. Hipped wings stand in
	// for that here.
	let wings = (!four).then(|| roof_wings(ring)).flatten().filter(|_| {
		matches!(
			spec.shape,
			RoofShape::Gabled | RoofShape::Gambrel | RoofShape::HalfHipped | RoofShape::Hipped
		)
	});
	if let Some((angle, wings)) = wings {
		let shape = spec.shape;
		return Some(winged(ring.len(), angle, &wings, &move |builder, corners, wing| {
			let half = (wing.across().1 - wing.across().0) / 2.0;
			match shape {
				RoofShape::Gambrel => {
					let top = if cap >= 4.0 { 2.0 + (cap - 4.0) } else { cap / 2.0 };
					add_gable(
						builder,
						corners,
						&[2.0, top],
						&|d| (2.0 * d.min(2.0) + (d - 2.0).max(0.0)).min(cap),
						(!wing.clipped.0, !wing.clipped.1),
					)
				}
				RoofShape::Hipped | RoofShape::HalfHipped => {
					let rise = half.min(cap);
					let inset = if shape == RoofShape::Hipped {
						half
					} else {
						rise - (cap / 2.0).max(2.0).min(rise)
					};
					let end = |clipped: bool| if clipped { 0.0 } else { inset };
					add_hipped(builder, corners, rise, (end(wing.clipped.0), end(wing.clipped.1)));
					rise
				}
				_ => add_gable(
					builder,
					corners,
					&[cap],
					&|d| d.min(cap),
					(!wing.clipped.0, !wing.clipped.1),
				),
			}
		}));
	}
	match spec.shape {
		RoofShape::Flat => None,
		RoofShape::Gabled if four => Some(gable(ring, &[cap], &|d| d.min(cap))),
		RoofShape::Gambrel if four => {
			// Two meters up per meter over the first two meters, then one per meter, as Arnis's barn roof climbs.
			let profile = move |d: f64| (2.0 * d.min(2.0) + (d - 2.0).max(0.0)).min(cap);
			let top = if cap >= 4.0 { 2.0 + (cap - 4.0) } else { cap / 2.0 };
			Some(gable(ring, &[2.0, top], &profile))
		}
		RoofShape::Round if four => {
			let crown = spec
				.stated_rise
				.unwrap_or_else(|| cap.min((short_half * 0.85).max(1.0)));
			let samples: Vec<f64> = (1..6)
				.map(|k| short_half * (1.0 - (f64::from(k) * std::f64::consts::FRAC_PI_2 / 6.0).cos()))
				.collect();
			Some(gable(ring, &samples, &move |d| {
				crown * (1.0 - (1.0 - d / short_half).powi(2)).max(0.0).sqrt()
			}))
		}
		RoofShape::Hipped if four => {
			let rise = short_half.min(cap);
			Some(hipped(ring, rise, short_half))
		}
		RoofShape::HalfHipped if four => {
			// The hip only bites above half the rise near the gable ends.
			let rise = short_half.min(cap);
			let hip_start = (cap / 2.0).max(2.0).min(rise);
			Some(hipped(ring, rise, rise - hip_start))
		}
		// A hipped footprint that splits into no wings takes the pyramid its distance field rises to.
		RoofShape::Hipped | RoofShape::HalfHipped => Some(radial(ring, &[(0.0, half_w.min(half_l).min(cap))])),
		RoofShape::Pyramidal => {
			let rise = spec
				.stated_rise
				.unwrap_or_else(|| (half_w.min(half_l) * 0.85).round().max(1.0).min(cap));
			Some(radial(ring, &[(0.0, rise)]))
		}
		RoofShape::Cone => {
			let rise = spec
				.stated_rise
				.unwrap_or_else(|| (half_w.min(half_l) * 1.2).floor().max(2.0).min(wall_height * 2.0));
			Some(radial(ring, &[(0.0, rise)]))
		}
		RoofShape::Dome => {
			let rise = spec.stated_rise.unwrap_or_else(|| (half_w.min(half_l) * 0.8).max(1.0));
			let rings: Vec<(f64, f64)> = (1..=DOME_RINGS)
				.map(|k| {
					let angle = f64::from(k as u32) * std::f64::consts::FRAC_PI_2 / DOME_RINGS as f64;
					(angle.cos(), angle.sin() * rise)
				})
				.collect();
			Some(radial(ring, &rings))
		}
		RoofShape::Onion => Some(onion(
			ring,
			half_w.min(half_l),
			spec.stated_rise
				.unwrap_or_else(|| (half_w.min(half_l) * 1.8).floor().max(6.0).min(wall_height * 2.0)),
		)),
		RoofShape::Skillion => {
			let bearing = spec.skillion_bearing.to_radians();
			let (dx, dz) = (bearing.sin(), -bearing.cos());
			let along: Vec<f64> = ring.iter().map(|p| p[0] * dx + p[1] * dz).collect();
			let (low, high) = along
				.iter()
				.fold((f64::MAX, f64::MIN), |(a, b), &p| (a.min(p), b.max(p)));
			let run = (high - low).max(1.0);
			let rise = spec.stated_rise.unwrap_or_else(|| {
				(run / 3.0)
					.floor()
					.clamp(2.0, 10.0)
					.min((wall_height * 0.9).round().max(1.0))
			});
			Some(skillion(ring, &along, high, run, rise))
		}
		RoofShape::Mansard => {
			// A steep band over the first two meters to the band's height, then a shallow 1:2 slope to the cap.
			let steep = spec.mansard_steep.min(cap);
			let top = (2.0 + 2.0 * (cap - steep)).min(short_half);
			let scale = |d: f64| (1.0 - d / short_half).max(0.0);
			let shallow_rise = steep + (top - 2.0).max(0.0) / 2.0;
			Some(radial(
				ring,
				&[(scale(2.0_f64.min(short_half)), steep), (scale(top), shallow_rise)],
			))
		}
		_ => None,
	}
}

/// An onion over a ring: the footprint at the eave, then 16-sided rings of Arnis's profile about the centroid.
fn onion(ring: &[[f64; 2]], base_radius: f64, total: f64) -> RoofMesh {
	let n = ring.len() as u32;
	let center = centroid(ring);
	let mut extra = Vec::new();
	let mut triangles = Vec::new();
	// A lid over the footprint, which the drum stands on.
	for i in 1..n - 1 {
		triangles.extend([0, i, i + 1]);
	}
	let levels = [0.05, 0.1, 0.15, 0.25, 0.35, 0.45, 0.55, 0.66, 0.78, 0.89];
	let mut previous: Option<u32> = None;
	for t in levels {
		let radius = base_radius * onion_profile_radius(t);
		let start = n + extra.len() as u32;
		for k in 0..ONION_SEGMENTS {
			let angle = k as f64 * std::f64::consts::TAU / ONION_SEGMENTS as f64;
			extra.push((
				[center[0] + radius * angle.cos(), center[1] + radius * angle.sin()],
				t * total,
			));
		}
		if let Some(prev) = previous {
			for k in 0..ONION_SEGMENTS as u32 {
				let l = (k + 1) % ONION_SEGMENTS as u32;
				triangles.extend([prev + k, prev + l, start + l, prev + k, start + l, start + k]);
			}
		}
		previous = Some(start);
	}
	let apex = n + extra.len() as u32;
	extra.push((center, total));
	if let Some(prev) = previous {
		for k in 0..ONION_SEGMENTS as u32 {
			triangles.extend([prev + k, prev + (k + 1) % ONION_SEGMENTS as u32, apex]);
		}
	}
	RoofMesh {
		rise: total,
		extra,
		triangles,
	}
}

/// A skillion: the footprint lifted onto a plane rising away from the downhill side, closed by vertical faces down to
/// the eave.
fn skillion(ring: &[[f64; 2]], along: &[f64], high: f64, run: f64, rise: f64) -> RoofMesh {
	let n = ring.len() as u32;
	let extra: Vec<([f64; 2], f64)> = ring
		.iter()
		.zip(along)
		.map(|(&p, &a)| (p, (high - a) / run * rise))
		.collect();
	let flat: Vec<f64> = ring.iter().flat_map(|p| [p[0], p[1]]).collect();
	let mut triangles: Vec<u32> = earcutr::earcut(&flat, &[], 2)
		.unwrap_or_default()
		.into_iter()
		.map(|index| n + index as u32)
		.collect();
	for i in 0..n {
		let j = (i + 1) % n;
		triangles.extend([i, j, n + j, i, n + j, n + i]);
	}
	RoofMesh { rise, extra, triangles }
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A 20 m by 10 m rectangle with its long sides along x.
	fn rectangle() -> Vec<[f64; 2]> {
		vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]]
	}

	#[test]
	fn a_gable_rises_one_to_one_to_half_its_span_under_the_wall_cap() {
		let mesh = roof_mesh(&rectangle(), false, 12.0, &RoofSpec::of(RoofShape::Gabled)).unwrap();
		// Half the 10 m span is 5 m, under the cap of 60% of 12 m (7 m).
		assert_eq!(mesh.rise, 5.0);
		// The ridge runs along the middle of the long sides.
		assert!(mesh.extra.iter().any(|(p, z)| *z == 5.0 && p[1] == 5.0));
	}

	#[test]
	fn a_low_wall_caps_the_gable_into_a_flat_topped_band() {
		let mesh = roof_mesh(&rectangle(), false, 5.0, &RoofSpec::of(RoofShape::Gabled)).unwrap();
		// 60% of 5 m rounds to 3 m.
		assert_eq!(mesh.rise, 3.0);
		assert!(mesh.extra.iter().any(|(p, z)| *z == 3.0 && (p[1] - 3.0).abs() < 1e-9));
	}

	#[test]
	fn a_gambrel_climbs_two_to_one_then_one_to_one() {
		let mesh = roof_mesh(&rectangle(), false, 20.0, &RoofSpec::of(RoofShape::Gambrel)).unwrap();
		assert!(mesh.extra.iter().any(|(p, z)| (p[1] - 2.0).abs() < 1e-9 && *z == 4.0));
		// The ridge at 5 m from the eave: 4 m over the first two, then 3 more.
		assert_eq!(mesh.rise, 7.0);
	}

	#[test]
	fn a_pyramid_ends_in_one_apex_over_the_centroid() {
		let mesh = roof_mesh(&rectangle(), false, 20.0, &RoofSpec::of(RoofShape::Pyramidal)).unwrap();
		assert_eq!(mesh.extra.len(), 1);
		assert_eq!(mesh.extra[0].0, [10.0, 5.0]);
		// 0.85 of the 5 m short half rounds to 4 m.
		assert_eq!(mesh.rise, 4.0);
		assert_eq!(mesh.triangles.len(), 4 * 3);
	}

	#[test]
	fn a_dome_rises_to_eight_tenths_of_the_short_half_span() {
		let mesh = roof_mesh(&rectangle(), false, 20.0, &RoofSpec::of(RoofShape::Dome)).unwrap();
		assert!((mesh.rise - 4.0).abs() < 1e-9);
		assert_eq!(mesh.extra.last().unwrap().0, [10.0, 5.0]);
	}

	#[test]
	fn a_skillion_falls_toward_its_bearing() {
		let mesh = roof_mesh(&rectangle(), false, 12.0, &RoofSpec::of(RoofShape::Skillion)).unwrap();
		// Falling south (y grows southward), the north edge is high and the south edge sits at the eave.
		let north = mesh.extra.iter().find(|(p, _)| p[1] == 0.0).unwrap().1;
		let south = mesh.extra.iter().find(|(p, _)| p[1] == 10.0).unwrap().1;
		assert!(north > south);
		assert_eq!(south, 0.0);
	}

	#[test]
	fn the_onion_profile_swells_past_the_drum_and_pinches_at_the_neck() {
		assert_eq!(onion_profile_radius(0.0), 1.0);
		assert!(onion_profile_radius(0.35) > 1.1);
		assert!(onion_profile_radius(0.7) < 0.35);
		assert!(onion_profile_radius(1.0).abs() < 1e-12);
	}

	#[test]
	fn an_l_shaped_gable_splits_into_two_wings_and_the_shorter_dies_into_the_longer() {
		// A 30 m by 10 m main wing along x, with a 10 m by 12 m arm off its south side at the east end.
		let l = vec![
			[0.0, 0.0],
			[30.0, 0.0],
			[30.0, 22.0],
			[20.0, 22.0],
			[20.0, 10.0],
			[0.0, 10.0],
		];
		let (angle, wings) = roof_wings(&l).unwrap();
		assert_eq!(angle, 0.0);
		assert_eq!(wings.len(), 2);
		let main = wings.iter().find(|w| w.along_u).unwrap();
		let arm = wings.iter().find(|w| !w.along_u).unwrap();
		assert_eq!((main.u, main.v), ((0.0, 30.0), (0.0, 10.0)));
		// The arm runs north into the main wing and stops at its ridge, 5 m in, without a gable on that end.
		assert_eq!(arm.v, (5.0, 22.0));
		assert_eq!(arm.clipped, (true, false));
		let mesh = roof_mesh(&l, false, 12.0, &RoofSpec::of(RoofShape::Gabled)).unwrap();
		// Both ridges rise one to one to half their span: 5 m for each 10 m wing.
		assert_eq!(mesh.rise, 5.0);
	}

	#[test]
	fn a_courtyard_or_a_flat_spec_gives_no_mesh() {
		assert!(roof_mesh(&rectangle(), true, 12.0, &RoofSpec::of(RoofShape::Dome)).is_none());
		assert!(roof_mesh(&rectangle(), false, 12.0, &RoofSpec::of(RoofShape::Flat)).is_none());
	}
}
