// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt building-tiles`: an archive of compact building tiles, one per z14 tile, from a synced Overture
//! `theme=buildings/` directory. `hrt_profile::building_buffers` describes the tile body.
//!
//! The build runs in three phases:
//! 1. With an OpenStreetMap file, it reads the tags of every building and building part, keyed by way or relation id,
//!    and every road line, indexed by the z14 tiles within [`MARGIN_METERS`] of it.
//! 2. It reads the Overture rows. Each row joins the OpenStreetMap tags of the element its `sources:OpenStreetMap` tag
//!    names, as `osm:<key>` tags, and goes to the sort under the z14 tile of each of its polygons. A row also goes, as
//!    context, to every other tile within [`MARGIN_METERS`] of it, so a wall on a tile edge sees its neighbors.
//! 3. For each tile, it draws every footprint and road surface onto a grid of one cell per meter, classifies each
//!    building's walls with `hrt_profile::facade_plan`, and writes the records.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;

use geo_types::{Coord, Geometry, LineString, MultiPolygon, Polygon};
use hrt_facade::{FacadeInput, FacadeStyle, NeighborFacts, Outline, RoofType};
use hrt_osm::{ElementKind, Tags};
use hrt_pmtiles::{Compression, TileType, Writer, WriterOptions};
use hrt_profile::building_buffers::{
	building_draft, draft_records, home_tile, quantize_polygon, tile_body, unit_meters, BuildingDraft, RoofShape,
	RoofSpec, EXTENT, STYLE_BYTES, TILE_ZOOM, UNRESOLVED_STYLE,
};
use hrt_profile::facade_plan::{
	compute_facade_plan, fill_cells, highway_block_range, stamp_road, surface_highway_type, Bitmap, FacadeClass,
	FacadePlan, Neighborhood,
};
use hrt_sort::Sorter;
use rayon::prelude::*;

/// How far around a tile, in meters, the grid reaches for neighbor footprints and road surfaces. It covers Arnis's
/// 8 m street setback, its 2-cell party test and a road's widest half-width of 8 m.
pub const MARGIN_METERS: f64 = 24.0;
/// Tiles processed together on rayon's threads before their bodies are written in tile order.
const TILES_PER_BATCH: usize = 64;
/// The OpenStreetMap keys a building keeps for style resolution.
const OSM_STYLE_KEYS: &[&str] = &[
	"building",
	"building:part",
	"building:levels",
	"building:min_level",
	"building:colour",
	"building:material",
	"building:architecture",
	"building:use",
	"roof:shape",
	"roof:colour",
	"roof:material",
	"roof:levels",
	"roof:height",
	"roof:angle",
	"roof:direction",
	"roof:orientation",
	"height",
	"min_height",
	"start_date",
	"construction_date",
	"historic",
	"heritage",
	"tourism",
	"wikidata",
	"amenity",
	"shop",
	"office",
	"name",
];
/// The OpenStreetMap keys a road keeps for its surface width.
const OSM_ROAD_KEYS: &[&str] = &[
	"highway",
	"construction",
	"area",
	"indoor",
	"aeroway",
	"man_made",
	"level",
	"tunnel",
	"lanes",
	"width",
];

/// What a build wrote.
#[derive(Default)]
pub struct Report {
	pub rows: u64,
	pub osm_buildings: u64,
	pub osm_roads: u64,
	pub joined: u64,
	pub records: u64,
	pub tiles: u64,
	pub archive_bytes: u64,
	/// Exterior edges by class: street, rear, party, open.
	pub edges: [u64; 4],
	pub attached: u64,
	pub enclosed: u64,
}

/// A road line in world coordinates with its surface half-width in meters.
struct RoadLine {
	points: Vec<[f64; 2]>,
	half_width: i32,
}

/// What the OpenStreetMap file gives the build.
#[derive(Default)]
struct OsmInputs {
	/// Style tags by `('w' | 'r', id)`.
	buildings: HashMap<(char, i64), Tags>,
	roads: Vec<RoadLine>,
	/// Road indexes by z14 tile id.
	roads_by_tile: HashMap<u64, Vec<u32>>,
}

/// The z14 tiles whose square, widened by `margin` world units, meets the world-coordinate box.
fn tiles_near([min_x, min_y, max_x, max_y]: [f64; 4], margin: f64) -> impl Iterator<Item = (u32, u32)> {
	let scale = f64::from(1u32 << TILE_ZOOM);
	let last = f64::from((1u32 << TILE_ZOOM) - 1);
	let tile = |value: f64| (value * scale).floor().clamp(0.0, last) as u32;
	let (x0, x1) = (tile(min_x - margin), tile(max_x + margin));
	let (y0, y1) = (tile(min_y - margin), tile(max_y + margin));
	(y0..=y1).flat_map(move |y| (x0..=x1).map(move |x| (x, y)))
}

/// `MARGIN_METERS` in world units at world row `y`.
fn margin_world(y: f64) -> f64 {
	let latitude = hrt_osm::coords::world_lat(y);
	MARGIN_METERS / (40_075_016.686 * latitude.to_radians().cos())
}

fn bounds_of(points: impl Iterator<Item = Coord>) -> [f64; 4] {
	points.fold(
		[f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
		|[a, b, c, d], p| [a.min(p.x), b.min(p.y), c.max(p.x), d.max(p.y)],
	)
}

/// Whether a world-coordinate box meets `bounds` in degrees, widened by the margin.
fn meets(box_: [f64; 4], bounds: Option<[f64; 4]>) -> bool {
	let Some([west, south, east, north]) = bounds else {
		return true;
	};
	let margin = margin_world((box_[1] + box_[3]) / 2.0);
	let (x0, x1) = (
		hrt_osm::coords::world_x(west) - margin,
		hrt_osm::coords::world_x(east) + margin,
	);
	let (y0, y1) = (
		hrt_osm::coords::world_y(north) - margin,
		hrt_osm::coords::world_y(south) + margin,
	);
	box_[0] <= x1 && box_[2] >= x0 && box_[1] <= y1 && box_[3] >= y0
}

/// Reads building tags and road lines from an OpenStreetMap file.
fn read_osm(path: &Path, bounds: Option<[f64; 4]>) -> io::Result<OsmInputs> {
	let state = hrt_osm::reader::pass1(path, |_| false)?;
	let buildings = Mutex::new(HashMap::new());
	let roads = Mutex::new(Vec::new());
	hrt_osm::reader::pass2(path, &state, |feature| {
		let tag = |key: &str| feature.tags.get(key).map(str::to_owned);
		let kind = match feature.kind {
			ElementKind::Way => 'w',
			ElementKind::Relation => 'r',
			_ => return,
		};
		if feature.tags.get("building").is_some() || feature.tags.get("building:part").is_some() {
			let kept = Tags(
				feature
					.tags
					.0
					.iter()
					.filter(|(key, _)| OSM_STYLE_KEYS.contains(&key.as_str()))
					.cloned()
					.collect(),
			);
			buildings.lock().unwrap().insert((kind, feature.id), kept);
		}
		if kind != 'w' || !feature.can_be_line() {
			return;
		}
		let Some(highway) = surface_highway_type(&tag) else {
			return;
		};
		let Ok(line) = feature.line() else {
			return;
		};
		if !meets(bounds_of(line.0.iter().copied()), bounds) {
			return;
		}
		let road_tags = |key: &str| {
			OSM_ROAD_KEYS
				.contains(&key)
				.then(|| feature.tags.get(key).map(str::to_owned))
				.flatten()
		};
		roads.lock().unwrap().push(RoadLine {
			points: line.0.iter().map(|point| [point.x, point.y]).collect(),
			half_width: highway_block_range(&highway, &road_tags),
		});
	})?;
	let roads: Vec<RoadLine> = roads.into_inner().unwrap();
	let mut roads_by_tile: HashMap<u64, Vec<u32>> = HashMap::new();
	for (index, road) in roads.iter().enumerate() {
		let box_ = bounds_of(road.points.iter().map(|[x, y]| Coord { x: *x, y: *y }));
		for (x, y) in tiles_near(box_, margin_world((box_[1] + box_[3]) / 2.0)) {
			roads_by_tile
				.entry(hrt_pmtiles::tile_id(TILE_ZOOM, x, y))
				.or_default()
				.push(index as u32);
		}
	}
	Ok(OsmInputs {
		buildings: buildings.into_inner().unwrap(),
		roads,
		roads_by_tile,
	})
}

/// The `(kind, id)` an Overture `sources:OpenStreetMap` record id names, such as `w783697382@1`.
fn osm_element(record_id: &str) -> Option<(char, i64)> {
	let kind = record_id.chars().next()?;
	let id = record_id[1..].split('@').next()?.parse().ok()?;
	matches!(kind, 'w' | 'r').then_some((kind, id))
}

/// A row as the sort stores it: whether this tile is its home, its tags and its polygons in world coordinates.
struct SortedRow {
	home: bool,
	id: i64,
	tags: Tags,
	polygons: Vec<Polygon>,
}

fn write_text(out: &mut Vec<u8>, text: &str) {
	out.extend_from_slice(&(text.len() as u32).to_le_bytes());
	out.extend_from_slice(text.as_bytes());
}

fn encode_row(home: bool, id: i64, tags: &Tags, polygons: &[Polygon]) -> Vec<u8> {
	let mut out = vec![u8::from(home)];
	out.extend_from_slice(&id.to_le_bytes());
	out.extend_from_slice(&(tags.0.len() as u32).to_le_bytes());
	for (key, value) in &tags.0 {
		write_text(&mut out, key);
		write_text(&mut out, value);
	}
	out.extend_from_slice(&(polygons.len() as u32).to_le_bytes());
	for polygon in polygons {
		let rings: Vec<&LineString> = std::iter::once(polygon.exterior()).chain(polygon.interiors()).collect();
		out.extend_from_slice(&(rings.len() as u32).to_le_bytes());
		for ring in rings {
			out.extend_from_slice(&(ring.0.len() as u32).to_le_bytes());
			for point in &ring.0 {
				out.extend_from_slice(&point.x.to_le_bytes());
				out.extend_from_slice(&point.y.to_le_bytes());
			}
		}
	}
	out
}

/// A cursor over a sorted row's bytes.
struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
	fn take(&mut self, count: usize) -> io::Result<&[u8]> {
		if self.0.len() < count {
			return Err(io::Error::other("a sorted building row ends early"));
		}
		let (head, rest) = self.0.split_at(count);
		self.0 = rest;
		Ok(head)
	}

	fn u32(&mut self) -> io::Result<u32> {
		Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
	}

	fn f64(&mut self) -> io::Result<f64> {
		Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
	}

	fn text(&mut self) -> io::Result<String> {
		let length = self.u32()? as usize;
		String::from_utf8(self.take(length)?.to_vec()).map_err(io::Error::other)
	}
}

fn decode_row(bytes: &[u8]) -> io::Result<SortedRow> {
	let mut reader = Reader(bytes);
	let home = reader.take(1)?[0] == 1;
	let id = i64::from_le_bytes(reader.take(8)?.try_into().unwrap());
	let tag_count = reader.u32()?;
	let mut tags = Vec::with_capacity(tag_count as usize);
	for _ in 0..tag_count {
		tags.push((reader.text()?, reader.text()?));
	}
	let polygon_count = reader.u32()?;
	let mut polygons = Vec::with_capacity(polygon_count as usize);
	for _ in 0..polygon_count {
		let ring_count = reader.u32()?;
		let mut rings = Vec::with_capacity(ring_count as usize);
		for _ in 0..ring_count {
			let point_count = reader.u32()?;
			let mut points = Vec::with_capacity(point_count as usize);
			for _ in 0..point_count {
				points.push(Coord {
					x: reader.f64()?,
					y: reader.f64()?,
				});
			}
			rings.push(LineString(points));
		}
		let mut rings = rings.into_iter();
		let exterior = rings.next().unwrap_or_else(|| LineString(Vec::new()));
		polygons.push(Polygon::new(exterior, rings.collect()));
	}
	Ok(SortedRow {
		home,
		id,
		tags: Tags(tags),
		polygons,
	})
}

/// A ring in tile units as grid cells of one meter.
fn cells(ring: &[[i16; 2]], unit: f64) -> Vec<(i32, i32)> {
	ring.iter()
		.map(|[x, y]| {
			(
				(f64::from(*x) * unit).round() as i32,
				(f64::from(*y) * unit).round() as i32,
			)
		})
		.collect()
}

/// The tags Arnis reads for a building: the Overture row's columns as `hrt_facade::overture_tags` maps them, with the
/// joined OpenStreetMap tags (`osm:<key>`) taking precedence, as Arnis reads a mapped way's own tags.
fn facade_tags(tags: &Tags) -> hrt_facade::Tags {
	let number = |key: &str| tags.get(key).and_then(|text| text.parse::<f64>().ok());
	let mut out = hrt_facade::overture_tags(
		tags.get("subtype"),
		tags.get("class"),
		number("height").filter(|_| !ignores_overture_height(tags)),
		number("num_floors").map(|floors| floors as i32),
		number("min_height"),
		tags.get("roof_shape"),
		tags.get("roof_material"),
		tags.get("roof_orientation"),
		number("roof_height"),
		tags.get("facade_color"),
		tags.get("roof_color"),
		tags.get("facade_material"),
		true,
	);
	if tags.get("type") == Some("building_part") {
		out.insert("building:part".to_owned(), "yes".to_owned());
	}
	for (key, value) in &tags.0 {
		if let Some(osm_key) = key.strip_prefix("osm:") {
			out.insert(osm_key.to_owned(), value.clone());
		}
	}
	out
}

/// Whether a building's Overture height is set aside for the style's inferred height: a garage, carport or shed that
/// OpenStreetMap gives no height or level count of its own.
///
/// Overture takes these classes' heights from USGS Lidar, which over a small outbuilding often measures the trees
/// above it. In Detroit's 2026-10-21.0 rows, 12,812 of 70,164 garages stand 12 m or taller, and USGS Lidar supplied
/// the height of 12,807 of those.
fn ignores_overture_height(tags: &Tags) -> bool {
	matches!(tags.get("class"), Some("garage" | "garages" | "carport" | "shed"))
		&& ["osm:height", "osm:building:levels"]
			.iter()
			.all(|key| tags.get(key).is_none())
}

/// The seed Arnis would give the building: its OpenStreetMap way, or relation's first outer ring, or else its GERS id.
fn facade_seed(tags: &Tags) -> u64 {
	match tags.get("sources:OpenStreetMap").and_then(osm_element) {
		Some(('w', id)) => hrt_facade::seed_for_osm_way(id as u64),
		Some((_, id)) => hrt_facade::seed_for_relation_ring(id as u64, 0),
		None => hrt_facade::seed_for_overture_id(tags.get("id").unwrap_or_default()),
	}
}

/// A resolved style as the record's style bytes, described at `hrt_profile::building_buffers::STYLE_BYTES`.
fn style_bytes(style: &FacadeStyle) -> [u8; STYLE_BYTES] {
	let meters = |value: i32| value.clamp(0, 254) as u8;
	let flags = [
		style.has_windows,
		style.has_parapet,
		style.use_horizontal_windows,
		style.use_accent_lines,
		style.use_accent_roof_line,
		style.is_tall_building,
		style.use_vertical_accent,
		style.generate_roof,
	]
	.iter()
	.enumerate()
	.fold(0u8, |flags, (bit, set)| flags | u8::from(*set) << bit);
	[
		style.wall.index(),
		style.trim.index(),
		style.accent.index(),
		style.glass.index(),
		style.spandrel.index(),
		style.base_course.map_or(UNRESOLVED_STYLE, |block| block.index()),
		style.shop_frame.index(),
		style.roof_block.unwrap_or(style.roof_cover.base).index(),
		style.category as u8,
		style.window_archetype as u8,
		style.ground as u8,
		meters(style.bays.window),
		meters(style.bays.pier),
		meters(style.bays.corner),
		meters(style.floor_cycle),
		flags,
	]
}

/// A compass bearing from a `roof:direction` value, as Arnis's `parse_roof_direction_degrees` reads one.
fn roof_direction_degrees(value: &str) -> Option<f64> {
	let degrees = match value.trim().to_ascii_lowercase().as_str() {
		"n" | "north" => 0.0,
		"ne" => 45.0,
		"e" | "east" => 90.0,
		"se" => 135.0,
		"s" | "south" => 180.0,
		"sw" => 225.0,
		"w" | "west" => 270.0,
		"nw" => 315.0,
		other => other.parse::<f64>().ok()?,
	};
	degrees.is_finite().then(|| degrees.rem_euclid(360.0))
}

/// The roof a resolved style draws, with the tags Arnis's `generate_roof` reads: `roof:height` for the rise,
/// `roof:levels` for a mansard's steep band and `roof:direction` for a skillion. A skillion without a direction falls
/// across the footprint's narrower axis, toward the side a seeded coin picks, as Arnis's `generate_skillion_roof` does.
fn roof_spec(style: &FacadeStyle, group: &StyleGroup, exterior: &[(i32, i32)]) -> RoofSpec {
	let shape = if style.generate_roof {
		match style.roof_type {
			RoofType::Gabled => RoofShape::Gabled,
			RoofType::Hipped => RoofShape::Hipped,
			RoofType::HalfHipped => RoofShape::HalfHipped,
			RoofType::Gambrel => RoofShape::Gambrel,
			RoofType::Round => RoofShape::Round,
			RoofType::Mansard => RoofShape::Mansard,
			RoofType::Skillion => RoofShape::Skillion,
			RoofType::Pyramidal => RoofShape::Pyramidal,
			RoofType::Dome => RoofShape::Dome,
			RoofType::Cone => RoofShape::Cone,
			RoofType::Onion => RoofShape::Onion,
			RoofType::Flat => RoofShape::Flat,
		}
	} else {
		RoofShape::Flat
	};
	let tag = |key: &str| group.tags.get(key).map(String::as_str);
	let skillion_bearing = tag("roof:direction")
		.and_then(roof_direction_degrees)
		.unwrap_or_else(|| {
			let (min_x, max_x) = exterior
				.iter()
				.fold((i32::MAX, i32::MIN), |(a, b), p| (a.min(p.0), b.max(p.0)));
			let (min_z, max_z) = exterior
				.iter()
				.fold((i32::MAX, i32::MIN), |(a, b), p| (a.min(p.1), b.max(p.1)));
			let flip = rand::Rng::random_bool(
				&mut hrt_facade::rng::element_rng(group.element_id ^ 0x5C11_1104_D129_0000),
				0.5,
			);
			match (max_x - min_x <= max_z - min_z, flip) {
				(true, true) => 270.0,
				(true, false) => 90.0,
				(false, true) => 0.0,
				(false, false) => 180.0,
			}
		});
	RoofSpec {
		shape,
		stated_rise: tag("roof:height").and_then(|text| text.trim().trim_end_matches('m').trim().parse().ok()),
		steep: style.category == hrt_facade::BuildingCategory::Religious,
		skillion_bearing,
		mansard_steep: tag("roof:levels")
			.and_then(|text| text.trim().parse::<f64>().ok())
			.map_or(4.0, |levels| (levels * 3.0).round().clamp(3.0, 6.0)),
	}
}

/// The longitude and latitude of a polygon's bounding-box center.
fn center(polygon: &Polygon) -> (f64, f64) {
	let box_ = bounds_of(polygon.exterior().0.iter().copied());
	(
		(box_[0] + box_[2]) / 2.0 * 360.0 - 180.0,
		hrt_osm::coords::world_lat((box_[1] + box_[3]) / 2.0),
	)
}

/// The facade tags a part without a material or color of its own takes from a masonry building, as Arnis's
/// `inherit_masonry_facade_tags` gives them.
const FACADE_KEYS: [&str; 5] = [
	"building:material",
	"building:facade:material",
	"facade:material",
	"building:colour",
	"colour",
];

/// Whether a building's facade is masonry: brick, stone, plaster, render or concrete, as Arnis tests it.
fn masonry(tags: &hrt_facade::Tags) -> bool {
	tags.get("building:material")
		.or_else(|| tags.get("building:facade:material"))
		.is_some_and(|material| {
			let normalized: String = material
				.chars()
				.filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
				.flat_map(char::to_lowercase)
				.collect();
			matches!(
				normalized.as_str(),
				"brick"
					| "bricks" | "stone"
					| "naturalstone"
					| "limestone" | "sandstone"
					| "marble" | "granite"
					| "plaster" | "stucco"
					| "render" | "concrete"
			)
		})
}

/// What a building's style resolution shares with the rest of its group.
struct StyleGroup {
	/// The group seed: a part's carries its building's style hint, year and housing mark.
	seed: u64,
	element_id: u64,
	tags: hrt_facade::Tags,
	/// Where the district cell is taken: the building's center, so every part shares one district.
	district_center: (f64, f64),
}

/// The style group of a building, or of a part whose building is among `rows`, as Arnis's `osm_parser` groups the
/// parts of a building under its outline.
fn style_group(row: &SortedRow, polygon: &Polygon, rows: &[SortedRow], by_id: &HashMap<&str, usize>) -> StyleGroup {
	let mut tags = facade_tags(&row.tags);
	let element_id = facade_seed(&row.tags);
	let parent = (row.tags.get("type") == Some("building_part"))
		.then(|| row.tags.get("building_id"))
		.flatten()
		.and_then(|id| by_id.get(id))
		.map(|&index| &rows[index]);
	let Some(parent) = parent else {
		return StyleGroup {
			seed: element_id,
			element_id,
			tags,
			district_center: center(polygon),
		};
	};
	let outline = facade_tags(&parent.tags);
	let mut hint = hrt_facade::seed::building_style_hint(&outline);
	if hint == hrt_facade::StyleHint::None {
		hint = hrt_facade::seed::building_style_hint(&tags);
	}
	let seed = hrt_facade::part_group_seed(
		facade_seed(&parent.tags),
		hint,
		hrt_facade::seed::year_for_parts(&outline),
		hrt_facade::seed::is_housing_type(&outline),
	);
	if masonry(&outline) && !FACADE_KEYS.iter().any(|key| tags.contains_key(*key)) {
		for key in FACADE_KEYS {
			if let Some(value) = outline.get(key) {
				tags.insert(key.to_owned(), value.clone());
			}
		}
	}
	let district_center = parent.polygons.first().map_or_else(|| center(polygon), center);
	StyleGroup {
		seed,
		element_id,
		tags,
		district_center,
	}
}

/// Resolves a draft's style from its first polygon's exterior and facade plan, and applies it.
fn resolve_style(
	draft: &mut BuildingDraft,
	group: &StyleGroup,
	exterior: &[(i32, i32)],
	fill: usize,
	plan: &FacadePlan,
) {
	let Some(first) = draft.polygons.first() else {
		return;
	};
	let (lon, lat) = center(first);
	let mut nodes = exterior.to_vec();
	nodes.push(exterior[0]);
	let style = hrt_facade::resolve(&FacadeInput {
		seed: group.seed,
		element_id: group.element_id,
		tags: &group.tags,
		outline: Outline { nodes, cells: fill },
		lon,
		lat,
		district_cell: hrt_facade::district_cell(group.district_center.0, group.district_center.1),
		relation_levels: None,
		neighbors: Some(NeighborFacts {
			attached: plan.attached,
			enclosed: plan.enclosed,
			has_any_street: plan.has_any_street,
			street_corner: plan.corner.is_some(),
		}),
		has_mapped_entrance: false,
	});
	let inferred = (!draft.has_height())
		.then(|| style.inferred_height.map(f64::from))
		.flatten();
	draft.apply_style(style_bytes(&style), inferred, roof_spec(&style, group, exterior));
}

/// What one tile's processing wrote.
#[derive(Default)]
struct TileOutput {
	records: Vec<Vec<u8>>,
	edges: [u64; 4],
	attached: u64,
	enclosed: u64,
}

/// Classifies and writes the home buildings of tile `(tx, ty)` among the rows the sort gave it.
fn process_tile((tx, ty): (u32, u32), rows: &[SortedRow], osm: &OsmInputs) -> TileOutput {
	let tile_id = hrt_pmtiles::tile_id(TILE_ZOOM, tx, ty);
	let unit = unit_meters(ty);
	let nodes = hrt_osm::NodeStore::default();
	let drafts: Vec<_> = rows
		.iter()
		.map(|row| {
			let feature = hrt_osm::SourceFeature::fixed(
				row.id,
				ElementKind::Other,
				("overture_buildings", ""),
				&row.tags,
				Geometry::MultiPolygon(MultiPolygon(row.polygons.clone())),
				&nodes,
			);
			building_draft(&hrt_profile::Input::new(&feature))
		})
		.collect();
	// Each polygon's exterior in grid cells, with its row's group.
	let mut exteriors: Vec<(i64, Vec<(i32, i32)>)> = Vec::new();
	for draft in drafts.iter().flatten() {
		for polygon in &draft.polygons {
			if let Some(rings) = quantize_polygon(polygon, (tx, ty)) {
				exteriors.push((draft.group, cells(&rings[0], unit)));
			}
		}
	}
	let margin = MARGIN_METERS.ceil() as i32;
	let side = (EXTENT * unit).ceil() as i32;
	let (mut min, mut max) = ((-margin, -margin), (side + margin, side + margin));
	for (_, ring) in &exteriors {
		for &(x, z) in ring {
			min = (min.0.min(x - margin), min.1.min(z - margin));
			max = (max.0.max(x + margin), max.1.max(z + margin));
		}
	}
	let mut footprints = Bitmap::new(min, max);
	let mut own: HashMap<i64, HashSet<(i32, i32)>> = HashMap::new();
	for (group, ring) in &exteriors {
		let fill = fill_cells(ring);
		for &(x, z) in &fill {
			footprints.set(x, z);
		}
		own.entry(*group).or_default().extend(fill);
	}
	let mut roads = Bitmap::new(min, max);
	let scale = f64::from(1u32 << TILE_ZOOM);
	for &index in osm.roads_by_tile.get(&tile_id).map(Vec::as_slice).unwrap_or(&[]) {
		let road = &osm.roads[index as usize];
		let points: Vec<(i32, i32)> = road
			.points
			.iter()
			.map(|[x, y]| {
				(
					((x * scale - f64::from(tx)) * EXTENT * unit).round() as i32,
					((y * scale - f64::from(ty)) * EXTENT * unit).round() as i32,
				)
			})
			.collect();
		stamp_road(&mut roads, &points, road.half_width);
	}
	let near = Neighborhood {
		footprints: &footprints,
		roads: &roads,
	};
	let empty = HashSet::new();
	// Every row in the tile, home or context, by GERS id, so a part finds its building.
	let by_id: HashMap<&str, usize> = rows
		.iter()
		.enumerate()
		.filter_map(|(index, row)| Some((row.tags.get("id")?, index)))
		.collect();
	let mut output = TileOutput::default();
	for (row, draft) in rows.iter().zip(drafts) {
		let (true, Some(mut draft)) = (row.home, draft) else {
			continue;
		};
		let styled = draft
			.polygons
			.first()
			.filter(|first| home_tile(first) == (tx, ty))
			.and_then(|first| {
				let rings = quantize_polygon(first, (tx, ty))?;
				let exterior = cells(&rings[0], unit);
				let plan = compute_facade_plan(&exterior, own.get(&draft.group).unwrap_or(&empty), &near);
				Some((exterior, plan))
			});
		if let Some((exterior, plan)) = styled {
			let fill = fill_cells(&exterior).len();
			let group = style_group(row, &draft.polygons[0], rows, &by_id);
			if ignores_overture_height(&row.tags) {
				draft.clear_height();
			}
			resolve_style(&mut draft, &group, &exterior, fill, &plan);
		}
		let draft = &draft;
		let plans = Mutex::new(Vec::<FacadePlan>::new());
		let records = draft_records(draft, &|ring, tile| {
			if tile != (tx, ty) {
				return FacadePlan::default();
			}
			let plan = compute_facade_plan(&cells(ring, unit), own.get(&draft.group).unwrap_or(&empty), &near);
			plans.lock().unwrap().push(plan.clone());
			plan
		});
		for (tile, record) in records {
			if tile == tile_id {
				output.records.push(record);
			}
		}
		for plan in plans.into_inner().unwrap() {
			for segment in plan.segments.iter() {
				let class = segment.map_or(FacadeClass::Open, |segment| segment.class);
				output.edges[class as usize] += 1;
			}
			output.attached += u64::from(plan.attached);
			output.enclosed += u64::from(plan.enclosed);
		}
	}
	output.records.sort();
	output
}

/// Builds `output` from the GeoParquet files under `root`, keeping the rows whose `bbox` meets `bounds` when given.
/// With `osm`, buildings join their OpenStreetMap tags and walls are classified against its roads.
pub fn build(
	root: &Path,
	bounds: Option<[f64; 4]>,
	osm: Option<&Path>,
	output: &Path,
	scratch: &Path,
) -> io::Result<Report> {
	let osm_inputs = match osm {
		Some(path) => read_osm(path, bounds)?,
		None => OsmInputs::default(),
	};
	let joined = std::sync::atomic::AtomicU64::new(0);
	let sorter = Sorter::new(scratch, 64 << 20);
	let threads = rayon::current_num_threads();
	let writers: Vec<Mutex<_>> = (0..=threads).map(|_| Mutex::new(sorter.writer())).collect();
	let failure: Mutex<Option<io::Error>> = Mutex::new(None);
	let rows = hrt_sources::overture::read(root, bounds, |record| {
		let polygons: Vec<Polygon> = match record.geometry {
			Geometry::Polygon(polygon) => vec![polygon],
			Geometry::MultiPolygon(polygons) => polygons.0,
			_ => return,
		};
		let mut tags = record.tags;
		if let Some(osm_tags) = tags
			.get("sources:OpenStreetMap")
			.and_then(osm_element)
			.and_then(|key| osm_inputs.buildings.get(&key))
		{
			joined.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
			let extra: Vec<(String, String)> = osm_tags
				.0
				.iter()
				.map(|(key, value)| (format!("osm:{key}"), value.clone()))
				.collect();
			tags.0.extend(extra);
		}
		let mut homes: Vec<(u32, u32)> = polygons.iter().map(home_tile).collect();
		homes.sort_unstable();
		homes.dedup();
		let box_ = bounds_of(polygons.iter().flat_map(|polygon| polygon.exterior().0.iter().copied()));
		let context: Vec<(u32, u32)> = tiles_near(box_, margin_world((box_[1] + box_[3]) / 2.0))
			.filter(|tile| homes.binary_search(tile).is_err())
			.collect();
		let slot = rayon::current_thread_index().map_or(threads, |index| index.min(threads));
		let mut writer = writers[slot].lock().unwrap();
		let home_row = encode_row(true, record.id, &tags, &polygons);
		let context_row = encode_row(false, record.id, &tags, &polygons);
		for (x, y) in homes {
			if let Err(error) = writer.add(hrt_pmtiles::tile_id(TILE_ZOOM, x, y), &home_row) {
				failure.lock().unwrap().get_or_insert(error);
			}
		}
		for (x, y) in context {
			if let Err(error) = writer.add(hrt_pmtiles::tile_id(TILE_ZOOM, x, y), &context_row) {
				failure.lock().unwrap().get_or_insert(error);
			}
		}
	})?;
	for writer in writers {
		writer.into_inner().unwrap().finish()?;
	}
	if let Some(error) = failure.into_inner().unwrap() {
		return Err(error);
	}
	let mut report = Report {
		rows,
		osm_buildings: osm_inputs.buildings.len() as u64,
		osm_roads: osm_inputs.roads.len() as u64,
		joined: joined.into_inner(),
		..Report::default()
	};
	let mut options = WriterOptions {
		tile_type: TileType::Unknown,
		// Each body is already gzipped, so the tile worker passes it through and the client decompresses it.
		tile_compression: Compression::None,
		zoom_range: Some((TILE_ZOOM, TILE_ZOOM)),
		..WriterOptions::default()
	};
	if let Some(bounds) = bounds {
		options.bounds = bounds;
	}
	let mut archive = Writer::new(options, tempfile::tempfile_in(scratch)?);
	let mut batch: Vec<(u64, Vec<SortedRow>)> = Vec::new();
	let mut flush = |batch: &mut Vec<(u64, Vec<SortedRow>)>, report: &mut Report| -> io::Result<()> {
		let outputs: Vec<(u64, TileOutput)> = batch
			.par_iter()
			.map(|(tile, rows)| {
				let (_, x, y) = hrt_pmtiles::tile_id_to_zxy(*tile);
				(*tile, process_tile((x, y), rows, &osm_inputs))
			})
			.collect();
		for (tile, output) in outputs {
			for (total, count) in report.edges.iter_mut().zip(output.edges) {
				*total += count;
			}
			report.attached += output.attached;
			report.enclosed += output.enclosed;
			if output.records.is_empty() {
				continue;
			}
			report.records += output.records.len() as u64;
			archive.add_tile(tile, &tile_body(&output.records)?)?;
			report.tiles += 1;
		}
		batch.clear();
		Ok(())
	};
	for entry in sorter.merge()? {
		let (tile, bytes) = entry?;
		let row = decode_row(&bytes)?;
		match batch.last_mut() {
			Some((current, rows)) if *current == tile => rows.push(row),
			_ => {
				if batch.len() == TILES_PER_BATCH {
					flush(&mut batch, &mut report)?;
				}
				batch.push((tile, vec![row]));
			}
		}
	}
	flush(&mut batch, &mut report)?;
	let metadata = r#"{"name":"mailwoman buildings","format":"mwb2","description":"Overture building footprints for GPU extrusion with facade classes per wall, one gzipped MWB2 body per z14 tile","vector_layers":[]}"#;
	let mut out = BufWriter::new(File::create(output)?);
	let summary = archive.finish(metadata.as_bytes(), &mut out)?;
	out.flush()?;
	report.archive_bytes = summary.archive_length;
	Ok(report)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_sorted_row_round_trips() {
		let polygon = Polygon::new(
			LineString::from(vec![(0.1, 0.2), (0.3, 0.2), (0.3, 0.4), (0.1, 0.2)]),
			vec![LineString::from(vec![
				(0.15, 0.25),
				(0.2, 0.25),
				(0.2, 0.3),
				(0.15, 0.25),
			])],
		);
		let tags = Tags(vec![
			("theme".into(), "buildings".into()),
			("osm:shop".into(), "bakery".into()),
		]);
		let row = decode_row(&encode_row(true, 7, &tags, std::slice::from_ref(&polygon))).unwrap();
		assert!(row.home);
		assert_eq!(row.id, 7);
		assert_eq!(row.tags, tags);
		assert_eq!(row.polygons, [polygon]);
	}

	#[test]
	fn the_parts_of_a_brick_building_share_its_group_seed_district_and_material() {
		let square = |x: f64| {
			Polygon::new(
				LineString::from(vec![(x, 0.3), (x + 0.00001, 0.3), (x + 0.00001, 0.30001), (x, 0.3)]),
				vec![],
			)
		};
		let row = |tags: Vec<(&str, &str)>, x: f64| SortedRow {
			home: true,
			id: 1,
			tags: Tags(tags.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect()),
			polygons: vec![square(x)],
		};
		let rows = vec![
			row(
				vec![
					("id", "outline"),
					("type", "building"),
					("has_parts", "true"),
					("osm:building:material", "brick"),
					("osm:start_date", "1914"),
				],
				0.5,
			),
			row(
				vec![("id", "east"), ("type", "building_part"), ("building_id", "outline")],
				0.50001,
			),
			row(
				vec![("id", "west"), ("type", "building_part"), ("building_id", "outline")],
				0.49999,
			),
			row(vec![("id", "loose"), ("type", "building")], 0.6),
		];
		let by_id: HashMap<&str, usize> = rows
			.iter()
			.enumerate()
			.map(|(i, r)| (r.tags.get("id").unwrap(), i))
			.collect();
		let group = |index: usize| style_group(&rows[index], &rows[index].polygons[0], &rows, &by_id);
		let (east, west, loose) = (group(1), group(2), group(3));
		assert_eq!(east.seed, west.seed);
		assert_ne!(east.element_id, west.element_id);
		assert_eq!(east.district_center, west.district_center);
		assert_eq!(east.tags.get("building:material").map(String::as_str), Some("brick"));
		// The outline's year rides in the group seed, as Arnis packs it for pre-war buildings.
		assert_eq!(hrt_facade::seed::year_from_seed(east.seed), Some(1914));
		assert_eq!(loose.seed, loose.element_id);
	}

	#[test]
	fn an_overture_record_id_names_its_osm_element() {
		assert_eq!(osm_element("w783697382@1"), Some(('w', 783_697_382)));
		assert_eq!(osm_element("r42@7"), Some(('r', 42)));
		assert_eq!(osm_element("n5@1"), None);
	}
}
