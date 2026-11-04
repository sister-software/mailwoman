// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt building-tiles`: an archive of compact building tiles, one per z14 tile, from a synced Overture
//! `theme=buildings/` directory. `hrt_profile::building_buffers` describes the tile body.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;

use hrt_pmtiles::{Compression, TileType, Writer, WriterOptions};
use hrt_profile::building_buffers::{building_records, tile_body, TILE_ZOOM};
use hrt_sort::Sorter;

/// What a build wrote.
#[derive(Default)]
pub struct Report {
	pub rows: u64,
	pub records: u64,
	pub tiles: u64,
	pub archive_bytes: u64,
}

/// Builds `output` from the GeoParquet files under `root`, keeping the rows whose `bbox` meets `bounds` when given.
pub fn build(root: &Path, bounds: Option<[f64; 4]>, output: &Path, scratch: &Path) -> io::Result<Report> {
	let sorter = Sorter::new(scratch, 64 << 20);
	let threads = rayon::current_num_threads();
	let writers: Vec<Mutex<_>> = (0..=threads).map(|_| Mutex::new(sorter.writer())).collect();
	let failure: Mutex<Option<io::Error>> = Mutex::new(None);
	let nodes = hrt_osm::NodeStore::default();
	let rows = hrt_sources::overture::read(root, bounds, |record| {
		let feature = hrt_osm::SourceFeature::fixed(
			record.id,
			hrt_osm::ElementKind::Other,
			("overture_buildings", record.layer.as_str()),
			&record.tags,
			record.geometry,
			&nodes,
		);
		let records = building_records(&hrt_profile::Input::new(&feature));
		if records.is_empty() {
			return;
		}
		let slot = rayon::current_thread_index().map_or(threads, |index| index.min(threads));
		let mut writer = writers[slot].lock().unwrap();
		for (tile, bytes) in records {
			if let Err(error) = writer.add(tile, &bytes) {
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
		records: sorter.records(),
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
	let mut current: Option<u64> = None;
	let mut records: Vec<Vec<u8>> = Vec::new();
	let mut flush = |tile: u64, records: &mut Vec<Vec<u8>>, report: &mut Report| -> io::Result<()> {
		archive.add_tile(tile, &tile_body(records)?)?;
		report.tiles += 1;
		records.clear();
		Ok(())
	};
	for entry in sorter.merge()? {
		let (tile, record) = entry?;
		if current.is_some_and(|previous| previous != tile) {
			flush(current.unwrap(), &mut records, &mut report)?;
		}
		current = Some(tile);
		records.push(record);
	}
	if let Some(tile) = current {
		flush(tile, &mut records, &mut report)?;
	}
	let metadata = r#"{"name":"mailwoman buildings","format":"mwb1","description":"Overture building footprints for GPU extrusion, one gzipped MWB1 body per z14 tile","vector_layers":[]}"#;
	let mut out = BufWriter::new(File::create(output)?);
	let summary = archive.finish(metadata.as_bytes(), &mut out)?;
	out.flush()?;
	report.archive_bytes = summary.archive_length;
	Ok(report)
}
