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
//! A tile body is gzip-compressed. Decompressed, it is the 4 bytes `MWB1`, a little-endian `u32` record count, and the
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
//! | ring count | `u8` | The exterior ring and its holes |
//! | ring sizes | `u16` × ring count | Vertices per ring, without the closing vertex |
//! | footprint | `i16` × 2 × vertices | x and y in tile units, y down, ring after ring |
//! | ridge count | `u8` | 0, or 2 for a gabled or hipped roof |
//! | ridge | `i16` × 2 × ridge count | The ridge's two ends at `height`; the footprint sits at `eave` |
//! | triangle count | `u16` | Roof triangles |
//! | triangles | `u16` × 3 × triangle count | Indexes into the footprint vertices followed by the ridge vertices |

use std::io::{self, Write};

use flate2::write::GzEncoder;
use flate2::Compression;
use geo_types::{Geometry, LineString, Polygon};

use crate::input::Input;
use crate::layers::buildings::{
	district, gers_feature_id, is_modeled_landmark, lon_lat_centroid, normalize_color, parse_height,
};

/// The zoom of the tiles a building is written to.
pub const TILE_ZOOM: u8 = 14;
/// Units per tile side, MapLibre's vector-tile extent.
pub const EXTENT: f64 = 8192.0;
/// The first four bytes of a decompressed tile body.
pub const MAGIC: &[u8; 4] = b"MWB1";
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

/// The records of one Overture building or building part, each with the z14 tile id it belongs to, or none for a feature
/// the `buildings` layer would skip: another theme or type, a building drawn by its parts, or a modeled landmark.
pub fn building_records(input: &Input<'_>) -> Vec<(u64, Vec<u8>)> {
	if input.tag("theme") != Some("buildings") {
		return Vec::new();
	}
	let part = match input.tag("type") {
		Some("building") => false,
		Some("building_part") => true,
		_ => return Vec::new(),
	};
	if (!part && input.tag("has_parts") == Some("true")) || is_modeled_landmark(input) {
		return Vec::new();
	}
	let Ok(world) = input.source.world_geometry() else {
		return Vec::new();
	};
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
	};
	let polygons: Vec<&Polygon> = match &world {
		Geometry::Polygon(polygon) => vec![polygon],
		Geometry::MultiPolygon(polygons) => polygons.0.iter().collect(),
		_ => Vec::new(),
	};
	polygons
		.into_iter()
		.filter_map(|polygon| polygon_record(polygon, &attributes))
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

/// The record of one polygon, with its tile id, or `None` when its exterior does not quantize to a ring.
fn polygon_record(polygon: &Polygon, attributes: &Attributes) -> Option<(u64, Vec<u8>)> {
	let scale = f64::from(1u32 << TILE_ZOOM);
	let bounds = polygon.exterior().0.iter().fold(
		[f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
		|[min_x, min_y, max_x, max_y], coord| {
			[
				min_x.min(coord.x),
				min_y.min(coord.y),
				max_x.max(coord.x),
				max_y.max(coord.y),
			]
		},
	);
	let max_index = f64::from((1u32 << TILE_ZOOM) - 1);
	let tx = ((bounds[0] + bounds[2]) / 2.0 * scale).floor().clamp(0.0, max_index);
	let ty = ((bounds[1] + bounds[3]) / 2.0 * scale).floor().clamp(0.0, max_index);
	let mut rings = vec![quantize_ring(polygon.exterior(), scale, tx, ty)?];
	rings.extend(
		polygon
			.interiors()
			.iter()
			.filter_map(|ring| quantize_ring(ring, scale, tx, ty)),
	);
	rings.truncate(usize::from(u8::MAX));
	let vertices: Vec<[i16; 2]> = rings.iter().flatten().copied().collect();
	if vertices.len() > usize::from(u16::MAX) {
		return None;
	}

	// One tile unit in meters at this tile's latitude: the tile's ground width over the extent.
	let latitude = hrt_osm::coords::world_lat((ty + 0.5) / scale);
	let unit_meters = 40_075_016.686 * latitude.to_radians().cos() / scale / EXTENT;
	let (height, eave, ridge, triangles) = roof(&rings, &vertices, attributes, unit_meters)?;

	let mut record = Vec::with_capacity(32 + vertices.len() * 4 + triangles.len() * 2);
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
	record.push(rings.len() as u8);
	for ring in &rings {
		record.extend_from_slice(&(ring.len() as u16).to_le_bytes());
	}
	for [x, y] in &vertices {
		record.extend_from_slice(&x.to_le_bytes());
		record.extend_from_slice(&y.to_le_bytes());
	}
	record.push(ridge.len() as u8);
	for [x, y] in &ridge {
		record.extend_from_slice(&x.to_le_bytes());
		record.extend_from_slice(&y.to_le_bytes());
	}
	record.extend_from_slice(&((triangles.len() / 3) as u16).to_le_bytes());
	for index in &triangles {
		record.extend_from_slice(&index.to_le_bytes());
	}
	Some((hrt_pmtiles::tile_id(TILE_ZOOM, tx as u32, ty as u32), record))
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
		}
	}

	/// A square of side `side` world units with its top-left corner at `(x, y)` in world coordinates.
	fn square(x: f64, y: f64, side: f64) -> Polygon {
		polygon![(x: x, y: y), (x: x + side, y: y), (x: x + side, y: y + side * 0.5), (x: x, y: y + side * 0.5), (x: x, y: y)]
	}

	fn read_u16(record: &[u8], at: usize) -> u16 {
		u16::from_le_bytes([record[at], record[at + 1]])
	}

	#[test]
	fn a_flat_building_writes_its_ring_and_two_triangles_into_the_tile_of_its_center() {
		let scale = f64::from(1u32 << TILE_ZOOM);
		// A rectangle inside tile (100, 200), 1/64 of a tile wide.
		let polygon = square(100.25 / scale, 200.5 / scale, 1.0 / 64.0 / scale);
		let (tile, record) = polygon_record(&polygon, &attributes(RoofShape::Flat, Some(12.3))).unwrap();
		assert_eq!(tile, hrt_pmtiles::tile_id(TILE_ZOOM, 100, 200));
		assert_eq!(f64::from_le_bytes(record[0..8].try_into().unwrap()), 42.0);
		assert_eq!(read_u16(&record, 8), 123);
		assert_eq!(read_u16(&record, 10), 123);
		assert_eq!(u32::from_le_bytes(record[14..18].try_into().unwrap()), 0x80c0_c0c0);
		assert_eq!(record[22..26], [3, 2, 0, 1]);
		assert_eq!(read_u16(&record, 26), 4);
		// The first vertex sits a quarter of the extent from the tile's west edge and half from its north edge.
		assert_eq!(read_u16(&record, 28), 2048);
		assert_eq!(read_u16(&record, 30), 4096);
		let after_vertices = 28 + 4 * 4;
		assert_eq!(record[after_vertices], 0);
		assert_eq!(read_u16(&record, after_vertices + 1), 2);
		assert_eq!(record.len(), after_vertices + 3 + 2 * 3 * 2);
	}

	#[test]
	fn a_gabled_four_vertex_building_gets_a_ridge_at_its_height_and_eaves_below() {
		let scale = f64::from(1u32 << TILE_ZOOM);
		let polygon = square(100.25 / scale, 200.5 / scale, 1.0 / 64.0 / scale);
		let mut gabled = attributes(RoofShape::Gabled, Some(10.0));
		gabled.roof_height = Some(3.0);
		let (_, record) = polygon_record(&polygon, &gabled).unwrap();
		assert_eq!(read_u16(&record, 8), 100);
		assert_eq!(read_u16(&record, 10), 70);
		assert_eq!(record[24], RoofShape::Gabled as u8);
		let after_vertices = 28 + 4 * 4;
		assert_eq!(record[after_vertices], 2);
		// The rectangle is 128 units wide and 64 tall; the ridge runs along the long sides, halfway down the short ones.
		let ridge_y = read_u16(&record, after_vertices + 3);
		assert_eq!(ridge_y, 4096 + 32);
		let triangles_at = after_vertices + 1 + 8;
		assert_eq!(read_u16(&record, triangles_at), 6);
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
		let (_, record) = polygon_record(&polygon, &attributes(RoofShape::Gabled, None)).unwrap();
		assert_eq!(read_u16(&record, 8), UNKNOWN_HEIGHT);
		// Two rings: a pitched roof needs one, so the roof is flat.
		assert_eq!(record[24], RoofShape::Flat as u8);
		assert_eq!(record[25], 2);
		let after_vertices = 26 + 2 * 2 + 8 * 4;
		assert_eq!(record[after_vertices], 0);
		// A square with a square hole triangulates into eight triangles.
		assert_eq!(read_u16(&record, after_vertices + 1), 8);
	}

	#[test]
	fn a_tile_body_decompresses_to_the_magic_count_and_records() {
		let body = tile_body(&[vec![1, 2], vec![3]]).unwrap();
		let mut decoded = Vec::new();
		io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&body[..]), &mut decoded).unwrap();
		assert_eq!(decoded, [b'M', b'W', b'B', b'1', 2, 0, 0, 0, 1, 2, 3]);
	}
}
