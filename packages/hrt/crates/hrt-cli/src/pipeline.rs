// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The build pipeline: OpenStreetMap features through a profile, the renderer, the sort, and the tile encoder into a
//! PMTiles archive.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;

use flate2::write::GzEncoder;
use hrt_e::{encode_tile, LayerBuilder, Value, DEFAULT_EXTENT};
use hrt_osm::coords::{world_x, world_y};
use hrt_osm::{header_bounds, pass1, pass2};
use hrt_pmtiles::{tile_id, ArchiveSummary, Writer, WriterOptions};
use hrt_profile::{Profile, TileFeature};
use hrt_render::commands::unscale;
use hrt_render::{GeometryType, RenderConfig, RenderCounts, Renderer};
use hrt_sort::key::{layer_of, tile_of};
use hrt_sort::{encode_key, FeatureRecord, Sorter, Tiles};
use rayon::prelude::*;

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
/// and lines are reduced to the tile extent afterwards, as in Planetiler's `FeatureGroup`.
fn encode(entries: &[(u64, Vec<u8>)], profile: &impl Profile) -> io::Result<Option<Vec<u8>>> {
	let Some(&(first_key, _)) = entries.first() else {
		return Ok(None);
	};
	let (zoom, _, _) = hrt_pmtiles::tile_id_to_zxy(tile_of(first_key));
	let layer_names = profile.layers();
	let mut by_layer: Vec<(&str, Vec<TileFeature>)> = Vec::new();
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

	let mut layers = Vec::with_capacity(by_layer.len());
	for (name, features) in by_layer {
		let processed = profile.post_process(name, zoom, features);
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

/// Builds `output` from the OpenStreetMap file `input` with `profile`, sorting in `scratch`.
pub fn build(input: &Path, output: &Path, scratch: &Path, profile: &impl Profile) -> io::Result<BuildReport> {
	let state = pass1(input, |relation| profile.keep_relation(relation))?;
	let sorter = Sorter::new(scratch, 64 << 20);
	let threads = rayon::current_num_threads();
	let writers: Vec<Mutex<_>> = (0..=threads).map(|_| Mutex::new(sorter.writer())).collect();
	let render_counts = Mutex::new(RenderCounts::default());
	let failure: Mutex<Option<io::Error>> = Mutex::new(None);
	let bounds = input_bounds(input)?;
	let config = render_config(profile.max_zoom(), bounds);

	pass2(input, &state, |source| {
		let emitted = profile.process(source);
		if emitted.is_empty() {
			return;
		}
		let slot = rayon::current_thread_index().map_or(threads, |index| index.min(threads));
		let mut writer = writers[slot].lock().unwrap();
		let mut bytes = Vec::new();
		for emitted in &emitted {
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
					failure.lock().unwrap().get_or_insert(error);
				}
			};
			let mut renderer = Renderer::new(config, &mut sink);
			renderer.render(&emitted.feature);
			let counts = renderer.counts;
			render_counts.lock().unwrap().add(&counts);
		}
	})?;
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
	let mut options = WriterOptions::default();
	if let Some(bounds) = bounds {
		options.bounds = bounds;
	}
	let mut archive = Writer::new(options, tempfile::tempfile_in(scratch)?);
	// Tiles encode independently, so each batch from the merge is encoded and compressed on rayon's threads and then
	// written in tile order, which the archive writer requires.
	let batch_size = threads * 64;
	let mut tiles = Tiles::new(sorter.merge()?);
	loop {
		let batch = tiles.by_ref().take(batch_size).collect::<io::Result<Vec<_>>>()?;
		if batch.is_empty() {
			break;
		}
		let bodies = batch
			.par_iter()
			.map(|tile| encode(&tile.entries, profile)?.map(|bytes| gzip(&bytes)).transpose())
			.collect::<io::Result<Vec<_>>>()?;
		for (tile, body) in batch.iter().zip(bodies) {
			if let Some(body) = body {
				archive.add_tile(tile.tile_id, &body)?;
				report.tiles += 1;
			}
		}
	}
	let mut out = BufWriter::new(File::create(output)?);
	report.archive = Some(archive.finish(profile.metadata().as_bytes(), &mut out)?);
	out.flush()?;
	Ok(report)
}
