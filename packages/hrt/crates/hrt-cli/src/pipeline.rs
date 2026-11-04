// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The build pipeline: OpenStreetMap features through a profile, the renderer, the sort, and the tile encoder into a
//! PMTiles archive.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use flate2::write::GzEncoder;
use hrt_e::{encode_tile, LayerBuilder, Value, DEFAULT_EXTENT};
use hrt_osm::coords::{world_x, world_y};
use hrt_osm::{header_bounds, pass1, pass2};
use hrt_pmtiles::{tile_id, ArchiveSummary, Writer, WriterOptions};
use hrt_profile::{Emitted, Profile, TileFeature, TileLayers};
use hrt_render::commands::unscale;
use hrt_render::{GeometryType, RenderConfig, RenderCounts, Renderer};
use hrt_sort::key::{layer_of, tile_of};
use hrt_sort::{encode_key, FeatureRecord, Sorter, Tiles};
use rayon::prelude::*;

use crate::progress::{Progress, Work};

/// The number of zooms [`ZoomTimes`] keeps, 0 to 15.
const ZOOMS: usize = 16;

/// The most layers [`ZoomTimes`] keeps per zoom. The basemap profile has thirteen.
const MAX_LAYERS: usize = 32;

/// A tile with more records than this post-processes its layers on several threads.
const PARALLEL_LAYER_RECORDS: usize = 20_000;

/// Thread time spent encoding each zoom's tiles: in total, per layer in post-processing, and in the slowest tile.
struct ZoomTimes {
	tiles: [AtomicU64; ZOOMS],
	total_nanos: [AtomicU64; ZOOMS],
	layer_nanos: Vec<[AtomicU64; MAX_LAYERS]>,
	slowest: Vec<Mutex<(u64, u64)>>,
	slowest_nanos: [AtomicU64; ZOOMS],
}

impl ZoomTimes {
	fn new() -> ZoomTimes {
		ZoomTimes {
			tiles: Default::default(),
			total_nanos: Default::default(),
			layer_nanos: (0..ZOOMS).map(|_| Default::default()).collect(),
			slowest: (0..ZOOMS).map(|_| Mutex::new((0, 0))).collect(),
			slowest_nanos: Default::default(),
		}
	}

	fn add_layer(&self, zoom: u8, layer: usize, took: Duration) {
		if let (Some(row), true) = (self.layer_nanos.get(usize::from(zoom)), layer < MAX_LAYERS) {
			row[layer].fetch_add(took.as_nanos() as u64, Ordering::Relaxed);
		}
	}

	fn add_tile(&self, tile_id: u64, took: Duration) {
		let zoom = usize::from(hrt_pmtiles::tile_id_to_zxy(tile_id).0);
		if zoom >= ZOOMS {
			return;
		}
		let nanos = took.as_nanos() as u64;
		self.tiles[zoom].fetch_add(1, Ordering::Relaxed);
		self.total_nanos[zoom].fetch_add(nanos, Ordering::Relaxed);
		if nanos > self.slowest_nanos[zoom].load(Ordering::Relaxed) {
			let mut slowest = self.slowest[zoom].lock().unwrap();
			if nanos > slowest.1 {
				*slowest = (tile_id, nanos);
				self.slowest_nanos[zoom].store(nanos, Ordering::Relaxed);
			}
		}
	}

	/// A line giving zoom `zoom`'s tiles, thread time by layer with the largest first, and its slowest tile.
	fn summary(&self, zoom: u8, layer_names: &[&str], wall: Duration) -> String {
		let z = usize::from(zoom);
		let seconds = |nanos: u64| nanos as f64 / 1e9;
		let mut layers: Vec<(&str, u64)> = layer_names
			.iter()
			.enumerate()
			.take(MAX_LAYERS)
			.map(|(index, name)| (*name, self.layer_nanos[z][index].load(Ordering::Relaxed)))
			.filter(|(_, nanos)| *nanos > 0)
			.collect();
		layers.sort_by_key(|(_, nanos)| std::cmp::Reverse(*nanos));
		let layers: Vec<String> = layers
			.iter()
			.map(|(name, nanos)| format!("{name} {:.0} s", seconds(*nanos)))
			.collect();
		let (slowest_id, slowest_nanos) = *self.slowest[z].lock().unwrap();
		let (_, x, y) = hrt_pmtiles::tile_id_to_zxy(slowest_id);
		format!(
			"z{zoom} written: {} tiles in {:.0} s; encode thread time {:.0} s; post-processing by layer: {}; slowest tile {zoom}/{x}/{y} {:.1} s",
			self.tiles[z].load(Ordering::Relaxed),
			wall.as_secs_f64(),
			seconds(self.total_nanos[z].load(Ordering::Relaxed)),
			if layers.is_empty() { "none".to_owned() } else { layers.join(", ") },
			seconds(slowest_nanos),
		)
	}
}

/// Counts from a build.
#[derive(Debug, Default)]
pub struct BuildReport {
	pub render: RenderCounts,
	pub records: u64,
	pub tiles: u64,
	pub archive: Option<ArchiveSummary>,
}

fn type_code(geom_type: GeometryType) -> u64 {
	match geom_type {
		GeometryType::Unknown => 0,
		GeometryType::Point => 1,
		GeometryType::Line => 2,
		GeometryType::Polygon => 3,
	}
}

/// Encodes one tile's sorted records, layers in name order, or `None` when the tile has no layer lists.
///
/// Each layer's features go through the profile's post-processing first, at the precision they were rendered with,
/// and lines are reduced to the tile extent afterwards, as in Planetiler's `FeatureGroup`. A tile with more than
/// [`PARALLEL_LAYER_RECORDS`] records post-processes its layers on several threads; the layers keep their order.
fn encode(entries: &[(u64, Vec<u8>)], profile: &impl Profile, times: &ZoomTimes) -> io::Result<Option<Vec<u8>>> {
	let Some(&(first_key, _)) = entries.first() else {
		return Ok(None);
	};
	let (zoom, tile_x, tile_y) = hrt_pmtiles::tile_id_to_zxy(tile_of(first_key));
	let layer_names = profile.layers();
	let mut by_layer: TileLayers = Vec::new();
	for (key, value) in entries {
		let name = layer_names[layer_of(*key) as usize];
		let record =
			FeatureRecord::decode(value, hrt_sort::key::has_group(*key)).map_err(|error| io::Error::other(error.0))?;
		let feature = TileFeature {
			id: record.id,
			geometry: record.geometry,
			attributes: record.attributes,
		};
		match by_layer.last_mut() {
			Some((current, features)) if *current == name => features.push(feature),
			_ => by_layer.push((name, vec![feature])),
		}
	}
	by_layer.sort_by(|a, b| a.0.cmp(b.0));
	let by_layer = profile.post_process_tile(zoom, tile_x, tile_y, by_layer);

	let post_process = |(name, features): (&'static str, Vec<TileFeature>)| {
		let started = Instant::now();
		let processed = profile.post_process(name, zoom, features);
		if let Some(index) = layer_names.iter().position(|layer| *layer == name) {
			times.add_layer(zoom, index, started.elapsed());
		}
		(name, processed)
	};
	let by_layer: Vec<(&str, Vec<TileFeature>)> = if entries.len() > PARALLEL_LAYER_RECORDS {
		by_layer.into_par_iter().map(post_process).collect()
	} else {
		by_layer.into_iter().map(post_process).collect()
	};

	let mut layers = Vec::with_capacity(by_layer.len());
	for (name, processed) in by_layer {
		// Planetiler adds a layer only when post-processing left it a feature, and skips a tile left with no layers.
		if processed.is_empty() {
			continue;
		}
		let mut layer = LayerBuilder::new(name, DEFAULT_EXTENT);
		for feature in processed {
			let geometry = unscale(&feature.geometry);
			let attributes: Vec<(&str, Value)> = feature
				.attributes
				.iter()
				.map(|(key, value)| (key.as_str(), value.clone()))
				.collect();
			let id = (feature.id != 0).then_some(feature.id as u64);
			layer.add_encoded_feature(id, type_code(geometry.geom_type), &geometry.commands, &attributes);
		}
		layers.push(layer);
	}
	if layers.is_empty() {
		return Ok(None);
	}
	Ok(Some(encode_tile(&layers)))
}

/// Returns the build's bounds from the input file's header, `[west, south, east, north]` degrees, or `None` for the
/// whole world. As in Planetiler, a header box with no area counts as absent.
pub fn input_bounds(input: &Path) -> io::Result<Option<[f64; 4]>> {
	Ok(header_bounds(input)?.filter(|[west, south, east, north]| (east - west) * (north - south) > 0.0))
}

/// Returns the renderer settings for a build of `max_zoom` within `bounds`.
pub fn render_config(max_zoom: u8, bounds: Option<[f64; 4]>) -> RenderConfig {
	match bounds {
		None => RenderConfig::world(max_zoom),
		Some([west, south, east, north]) => RenderConfig {
			max_zoom,
			world_bounds: [world_x(west), world_y(north), world_x(east), world_y(south)],
		},
	}
}

fn gzip(bytes: &[u8]) -> io::Result<Vec<u8>> {
	let mut encoder = GzEncoder::new(Vec::with_capacity(bytes.len() / 2 + 64), flate2::Compression::default());
	encoder.write_all(bytes)?;
	encoder.finish()
}

/// The format of an input other than the OpenStreetMap file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceFormat {
	/// A GeoPackage, possibly zipped.
	GeoPackage,
	/// A zip archive holding one or more shapefiles.
	ShapefileZip,
	/// A GeoParquet file, or a directory of them such as an Overture theme with its hive partitions.
	GeoParquet,
}

/// An input other than the OpenStreetMap file, under the source name the profile routes on.
#[derive(Clone, Debug)]
pub struct ExtraSource {
	pub name: String,
	pub path: std::path::PathBuf,
	pub format: SourceFormat,
}

/// Renders a profile's features into the per-thread sort writers.
struct Emitter<'a, 's> {
	writers: &'a [Mutex<hrt_sort::ChunkWriter<'s>>],
	threads: usize,
	config: RenderConfig,
	render_counts: &'a Mutex<RenderCounts>,
	failure: &'a Mutex<Option<io::Error>>,
}

impl Emitter<'_, '_> {
	fn emit(&self, emitted: &[Emitted]) {
		if emitted.is_empty() {
			return;
		}
		let slot = rayon::current_thread_index().map_or(self.threads, |index| index.min(self.threads));
		let mut writer = self.writers[slot].lock().unwrap();
		let mut bytes = Vec::new();
		for emitted in emitted {
			let mut zoom_attributes: Option<(u8, Vec<(String, Value)>)> = None;
			let mut sink = |rendered: hrt_render::RenderedFeature| {
				// The renderer works from the highest zoom down, so the attributes are computed once per zoom.
				if zoom_attributes.as_ref().is_none_or(|(zoom, _)| *zoom != rendered.z) {
					zoom_attributes = Some((rendered.z, emitted.attributes_at(rendered.z)));
				}
				let attributes = &zoom_attributes.as_ref().unwrap().1;
				let key = encode_key(
					tile_id(rendered.z, rendered.x as u32, rendered.y as u32),
					rendered.layer as u8,
					rendered.sort_key,
					rendered.group.is_some(),
				);
				bytes.clear();
				FeatureRecord {
					group: rendered.group,
					id: rendered.id,
					geometry: rendered.geometry,
					attributes: attributes.clone(),
				}
				.encode(&mut bytes);
				if let Err(error) = writer.add(key, &bytes) {
					self.failure.lock().unwrap().get_or_insert(error);
				}
			};
			let mut renderer = Renderer::new(self.config, &mut sink);
			renderer.render(&emitted.feature);
			let counts = renderer.counts;
			self.render_counts.lock().unwrap().add(&counts);
		}
	}
}

/// Reads an extra source within `bounds` and renders its features, a batch at a time on rayon's threads.
fn process_extra_source(
	source: &ExtraSource,
	bounds: Option<[f64; 4]>,
	profile: &impl Profile,
	emitter: &Emitter<'_, '_>,
	progress: &Progress,
) -> io::Result<u64> {
	// Extractions are kept beside the archive, so a later build reuses them.
	let cache = source.path.with_extension("hrt-unzipped");
	std::fs::create_dir_all(&cache)?;
	let empty_nodes = hrt_osm::NodeStore::default();
	let mut batch: Vec<hrt_sources::Record> = Vec::with_capacity(1024);
	let flush = |batch: &mut Vec<hrt_sources::Record>| {
		batch.par_iter().for_each(|record| {
			let feature = hrt_osm::SourceFeature::fixed(
				record.id,
				hrt_osm::ElementKind::Other,
				(source.name.as_str(), record.layer.as_str()),
				&record.tags,
				record.geometry.clone(),
				&empty_nodes,
			);
			emitter.emit(&profile.process(&feature));
		});
		batch.clear();
	};
	let mut each = |record: hrt_sources::Record| {
		batch.push(record);
		if batch.len() == batch.capacity() {
			flush(&mut batch);
		}
	};
	let mut count = 0;
	match source.format {
		SourceFormat::GeoPackage => {
			let path = if source.path.extension().is_some_and(|ext| ext == "zip") {
				hrt_sources::geopackage::unzip_geopackage(&source.path, &cache)?
			} else {
				source.path.clone()
			};
			count += hrt_sources::geopackage::read(&path, bounds, &mut each)?;
		}
		SourceFormat::ShapefileZip => {
			for shapefile in hrt_sources::shapefile_zip::unzip_shapefiles(&source.path, &cache)? {
				count += hrt_sources::shapefile_zip::read(&shapefile, bounds, &mut each)?;
			}
		}
		// The reader runs its row groups on rayon's threads, so each record renders on the thread that read it.
		SourceFormat::GeoParquet => {
			count += hrt_sources::overture::read(&source.path, bounds, |record| {
				let _working = progress.working(Work::Other(record.id));
				let feature = hrt_osm::SourceFeature::fixed(
					record.id,
					hrt_osm::ElementKind::Other,
					(source.name.as_str(), record.layer.as_str()),
					&record.tags,
					record.geometry,
					&empty_nodes,
				);
				emitter.emit(&profile.process(&feature));
				progress.tick();
			})?;
		}
	}
	flush(&mut batch);
	Ok(count)
}

/// The progress stage name of an extra source.
fn source_stage(name: &str) -> &'static str {
	match name {
		"ne" => "source: Natural Earth",
		"osm_water" => "source: OSM water polygons",
		"osm_land" => "source: OSM land polygons",
		"landcover" => "source: Daylight land cover",
		"overture_buildings" => "source: Overture buildings",
		_ => "source: other",
	}
}

/// Builds an archive from the OpenStreetMap file `input`, when given, and the extra sources. The archive covers
/// `bounds` (`[west, south, east, north]` degrees) when given, else the OpenStreetMap file's header bounds, else the
/// world.
pub fn build(
	input: Option<&Path>,
	bounds: Option<[f64; 4]>,
	extra_sources: &[ExtraSource],
	output: &Path,
	scratch: &Path,
	profile: &impl Profile,
) -> io::Result<BuildReport> {
	let progress = Progress::start();
	let state = match input {
		Some(input) => {
			progress.stage("pass 1: relations and node locations", "");
			Some(pass1(input, |relation| profile.keep_relation(relation))?)
		}
		None => None,
	};
	let sorter = Sorter::new(scratch, 64 << 20);
	let threads = rayon::current_num_threads();
	let writers: Vec<Mutex<_>> = (0..=threads).map(|_| Mutex::new(sorter.writer())).collect();
	let render_counts = Mutex::new(RenderCounts::default());
	let failure: Mutex<Option<io::Error>> = Mutex::new(None);
	let bounds = match (bounds, input) {
		(Some(bounds), _) => Some(bounds),
		(None, Some(input)) => input_bounds(input)?,
		(None, None) => None,
	};
	let config = render_config(profile.max_zoom(), bounds);
	let emitter = Emitter {
		writers: &writers,
		threads,
		config,
		render_counts: &render_counts,
		failure: &failure,
	};

	if let (Some(input), Some(state)) = (input, &state) {
		progress.stage("pass 2: OSM features", "features");
		pass2(input, state, |source| {
			let _working = progress.working(match source.kind {
				hrt_osm::ElementKind::Node => Work::Node(source.id),
				hrt_osm::ElementKind::Way => Work::Way(source.id),
				hrt_osm::ElementKind::Relation => Work::Relation(source.id),
				hrt_osm::ElementKind::Other => Work::Other(source.id),
			});
			emitter.emit(&profile.process(source));
			progress.tick();
		})?;
	}
	for source in extra_sources {
		let unit = if source.format == SourceFormat::GeoParquet {
			"features"
		} else {
			""
		};
		progress.stage(source_stage(&source.name), unit);
		process_extra_source(source, bounds, profile, &emitter, &progress)?;
	}
	progress.stage("sort: flushing chunks", "");
	for writer in writers {
		writer.into_inner().unwrap().finish()?;
	}
	if let Some(error) = failure.into_inner().unwrap() {
		return Err(error);
	}

	let mut report = BuildReport {
		render: render_counts.into_inner().unwrap(),
		records: sorter.records(),
		..BuildReport::default()
	};
	let mut options = WriterOptions {
		zoom_range: Some((0, profile.max_zoom())),
		..WriterOptions::default()
	};
	if let Some(bounds) = bounds {
		options.bounds = bounds;
	}
	let mut archive = Writer::new(options, tempfile::tempfile_in(scratch)?);
	// Tiles encode independently. This thread reads tiles from the merge and hands each to rayon's threads, keeping up
	// to `window` tiles between the merge and the archive, and writes the encoded tiles in tile order, which the archive
	// writer requires. A slow tile holds back only the writing; the other threads go on encoding the tiles after it.
	let window = (threads * 1024) as u64;
	let times = ZoomTimes::new();
	let layer_names = profile.layers();
	progress.stage("merge and encode", "tiles");
	let mut tiles = Tiles::new(sorter.merge()?);
	// A tile id and its gzipped body, or `None` for a tile left with no layers.
	type Encoded = (u64, io::Result<Option<Vec<u8>>>);
	let (sender, receiver) = mpsc::channel::<(u64, Encoded)>();
	rayon::in_place_scope(|scope| -> io::Result<()> {
		let mut pending: BTreeMap<u64, Encoded> = BTreeMap::new();
		let (mut handed_out, mut written) = (0u64, 0u64);
		let mut exhausted = false;
		let mut zoom: Option<(u8, Instant)> = None;
		loop {
			while !exhausted && handed_out - written < window {
				let Some(tile) = tiles.next() else {
					exhausted = true;
					break;
				};
				let tile = tile?;
				let (sequence, sender, times, progress) = (handed_out, sender.clone(), &times, &progress);
				handed_out += 1;
				scope.spawn(move |_| {
					let working = progress.working(Work::Tile(tile.tile_id));
					let body =
						encode(&tile.entries, profile, times).and_then(|bytes| bytes.map(|b| gzip(&b)).transpose());
					times.add_tile(tile.tile_id, working.elapsed());
					drop(working);
					// The receiver is gone only after an earlier tile failed, and that error is the one reported.
					let _ = sender.send((sequence, (tile.tile_id, body)));
				});
			}
			if written == handed_out {
				break;
			}
			let (sequence, encoded) = receiver.recv().map_err(io::Error::other)?;
			pending.insert(sequence, encoded);
			while let Some((tile_id, body)) = pending.remove(&written) {
				let tile_zoom = hrt_pmtiles::tile_id_to_zxy(tile_id).0;
				match zoom {
					Some((current, _)) if current == tile_zoom => {}
					Some((current, started)) => {
						eprintln!("progress {}", times.summary(current, layer_names, started.elapsed()));
						zoom = Some((tile_zoom, Instant::now()));
					}
					None => zoom = Some((tile_zoom, Instant::now())),
				}
				if let Some(body) = body? {
					archive.add_tile(tile_id, &body)?;
					report.tiles += 1;
				}
				written += 1;
				progress.add(1);
				progress.tile(tile_id);
			}
		}
		if let Some((current, started)) = zoom {
			eprintln!("progress {}", times.summary(current, layer_names, started.elapsed()));
		}
		Ok(())
	})?;
	progress.stage("write archive", "");
	let mut out = BufWriter::new(File::create(output)?);
	report.archive = Some(archive.finish(profile.metadata().as_bytes(), &mut out)?);
	out.flush()?;
	Ok(report)
}
