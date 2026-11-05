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
use hrt_osm::{ElementKind, Tags};
use hrt_pmtiles::{Compression, TileType, Writer, WriterOptions};
use hrt_profile::building_buffers::{
	building_draft, draft_records, home_tile, quantize_polygon, tile_body, unit_meters, EXTENT, TILE_ZOOM,
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
	let (x0, x1) = (hrt_osm::coords::world_x(west) - margin, hrt_osm::coords::world_x(east) + margin);
	let (y0, y1) = (hrt_osm::coords::world_y(north) - margin, hrt_osm::coords::world_y(south) + margin);
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
		.map(|[x, y]| ((f64::from(*x) * unit).round() as i32, (f64::from(*y) * unit).round() as i32))
		.collect()
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
	let mut output = TileOutput::default();
	for (row, draft) in rows.iter().zip(&drafts) {
		let (true, Some(draft)) = (row.home, draft) else {
			continue;
		};
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
			let extra: Vec<(String, String)> =
				osm_tags.0.iter().map(|(key, value)| (format!("osm:{key}"), value.clone())).collect();
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
			vec![LineString::from(vec![(0.15, 0.25), (0.2, 0.25), (0.2, 0.3), (0.15, 0.25)])],
		);
		let tags = Tags(vec![("theme".into(), "buildings".into()), ("osm:shop".into(), "bakery".into())]);
		let row = decode_row(&encode_row(true, 7, &tags, std::slice::from_ref(&polygon))).unwrap();
		assert!(row.home);
		assert_eq!(row.id, 7);
		assert_eq!(row.tags, tags);
		assert_eq!(row.polygons, [polygon]);
	}

	#[test]
	fn an_overture_record_id_names_its_osm_element() {
		assert_eq!(osm_element("w783697382@1"), Some(('w', 783_697_382)));
		assert_eq!(osm_element("r42@7"), Some(('r', 42)));
		assert_eq!(osm_element("n5@1"), None);
	}
}
