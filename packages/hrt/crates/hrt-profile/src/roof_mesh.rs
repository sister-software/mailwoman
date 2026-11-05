// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
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
	(wall_height * if steep { 0.9 } else { 0.6 }).round().clamp(1.0, MAX_INFERRED_RISE)
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

/// A gable-family roof on a four-vertex ring: lines parallel to the long sides at the profile's breakpoints, `profile`
/// giving the height at each distance from the eave, up to the ridge at half the short side.
fn gable(ring: &[[f64; 2]], breakpoints: &[f64], profile: &dyn Fn(f64) -> f64) -> RoofMesh {
	let start = if distance(ring[0], ring[1]) >= distance(ring[1], ring[2]) {
		0
	} else {
		1
	};
	let v = |offset: usize| ring[(start + offset) % 4];
	let index = |offset: usize| ((start + offset) % 4) as u32;
	let short = distance(v(1), v(2)).max(0.1);
	let half = short / 2.0;
	let mut distances: Vec<f64> = breakpoints.iter().copied().filter(|d| *d > 0.0 && *d < half).collect();
	distances.push(half);
	let mut extra = Vec::new();
	// Lines from the v0-v1 side toward the ridge, then from the v3-v2 side; the ridge is shared.
	let mut side_a = vec![(index(0), index(1))];
	for &d in &distances {
		let t = d / short;
		let first = (4 + extra.len()) as u32;
		extra.push((lerp(v(0), v(3), t), profile(d)));
		extra.push((lerp(v(1), v(2), t), profile(d)));
		side_a.push((first, first + 1));
	}
	let mut side_b = vec![(index(3), index(2))];
	for &d in &distances[..distances.len() - 1] {
		let t = d / short;
		let first = (4 + extra.len()) as u32;
		extra.push((lerp(v(3), v(0), t), profile(d)));
		extra.push((lerp(v(2), v(1), t), profile(d)));
		side_b.push((first, first + 1));
	}
	side_b.push(*side_a.last().unwrap());
	let mut triangles = Vec::new();
	for side in [&side_a, &side_b] {
		for pair in side.windows(2) {
			let ((a0, a1), (b0, b1)) = (pair[0], pair[1]);
			triangles.extend([a0, a1, b1, a0, b1, b0]);
		}
	}
	// Each gable end is a vertical polygon: a fan from its first eave corner up one side and down the other.
	for end in [0usize, 1] {
		let pick = |pair: (u32, u32)| if end == 0 { pair.0 } else { pair.1 };
		let outline: Vec<u32> = side_a
			.iter()
			.map(|&p| pick(p))
			.chain(side_b.iter().rev().skip(1).map(|&p| pick(p)))
			.collect();
		for k in 1..outline.len() - 1 {
			triangles.extend([outline[0], outline[k], outline[k + 1]]);
		}
	}
	RoofMesh {
		rise: profile(half),
		extra,
		triangles,
	}
}

/// A hipped roof on a four-vertex ring: the ridge runs along the long sides with each end pulled in by `inset`.
fn hipped(ring: &[[f64; 2]], rise: f64, inset: f64) -> RoofMesh {
	let start = if distance(ring[0], ring[1]) >= distance(ring[1], ring[2]) {
		0
	} else {
		1
	};
	let v = |offset: usize| ring[(start + offset) % 4];
	let index = |offset: usize| ((start + offset) % 4) as u32;
	let long = distance(v(0), v(1)).max(0.1);
	let inset = inset.clamp(0.0, long / 2.0);
	let direction = [(v(1)[0] - v(0)[0]) / long, (v(1)[1] - v(0)[1]) / long];
	let (m0, m1) = (lerp(v(3), v(0), 0.5), lerp(v(1), v(2), 0.5));
	let r0 = [m0[0] + direction[0] * inset, m0[1] + direction[1] * inset];
	let r1 = [m1[0] - direction[0] * inset, m1[1] - direction[1] * inset];
	RoofMesh {
		rise,
		extra: vec![(r0, rise), (r1, rise)],
		triangles: vec![
			index(0),
			index(1),
			5,
			index(0),
			5,
			4,
			index(2),
			index(3),
			4,
			index(2),
			4,
			5,
			index(3),
			index(0),
			4,
			index(1),
			index(2),
			5,
		],
	}
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
	fn a_courtyard_or_a_flat_spec_gives_no_mesh() {
		assert!(roof_mesh(&rectangle(), true, 12.0, &RoofSpec::of(RoofShape::Dome)).is_none());
		assert!(roof_mesh(&rectangle(), false, 12.0, &RoofSpec::of(RoofShape::Flat)).is_none());
	}
}
