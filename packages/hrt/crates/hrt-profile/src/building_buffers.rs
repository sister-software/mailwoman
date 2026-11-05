// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Compact building tiles: Overture footprints packed per z14 tile for a renderer that extrudes them on the GPU.
//!
//! Unlike the `buildings` vector-tile layer, a building is not clipped to tiles or repeated across zooms. Each footprint
//! is written once, into the z14 tile that holds the center of its bounding box, with coordinates relative to that
//! tile in the vector-tile extent of 8,192 units per tile side. Coordinates outside 0..8,192 are allowed, so a building
//! that crosses a tile edge stays whole. One z14 tile serves every zoom the renderer draws buildings at.
//!
//! # Tile body
//!
//! A tile body is gzip-compressed. Decompressed, it is the 4 bytes `MWB2`, a little-endian `u32` record count, and the
//! records in ascending byte order. Every number is little-endian. A record is one polygon of one building:
//!
//! | Field | Type | Meaning |
//! |---|---|---|
//! | id | `f64` | The GERS feature id's first 52 bits, exact as a double |
//! | height | `u16` | Top in decimeters; `0xFFFF` when the source states no height or floor count |
//! | eave | `u16` | Where the walls end and a pitched roof begins, in decimeters; equal to `height` for a flat roof |
//! | base | `u16` | `min_height` in decimeters, 0 when absent |
//! | wall color | `u32` | `0x00RRGGBB` from `facade_color`, with bit 31 set when present |
//! | roof color | `u32` | `0x00RRGGBB` from `roof_color`, with bit 31 set when present |
//! | district | `u8` | The 128 m palette cell, 0 to 15, or 255 when the centroid could not be computed |
//! | floors | `u8` | `num_floors`, at most 255, or 0 when absent |
//! | roof shape | `u8` | 0 flat, 1 gabled, 2 hipped |
//! | flags | `u8` | Bit 0 attached, bit 1 enclosed, bit 2 a street faces at least one wall |
//! | style | `u8` × 16 | The building's resolved style, `0xFF` throughout when the build resolved none; see below |
//! | ring count | `u8` | The exterior ring and its holes |
//! | ring sizes | `u16` × ring count | Vertices per ring, without the closing vertex |
//! | footprint | `i16` × 2 × vertices | x and y in tile units, y down, ring after ring |
//! | edge flags | `u8` × exterior vertices | Per exterior edge from vertex `i` to `i + 1`: bits 0 and 1 the [`FacadeClass`], bit 2 the front edge, bit 3 the first edge of a street corner |
//! | ridge count | `u8` | 0, or 2 for a gabled or hipped roof |
//! | ridge | `i16` × 2 × ridge count | The ridge's two ends at `height`; the footprint sits at `eave` |
//! | triangle count | `u16` | Roof triangles |
//! | triangles | `u16` × 3 × triangle count | Indexes into the footprint vertices followed by the ridge vertices |

use std::io::{self, Write};

use flate2::write::GzEncoder;
use flate2::Compression;
use geo_types::{Geometry, LineString, Polygon};

use crate::facade_plan::{FacadeClass, FacadePlan};
use crate::input::Input;
use crate::layers::buildings::{
	district, gers_feature_id, is_modeled_landmark, lon_lat_centroid, normalize_color, parse_height,
};

/// The zoom of the tiles a building is written to.
pub const TILE_ZOOM: u8 = 14;
/// Units per tile side, MapLibre's vector-tile extent.
pub const EXTENT: f64 = 8192.0;
/// The first four bytes of a decompressed tile body.
pub const MAGIC: &[u8; 4] = b"MWB2";
/// A style byte the build has not resolved, or a palette slot the style leaves empty.
pub const UNRESOLVED_STYLE: u8 = 0xFF;
/// Bytes of a record's style.
///
/// Bytes 0 to 7 are block palette indexes (`hrt_facade::palette` order): wall, trim, accent, glass, spandrel, base
/// course, shop frame and roof. Bytes 8 to 10 are the declaration-order indexes of `hrt_facade`'s
/// `BuildingCategory`, `WindowArchetype` and `GroundFloor`. Bytes 11 to 13 are the bay rhythm's window, pier and
/// corner widths in meters, byte 14 the storey height in meters, and byte 15 the flags: bit 0 windows, bit 1 a
/// parapet, bit 2 horizontal window bands, bit 3 accent lines at the floors, bit 4 an accent roof line, bit 5 a tall
/// building, bit 6 a vertical accent, bit 7 a generated roof.
pub const STYLE_BYTES: usize = 16;

/// A pitched roof shape a style can give a building whose source states none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PitchedRoof {
	Gabled,
	Hipped,
}
/// The `height` a building with no stated height or floor count records.
pub const UNKNOWN_HEIGHT: u16 = 0xFFFF;

/// A roof shape the renderer draws as a pitched roof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RoofShape {
	Flat = 0,
	Gabled = 1,
	Hipped = 2,
}

/// A building's attributes, shared by each of its polygons.
struct Attributes {
	id: f64,
	height: Option<f64>,
	base: f64,
	roof_height: Option<f64>,
	wall_color: u32,
	roof_color: u32,
	district: u8,
	floors: u8,
	roof_shape: RoofShape,
	/// Bits 0 to 2 of the record's flags byte that the draft sets; the facade plan sets the rest.
	flags: u8,
	style: [u8; STYLE_BYTES],
}

/// A color as `0x00RRGGBB` with bit 31 set, or 0 for none.
fn packed_color(color: Option<String>) -> u32 {
	color
		.and_then(|hex| u32::from_str_radix(hex.trim_start_matches('#'), 16).ok())
		.map_or(0, |rgb| rgb | 1 << 31)
}

/// Meters as decimeters in a `u16`, saturating.
fn decimeters(meters: f64) -> u16 {
	(meters * 10.0).round().clamp(0.0, f64::from(UNKNOWN_HEIGHT - 1)) as u16
}

/// One Overture building or building part before its records are written: its attributes and its polygons in world
/// coordinates.
pub struct BuildingDraft {
	attributes: Attributes,
	pub polygons: Vec<Polygon>,
	/// The parts of one building share a group, its GERS id; a building is its own group.
	pub group: i64,
}

/// The draft of one Overture building or building part, or `None` for a feature the `buildings` layer would skip:
/// another theme or type, a building drawn by its parts, or a modeled landmark.
pub fn building_draft(input: &Input<'_>) -> Option<BuildingDraft> {
	if input.tag("theme") != Some("buildings") {
		return None;
	}
	let part = match input.tag("type") {
		Some("building") => false,
		Some("building_part") => true,
		_ => return None,
	};
	if (!part && input.tag("has_parts") == Some("true")) || is_modeled_landmark(input) {
		return None;
	}
	let world = input.source.world_geometry().ok()?;
	let (height, base) = parse_height(input.tag("height"), input.tag("num_floors"), input.tag("min_height"));
	let roof_shape = match input.tag("roof_shape") {
		Some("gabled") => RoofShape::Gabled,
		Some("hipped") => RoofShape::Hipped,
		_ => RoofShape::Flat,
	};
	let attributes = Attributes {
		id: gers_feature_id(input.tag("id")) as f64,
		height,
		base: base.unwrap_or(0.0),
		roof_height: input.tag("roof_height").and_then(|text| text.parse().ok()),
		wall_color: packed_color(normalize_color(input.tag("facade_color"))),
		roof_color: packed_color(normalize_color(input.tag("roof_color"))),
		district: lon_lat_centroid(input).map_or(255, |(lon, lat)| district(lon, lat) as u8),
		floors: input
			.tag("num_floors")
			.and_then(|text| text.parse::<f64>().ok())
			.map_or(0, |floors| floors.clamp(0.0, 255.0) as u8),
		roof_shape,
		flags: 0,
		style: [UNRESOLVED_STYLE; STYLE_BYTES],
	};
	let polygons: Vec<Polygon> = match world {
		Geometry::Polygon(polygon) => vec![polygon],
		Geometry::MultiPolygon(polygons) => polygons.0,
		_ => Vec::new(),
	};
	let group = gers_feature_id(if part { input.tag("building_id") } else { input.tag("id") });
	Some(BuildingDraft {
		attributes,
		polygons,
		group,
	})
}

impl BuildingDraft {
	/// Whether the source states a height or floor count.
	pub fn has_height(&self) -> bool {
		self.attributes.height.is_some()
	}

	/// Sets the resolved style. A building whose source states no height takes `inferred_height` in meters, and
	/// `roof` replaces the roof shape: `None` for a flat roof.
	pub fn apply_style(&mut self, style: [u8; STYLE_BYTES], inferred_height: Option<f64>, roof: Option<PitchedRoof>) {
		self.attributes.style = style;
		if self.attributes.height.is_none() {
			self.attributes.height = inferred_height.map(|height| self.attributes.base + height);
		}
		self.attributes.roof_shape = match roof {
			Some(PitchedRoof::Gabled) => RoofShape::Gabled,
			Some(PitchedRoof::Hipped) => RoofShape::Hipped,
			None => RoofShape::Flat,
		};
	}
}

/// The z14 tile that holds the center of a polygon's bounding box.
pub fn home_tile(polygon: &Polygon) -> (u32, u32) {
	let scale = f64::from(1u32 << TILE_ZOOM);
	let [min_x, min_y, max_x, max_y] = polygon.exterior().0.iter().fold(
		[f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
		|[min_x, min_y, max_x, max_y], coord| [min_x.min(coord.x), min_y.min(coord.y), max_x.max(coord.x), max_y.max(coord.y)],
	);
	let max_index = f64::from((1u32 << TILE_ZOOM) - 1);
	(
		((min_x + max_x) / 2.0 * scale).floor().clamp(0.0, max_index) as u32,
		((min_y + max_y) / 2.0 * scale).floor().clamp(0.0, max_index) as u32,
	)
}

/// One tile unit in meters at tile row `ty`: the tile's ground width over the extent.
pub fn unit_meters(ty: u32) -> f64 {
	let scale = f64::from(1u32 << TILE_ZOOM);
	let latitude = hrt_osm::coords::world_lat((f64::from(ty) + 0.5) / scale);
	40_075_016.686 * latitude.to_radians().cos() / scale / EXTENT
}

/// A polygon's rings in tile units relative to tile `(tx, ty)`: the exterior, which must quantize, then each hole that
/// does.
pub fn quantize_polygon(polygon: &Polygon, (tx, ty): (u32, u32)) -> Option<Vec<Vec<[i16; 2]>>> {
	let scale = f64::from(1u32 << TILE_ZOOM);
	let (tx, ty) = (f64::from(tx), f64::from(ty));
	let mut rings = vec![quantize_ring(polygon.exterior(), scale, tx, ty)?];
	rings.extend(
		polygon
			.interiors()
			.iter()
			.filter_map(|ring| quantize_ring(ring, scale, tx, ty)),
	);
	rings.truncate(usize::from(u8::MAX));
	Some(rings)
}

/// Classifies a polygon's exterior ring, given in tile units relative to its home tile `(x, y)`.
pub type ExteriorPlanner<'a> = dyn Fn(&[[i16; 2]], (u32, u32)) -> FacadePlan + 'a;

/// The records of a draft, one per polygon, each with the z14 tile id it belongs to.
pub fn draft_records(draft: &BuildingDraft, plan: &ExteriorPlanner<'_>) -> Vec<(u64, Vec<u8>)> {
	draft
		.polygons
		.iter()
		.filter_map(|polygon| {
			let tile = home_tile(polygon);
			let rings = quantize_polygon(polygon, tile)?;
			let facade = plan(&rings[0], tile);
			polygon_record(tile, rings, &draft.attributes, &facade)
		})
		.collect()
}

/// A ring's vertices in tile units relative to tile `(tx, ty)`, without the closing vertex or repeated points, or
/// `None` when a vertex falls outside the `i16` range or fewer than three remain.
fn quantize_ring(ring: &LineString, scale: f64, tx: f64, ty: f64) -> Option<Vec<[i16; 2]>> {
	let mut out: Vec<[i16; 2]> = Vec::with_capacity(ring.0.len());
	for coord in &ring.0 {
		let x = ((coord.x * scale - tx) * EXTENT).round();
		let y = ((coord.y * scale - ty) * EXTENT).round();
		if !(f64::from(i16::MIN)..=f64::from(i16::MAX)).contains(&x)
			|| !(f64::from(i16::MIN)..=f64::from(i16::MAX)).contains(&y)
		{
			return None;
		}
		let point = [x as i16, y as i16];
		if out.last() != Some(&point) {
			out.push(point);
		}
	}
	if out.len() > 1 && out.first() == out.last() {
		out.pop();
	}
	(out.len() >= 3).then_some(out)
}

/// An exterior edge's flags byte: bits 0 and 1 its class, bit 2 the front edge, bit 3 the first edge of a street corner.
/// An edge the plan has no entry for, or one shorter than a meter, is open.
fn edge_flags(plan: &FacadePlan, edge: usize) -> u8 {
	let class = plan
		.segments
		.get(edge)
		.copied()
		.flatten()
		.map_or(FacadeClass::Open, |segment| segment.class) as u8;
	let front = u8::from(plan.front_segment == Some(edge)) << 2;
	let corner = u8::from(plan.corner.is_some_and(|(first, _)| first == edge)) << 3;
	class | front | corner
}

/// The record of one polygon in tile `(tx, ty)`, with its tile id, or `None` when it has too many vertices or its roof
/// does not triangulate.
fn polygon_record(
	(tx, ty): (u32, u32),
	rings: Vec<Vec<[i16; 2]>>,
	attributes: &Attributes,
	plan: &FacadePlan,
) -> Option<(u64, Vec<u8>)> {
	let vertices: Vec<[i16; 2]> = rings.iter().flatten().copied().collect();
	if vertices.len() > usize::from(u16::MAX) {
		return None;
	}
	let (height, eave, ridge, triangles) = roof(&rings, &vertices, attributes, unit_meters(ty))?;
	let flags =
		attributes.flags | u8::from(plan.attached) | u8::from(plan.enclosed) << 1 | u8::from(plan.has_any_street) << 2;

	let mut record = Vec::with_capacity(48 + vertices.len() * 5 + triangles.len() * 2);
	record.extend_from_slice(&attributes.id.to_le_bytes());
	record.extend_from_slice(&height.to_le_bytes());
	record.extend_from_slice(&eave.to_le_bytes());
	record.extend_from_slice(&decimeters(attributes.base).to_le_bytes());
	record.extend_from_slice(&attributes.wall_color.to_le_bytes());
	record.extend_from_slice(&attributes.roof_color.to_le_bytes());
	record.push(attributes.district);
	record.push(attributes.floors);
	record.push(if ridge.is_empty() {
		RoofShape::Flat
	} else {
		attributes.roof_shape
	} as u8);
	record.push(flags);
	record.extend_from_slice(&attributes.style);
	record.push(rings.len() as u8);
	for ring in &rings {
		record.extend_from_slice(&(ring.len() as u16).to_le_bytes());
	}
	for [x, y] in &vertices {
		record.extend_from_slice(&x.to_le_bytes());
		record.extend_from_slice(&y.to_le_bytes());
	}
	record.extend((0..rings[0].len()).map(|edge| edge_flags(plan, edge)));
	record.push(ridge.len() as u8);
	for [x, y] in &ridge {
		record.extend_from_slice(&x.to_le_bytes());
		record.extend_from_slice(&y.to_le_bytes());
	}
	record.extend_from_slice(&((triangles.len() / 3) as u16).to_le_bytes());
	for index in &triangles {
		record.extend_from_slice(&index.to_le_bytes());
	}
	Some((hrt_pmtiles::tile_id(TILE_ZOOM, tx, ty), record))
}

/// The pitch a gabled or hipped roof takes when the source states no roof height: rise over half the short side.
const DEFAULT_ROOF_PITCH: f64 = 0.6;

type Roof = (u16, u16, Vec<[i16; 2]>, Vec<u16>);

/// The height, eave, ridge vertices and roof triangles of a polygon.
///
/// A gabled or hipped roof is built only on a single four-vertex ring, the shape most tagged pitched roofs have. Its
/// ridge runs along the long sides through the middle; a hipped roof pulls each ridge end in by half the short side.
/// Every other polygon gets a flat roof, triangulated by earcut with its holes. `None` means earcut found no triangles.
fn roof(rings: &[Vec<[i16; 2]>], vertices: &[[i16; 2]], attributes: &Attributes, unit_meters: f64) -> Option<Roof> {
	let height = attributes.height.map_or(UNKNOWN_HEIGHT, decimeters);
	let pitched = attributes.roof_shape != RoofShape::Flat && rings.len() == 1 && vertices.len() == 4;
	if pitched && height != UNKNOWN_HEIGHT {
		let point = |index: usize| [f64::from(vertices[index][0]), f64::from(vertices[index][1])];
		let distance = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).hypot(a[1] - b[1]);
		// Rotate so that v0-v1 is a long side.
		let start = if distance(point(0), point(1)) >= distance(point(1), point(2)) {
			0
		} else {
			1
		};
		let v = |offset: usize| point((start + offset) % 4);
		let index = |offset: usize| ((start + offset) % 4) as u16;
		let mid = |a: [f64; 2], b: [f64; 2]| [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
		let short = distance(v(1), v(2)).max(1.0);
		let long = distance(v(0), v(1)).max(1.0);
		let (mut r0, mut r1) = (mid(v(3), v(0)), mid(v(1), v(2)));
		if attributes.roof_shape == RoofShape::Hipped {
			let inset = (short / 2.0).min(long / 2.0);
			let direction = [(v(1)[0] - v(0)[0]) / long, (v(1)[1] - v(0)[1]) / long];
			r0 = [r0[0] + direction[0] * inset, r0[1] + direction[1] * inset];
			r1 = [r1[0] - direction[0] * inset, r1[1] - direction[1] * inset];
		}
		let total = f64::from(height) / 10.0;
		let rise = attributes
			.roof_height
			.unwrap_or(short / 2.0 * unit_meters * DEFAULT_ROOF_PITCH)
			.clamp(0.0, (total - attributes.base).max(0.0));
		let eave = decimeters(total - rise);
		let ridge = [r0, r1].map(|[x, y]| [x.round() as i16, y.round() as i16]);
		// The ridge vertices follow the four footprint vertices, as indexes 4 and 5.
		let triangles = vec![
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
		];
		return Some((height, eave, ridge.to_vec(), triangles));
	}
	let coordinates: Vec<f64> = vertices
		.iter()
		.flat_map(|[x, y]| [f64::from(*x), f64::from(*y)])
		.collect();
	let mut holes = Vec::with_capacity(rings.len().saturating_sub(1));
	let mut offset = 0;
	for ring in &rings[..rings.len() - 1] {
		offset += ring.len();
		holes.push(offset);
	}
	let triangles: Vec<u16> = earcutr::earcut(&coordinates, &holes, 2)
		.ok()?
		.into_iter()
		.map(|index| index as u16)
		.collect();
	if triangles.is_empty() {
		return None;
	}
	Some((height, height, Vec::new(), triangles))
}

/// Writes one tile's body: the magic, the record count and the records, gzip-compressed.
pub fn tile_body(records: &[Vec<u8>]) -> io::Result<Vec<u8>> {
	let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
	encoder.write_all(MAGIC)?;
	encoder.write_all(&(records.len() as u32).to_le_bytes())?;
	for record in records {
		encoder.write_all(record)?;
	}
	encoder.finish()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::facade_plan::SegmentFacade;
	use geo_types::{coord, polygon};

	fn attributes(roof_shape: RoofShape, height: Option<f64>) -> Attributes {
		Attributes {
			id: 42.0,
			height,
			base: 0.0,
			roof_height: None,
			wall_color: packed_color(Some("#c0c0c0".into())),
			roof_color: 0,
			district: 3,
			floors: 2,
			roof_shape,
			flags: 0,
			style: [UNRESOLVED_STYLE; STYLE_BYTES],
		}
	}

	/// The record of `polygon` in its home tile, with `plan` for its exterior.
	fn record_of(polygon: &Polygon, attributes: &Attributes, plan: &FacadePlan) -> Option<(u64, Vec<u8>)> {
		let tile = home_tile(polygon);
		polygon_record(tile, quantize_polygon(polygon, tile)?, attributes, plan)
	}

	/// A square of side `side` world units with its top-left corner at `(x, y)` in world coordinates.
	fn square(x: f64, y: f64, side: f64) -> Polygon {
		polygon![(x: x, y: y), (x: x + side, y: y), (x: x + side, y: y + side * 0.5), (x: x, y: y + side * 0.5), (x: x, y: y)]
	}

	fn read_u16(record: &[u8], at: usize) -> u16 {
		u16::from_le_bytes([record[at], record[at + 1]])
	}

	/// The offset of the ring count: the fixed fields, the flags byte and the style bytes.
	const RINGS_AT: usize = 26 + STYLE_BYTES;

	#[test]
	fn a_flat_building_writes_its_ring_edges_and_two_triangles_into_the_tile_of_its_center() {
		let scale = f64::from(1u32 << TILE_ZOOM);
		// A rectangle inside tile (100, 200), 1/64 of a tile wide.
		let polygon = square(100.25 / scale, 200.5 / scale, 1.0 / 64.0 / scale);
		let street = SegmentFacade {
			class: FacadeClass::Street,
			road_dist: Some(3),
			normal: (0, 1),
			len: 10,
		};
		let plan = FacadePlan {
			segments: vec![None, None, Some(street), None],
			front_segment: Some(2),
			has_any_street: true,
			..FacadePlan::default()
		};
		let (tile, record) = record_of(&polygon, &attributes(RoofShape::Flat, Some(12.3)), &plan).unwrap();
		assert_eq!(tile, hrt_pmtiles::tile_id(TILE_ZOOM, 100, 200));
		assert_eq!(f64::from_le_bytes(record[0..8].try_into().unwrap()), 42.0);
		assert_eq!(read_u16(&record, 8), 123);
		assert_eq!(read_u16(&record, 10), 123);
		assert_eq!(u32::from_le_bytes(record[14..18].try_into().unwrap()), 0x80c0_c0c0);
		assert_eq!(record[22..25], [3, 2, 0]);
		// Bit 2: a street faces a wall.
		assert_eq!(record[25], 0b100);
		assert_eq!(record[26..RINGS_AT], [UNRESOLVED_STYLE; STYLE_BYTES]);
		assert_eq!(record[RINGS_AT], 1);
		assert_eq!(read_u16(&record, RINGS_AT + 1), 4);
		let vertices_at = RINGS_AT + 3;
		// The first vertex sits a quarter of the extent from the tile's west edge and half from its north edge.
		assert_eq!(read_u16(&record, vertices_at), 2048);
		assert_eq!(read_u16(&record, vertices_at + 2), 4096);
		let edges_at = vertices_at + 4 * 4;
		// Edges without a plan entry are open (3); the street edge is the front edge (class 0, bit 2).
		assert_eq!(record[edges_at..edges_at + 4], [3, 3, 0b100, 3]);
		let ridge_at = edges_at + 4;
		assert_eq!(record[ridge_at], 0);
		assert_eq!(read_u16(&record, ridge_at + 1), 2);
		assert_eq!(record.len(), ridge_at + 3 + 2 * 3 * 2);
	}

	#[test]
	fn a_gabled_four_vertex_building_gets_a_ridge_at_its_height_and_eaves_below() {
		let scale = f64::from(1u32 << TILE_ZOOM);
		let polygon = square(100.25 / scale, 200.5 / scale, 1.0 / 64.0 / scale);
		let mut gabled = attributes(RoofShape::Gabled, Some(10.0));
		gabled.roof_height = Some(3.0);
		let (_, record) = record_of(&polygon, &gabled, &FacadePlan::default()).unwrap();
		assert_eq!(read_u16(&record, 8), 100);
		assert_eq!(read_u16(&record, 10), 70);
		assert_eq!(record[24], RoofShape::Gabled as u8);
		let ridge_at = RINGS_AT + 3 + 4 * 4 + 4;
		assert_eq!(record[ridge_at], 2);
		// The rectangle is 128 units wide and 64 tall; the ridge runs along the long sides, halfway down the short ones.
		assert_eq!(read_u16(&record, ridge_at + 3), 4096 + 32);
		assert_eq!(read_u16(&record, ridge_at + 1 + 8), 6);
	}

	#[test]
	fn a_building_without_height_records_unknown_and_a_hole_stays_open() {
		let scale = f64::from(1u32 << TILE_ZOOM);
		let (x, y, side) = (100.25 / scale, 200.25 / scale, 0.5 / scale);
		let polygon = Polygon::new(
			LineString::from(vec![
				coord! { x: x, y: y },
				coord! { x: x + side, y: y },
				coord! { x: x + side, y: y + side },
				coord! { x: x, y: y + side },
				coord! { x: x, y: y },
			]),
			vec![LineString::from(vec![
				coord! { x: x + side * 0.25, y: y + side * 0.25 },
				coord! { x: x + side * 0.75, y: y + side * 0.25 },
				coord! { x: x + side * 0.75, y: y + side * 0.75 },
				coord! { x: x + side * 0.25, y: y + side * 0.75 },
				coord! { x: x + side * 0.25, y: y + side * 0.25 },
			])],
		);
		let (_, record) = record_of(&polygon, &attributes(RoofShape::Gabled, None), &FacadePlan::default()).unwrap();
		assert_eq!(read_u16(&record, 8), UNKNOWN_HEIGHT);
		// Two rings: a pitched roof needs one, so the roof is flat.
		assert_eq!(record[24], RoofShape::Flat as u8);
		assert_eq!(record[RINGS_AT], 2);
		// Edge flags cover the exterior's four edges only.
		let ridge_at = RINGS_AT + 1 + 2 * 2 + 8 * 4 + 4;
		assert_eq!(record[ridge_at], 0);
		// A square with a square hole triangulates into eight triangles.
		assert_eq!(read_u16(&record, ridge_at + 1), 8);
	}

	#[test]
	fn a_tile_body_decompresses_to_the_magic_count_and_records() {
		let body = tile_body(&[vec![1, 2], vec![3]]).unwrap();
		let mut decoded = Vec::new();
		io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&body[..]), &mut decoded).unwrap();
		assert_eq!(decoded, [b'M', b'W', b'B', b'2', 2, 0, 0, 0, 1, 2, 3]);
	}
}
