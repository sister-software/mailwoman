// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `hrt`, the Hilbert Rust Tiler.
//!
//! Commands:
//! - `hrt render-test <input.osm.pbf> <output.pmtiles>` builds an archive with the parity profile.
//! - `hrt basemap-test <input.osm.pbf> <output.pmtiles> layer=<name>[,<name>] [borders=<borders.json>] [raw]
//!   [places=<places.csv>] [qrank=<qrank.csv.gz>] [ne=<gpkg or zip>] [osm-water=<zip>] [osm-land=<zip>]
//!   [landcover=<daylight-landcover.gpkg>] [clip=<polygon.geojson>] [clip-buffer=<pixels>] [pgf=<pgf-encoding.zip>]
//!   [overture-buildings=<theme=buildings directory>] [no-footprints] [bounds=<west,south,east,north>]`
//!   builds ported layers of the basemap profile as `packages/hrt/parity/LayerDump.java` builds the fork's own. An
//!   input of `-` reads no OpenStreetMap file. `overture-buildings` takes the `buildings` layer's footprints from
//!   Overture instead of OpenStreetMap, `no-footprints` keeps only its address points, and `bounds` replaces the
//!   OpenStreetMap header's bounds, which a build without an OpenStreetMap file otherwise lacks. `raw`
//!   skips post-processing, `clip` clips every tile to the polygon, buffered by `clip-buffer` (default 4) pixels of a
//!   256-pixel tile as a fraction of the polygon's larger side, and `pgf` registers the fork's fonts so names in their
//!   scripts get `pgf:` attributes.
//! - `hrt building-tiles <theme=buildings directory> <output.pmtiles> [bounds=<west,south,east,north>]
//!   [osm=<input.osm.pbf>]` writes the compact building tiles `hrt_profile::building_buffers` describes, one per z14
//!   tile. With an OpenStreetMap file, buildings join its tags and walls are classified against its roads.
//! - `hrt pgf-probe <pgf-encoding.zip> <names.txt> <out.tsv>` writes each name beside its `pgf:` encoding, for
//!   comparison with `packages/hrt/parity/PgfProbe.java`.
//! - `hrt render-dump <input.osm.pbf>` prints every tile piece the parity profile renders, in the line format of
//!   `packages/hrt/parity/RenderDump.java`.
//! - `hrt clock <a.pmtiles> <b.pmtiles> [max details]` compares two archives tile by tile and exits 1 when any tile
//!   differs.
//! - `hrt record <archive.pmtiles> <out.jsonl>` writes the per-tile parity record: each layer's feature count and the
//!   digest of its features in the form `clock` compares.

mod basemap_profile;
mod building_tiles;
mod clock;
mod merge_probe;
mod parity_profile;
mod pgf_probe;
mod pipeline;
mod progress;
mod record;
mod render_dump;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use hrt_profile::Profile;

/// Builds `output` with `profile`. An `input` of `-` reads no OpenStreetMap file, for an archive built from the extra
/// sources alone.
fn build(
	input: &str,
	bounds: Option<[f64; 4]>,
	extra: &[pipeline::ExtraSource],
	output: &str,
	profile: &impl Profile,
) -> ExitCode {
	let started = Instant::now();
	let output = PathBuf::from(output);
	let input = (input != "-").then(|| PathBuf::from(input));
	let scratch = tempfile::tempdir().expect("a scratch directory");
	match pipeline::build(input.as_deref(), bounds, extra, &output, scratch.path(), profile) {
		Ok(report) => {
			eprintln!("render: {:?}", report.render);
			eprintln!("sorted {} records into {} tiles", report.records, report.tiles);
			if let Some(archive) = &report.archive {
				eprintln!("archive: {archive:?}");
			}
			eprintln!("built {} in {:.2?}", output.display(), started.elapsed());
			ExitCode::SUCCESS
		}
		Err(error) => {
			eprintln!("build failed: {error}");
			ExitCode::FAILURE
		}
	}
}

/// `west,south,east,north` degrees, or `None` unless all four parse and west < east and south < north.
fn parse_bounds(text: &str) -> Option<[f64; 4]> {
	let values: Vec<f64> = text.split(',').filter_map(|part| part.parse().ok()).collect();
	match values[..] {
		[west, south, east, north] if west < east && south < north => Some([west, south, east, north]),
		_ => None,
	}
}

fn usage() -> ExitCode {
	eprintln!("usage: hrt render-test <input.osm.pbf> <output.pmtiles>");
	eprintln!(
		"       hrt basemap-test <input.osm.pbf> <output.pmtiles> layer=<name>[,<name>] [borders=<path>] [places=<path>] [qrank=<path>] [raw] [ne=<path>] [osm-water=<path>] [osm-land=<path>] [landcover=<path>] [clip=<path>] [clip-buffer=<pixels>] [pgf=<path>] [overture-buildings=<dir>] [no-footprints] [bounds=<w,s,e,n>]"
	);
	eprintln!(
		"       hrt building-tiles <theme=buildings dir> <output.pmtiles> [bounds=<w,s,e,n>] [osm=<file.osm.pbf>]"
	);
	eprintln!("       hrt pgf-probe <pgf-encoding.zip> <names.txt> <out.tsv>");
	eprintln!("       hrt render-dump <input.osm.pbf>");
	eprintln!("       hrt clock <a.pmtiles> <b.pmtiles> [max details]");
	eprintln!("       hrt record <archive.pmtiles> <out.jsonl>");
	ExitCode::from(2)
}

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	match args.first().map(String::as_str) {
		Some("render-test") if args.len() == 3 => build(&args[1], None, &[], &args[2], &parity_profile::ParityProfile),
		Some("merge-probe") if args.len() == 6 => {
			let tile: Vec<u32> = args[2].split('/').filter_map(|part| part.parse().ok()).collect();
			if tile.len() != 3 {
				return usage();
			}
			match merge_probe::probe(
				&PathBuf::from(&args[1]),
				tile[0] as u8,
				tile[1],
				tile[2],
				&args[3],
				&args[4],
				&PathBuf::from(&args[5]),
			) {
				Ok(()) => ExitCode::SUCCESS,
				Err(error) => {
					eprintln!("merge-probe failed: {error}");
					ExitCode::FAILURE
				}
			}
		}
		Some("building-tiles") if (3..=5).contains(&args.len()) => {
			let mut bounds = None;
			let mut osm = None;
			for option in &args[3..] {
				if let Some(text) = option.strip_prefix("bounds=") {
					let Some(parsed) = parse_bounds(text) else {
						eprintln!("bounds must be bounds=west,south,east,north degrees, but was {option}");
						return ExitCode::FAILURE;
					};
					bounds = Some(parsed);
				} else if let Some(path) = option.strip_prefix("osm=") {
					osm = Some(PathBuf::from(path));
				} else {
					eprintln!("building-tiles takes bounds=<w,s,e,n> and osm=<file.osm.pbf>, but was given {option}");
					return ExitCode::FAILURE;
				}
			}
			let started = Instant::now();
			let scratch = tempfile::tempdir().expect("a scratch directory");
			match building_tiles::build(
				&PathBuf::from(&args[1]),
				bounds,
				osm.as_deref(),
				&PathBuf::from(&args[2]),
				scratch.path(),
			) {
				Ok(report) => {
					eprintln!(
						"read {} rows; wrote {} building records into {} tiles, {} bytes",
						report.rows, report.records, report.tiles, report.archive_bytes
					);
					eprintln!(
						"OpenStreetMap: {} buildings, {} roads, {} rows joined",
						report.osm_buildings, report.osm_roads, report.joined
					);
					let [street, rear, party, open] = report.edges;
					eprintln!(
						"walls: {street} street, {rear} rear, {party} party, {open} open; {} attached, {} enclosed",
						report.attached, report.enclosed
					);
					eprintln!("built {} in {:.2?}", args[2], started.elapsed());
					ExitCode::SUCCESS
				}
				Err(error) => {
					eprintln!("building-tiles failed: {error}");
					ExitCode::FAILURE
				}
			}
		}
		Some("pgf-probe") if args.len() == 4 => {
			match pgf_probe::probe(
				&PathBuf::from(&args[1]),
				&PathBuf::from(&args[2]),
				&PathBuf::from(&args[3]),
			) {
				Ok((lines, missing)) => {
					eprintln!("encoded {lines} names; {missing} glyphs missing from the table");
					ExitCode::SUCCESS
				}
				Err(error) => {
					eprintln!("pgf-probe failed: {error}");
					ExitCode::FAILURE
				}
			}
		}
		Some("basemap-test") if args.len() >= 4 => {
			let mut raw = false;
			let mut layers: Vec<String> = Vec::new();
			let mut countries = None;
			let mut wikidata = None;
			let mut qrank = None;
			let mut extra = Vec::new();
			let mut clip_path = None;
			let mut clip_buffer = hrt_profile::clip::DEFAULT_BUFFER;
			let mut fonts = None;
			let mut bounds = None;
			let mut footprints = hrt_profile::layers::buildings::Footprints::Osm;
			for option in &args[3..] {
				if let Some(path) = option.strip_prefix("overture-buildings=") {
					extra.push(pipeline::ExtraSource {
						name: "overture_buildings".into(),
						path: path.into(),
						format: pipeline::SourceFormat::GeoParquet,
					});
					if footprints == hrt_profile::layers::buildings::Footprints::Osm {
						footprints = hrt_profile::layers::buildings::Footprints::Overture;
					}
				} else if option == "no-footprints" {
					footprints = hrt_profile::layers::buildings::Footprints::None;
				} else if let Some(text) = option.strip_prefix("bounds=") {
					match parse_bounds(text) {
						Some(parsed) => bounds = Some(parsed),
						None => {
							eprintln!("bounds must be west,south,east,north degrees, but was {text}");
							return ExitCode::FAILURE;
						}
					}
				} else if let Some(path) = option.strip_prefix("pgf=") {
					let path = PathBuf::from(path);
					match hrt_profile::pgf::FontRegistry::from_zip(&path, &hrt_profile::pgf::FORK_FONTS) {
						Ok(registry) => fonts = Some(registry),
						Err(error) => {
							eprintln!("could not read the fonts in {}: {error}", path.display());
							return ExitCode::FAILURE;
						}
					}
				} else if let Some(path) = option.strip_prefix("clip=") {
					clip_path = Some(PathBuf::from(path));
				} else if let Some(text) = option.strip_prefix("clip-buffer=") {
					match text.parse::<f64>() {
						Ok(value) if value >= 0.0 => clip_buffer = value,
						_ => {
							eprintln!("clip-buffer must be a number >= 0, but was {text}");
							return ExitCode::FAILURE;
						}
					}
				} else if let Some(path) = option.strip_prefix("qrank=") {
					match hrt_profile::layers::pois::QrankDb::from_gzip_csv(&PathBuf::from(path)) {
						Ok(db) => qrank = Some(db),
						Err(error) => {
							eprintln!("could not read {path}: {error}");
							return ExitCode::FAILURE;
						}
					}
				} else if let Some(path) = option.strip_prefix("places=") {
					match hrt_profile::layers::places::WikidataConfigs::from_path(&PathBuf::from(path)) {
						Ok(configs) => wikidata = Some(configs),
						Err(error) => {
							eprintln!("could not read {path}: {error}");
							return ExitCode::FAILURE;
						}
					}
				} else if option == "raw" {
					raw = true;
				} else if let Some(names) = option.strip_prefix("layer=") {
					layers.extend(names.split(',').map(str::to_owned));
				} else if let Some(path) = option.strip_prefix("borders=") {
					match hrt_profile::country::CountryCoder::from_path(&PathBuf::from(path)) {
						Ok(coder) => countries = Some(coder),
						Err(error) => {
							eprintln!("could not read {path}: {error}");
							return ExitCode::FAILURE;
						}
					}
				} else if let Some(path) = option.strip_prefix("ne=") {
					extra.push(pipeline::ExtraSource {
						name: "ne".into(),
						path: path.into(),
						format: pipeline::SourceFormat::GeoPackage,
					});
				} else if let Some(path) = option.strip_prefix("landcover=") {
					extra.push(pipeline::ExtraSource {
						name: "landcover".into(),
						path: path.into(),
						format: pipeline::SourceFormat::GeoPackage,
					});
				} else if let Some(path) = option.strip_prefix("osm-land=") {
					extra.push(pipeline::ExtraSource {
						name: "osm_land".into(),
						path: path.into(),
						format: pipeline::SourceFormat::ShapefileZip,
					});
				} else if let Some(path) = option.strip_prefix("osm-water=") {
					extra.push(pipeline::ExtraSource {
						name: "osm_water".into(),
						path: path.into(),
						format: pipeline::SourceFormat::ShapefileZip,
					});
				} else {
					return usage();
				}
			}
			let names: Vec<&str> = layers.iter().map(String::as_str).collect();
			let Some(mut profile) = basemap_profile::BasemapProfile::new(&names, countries) else {
				eprintln!("ported layers: {}", basemap_profile::PORTED_LAYERS.join(", "));
				return usage();
			};
			profile.raw = raw;
			profile.fonts = fonts;
			profile.footprints = footprints;
			if let Some(path) = clip_path {
				match hrt_profile::clip::Clip::from_geojson_file(0, basemap_profile::MAX_ZOOM, clip_buffer, &path) {
					Ok(clip) => profile.clip = Some(clip),
					Err(error) => {
						eprintln!("could not build the clip from {}: {error}", path.display());
						return ExitCode::FAILURE;
					}
				}
			}
			if let Some(wikidata) = wikidata {
				profile.wikidata = wikidata;
			}
			if let Some(qrank) = qrank {
				profile.qrank = qrank;
			}
			let code = build(&args[1], bounds, &extra, &args[2], &profile);
			eprintln!("merge snapping: {:?}", profile.merge_counts.lock().unwrap());
			if let Some(clip) = &profile.clip {
				eprintln!("clip failures: {:?}", clip.failures);
			}
			if let Some(fonts) = &profile.fonts {
				eprintln!("pgf glyphs missing from the table: {:?}", fonts.missing_glyphs);
			}
			code
		}
		Some("render-dump") if args.len() == 2 => {
			match render_dump::dump(&PathBuf::from(&args[1]), &parity_profile::ParityProfile) {
				Ok(counts) => {
					eprintln!("{counts:?}");
					ExitCode::SUCCESS
				}
				Err(error) => {
					eprintln!("render-dump failed: {error}");
					ExitCode::FAILURE
				}
			}
		}
		Some("record") if args.len() == 3 => {
			match record::write_record(&PathBuf::from(&args[1]), &PathBuf::from(&args[2])) {
				Ok(tiles) => {
					eprintln!("recorded {tiles} tiles");
					ExitCode::SUCCESS
				}
				Err(error) => {
					eprintln!("record failed: {error}");
					ExitCode::FAILURE
				}
			}
		}
		Some("clock") if args.len() == 3 || args.len() == 4 => {
			let max_details = args.get(3).and_then(|text| text.parse().ok()).unwrap_or(20);
			match clock::compare(&PathBuf::from(&args[1]), &PathBuf::from(&args[2]), max_details) {
				Ok(report) => {
					for detail in &report.details {
						println!("{detail}");
					}
					println!(
						"tiles: {} in a, {} in b; {} only in a, {} only in b",
						report.tiles_a, report.tiles_b, report.only_in_a, report.only_in_b
					);
					println!(
						"shared tiles: {} equal ({} byte-identical, {} differing only in feature order, {} with {} polygons equal within tolerance), {} different; {} features compared",
						report.equal_contents,
						report.identical_bytes,
						report.order_only,
						report.equal_within_tolerance,
						report.polygons_within_tolerance,
						report.different,
						report.features_compared
					);
					if report.lines_joined_differently > 0 {
						println!(
							"different tiles whose layers differ only in how line pieces are joined: {}",
							report.lines_joined_differently
						);
					}
					for text in report.first_byte_difference.values() {
						println!("first equal tile at its zoom whose bytes differ: {text}");
					}
					if report.different + report.only_in_a + report.only_in_b == 0 {
						ExitCode::SUCCESS
					} else {
						ExitCode::FAILURE
					}
				}
				Err(error) => {
					eprintln!("clock failed: {error}");
					ExitCode::from(2)
				}
			}
		}
		_ => usage(),
	}
}
