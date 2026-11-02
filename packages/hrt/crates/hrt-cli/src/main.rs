// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt`, the Hilbert Rust Tiler.
//!
//! Commands:
//! - `hrt render-test <input.osm.pbf> <output.pmtiles>` builds an archive with the parity profile.
//! - `hrt water-test <input.osm.pbf> <output.pmtiles>` builds the water layer from OpenStreetMap alone, as
//!   `packages/hrt/parity/WaterDump.java` does.
//! - `hrt render-dump <input.osm.pbf>` prints every tile piece the parity profile renders, in the line format of
//!   `packages/hrt/parity/RenderDump.java`.
//! - `hrt clock <a.pmtiles> <b.pmtiles> [max details]` compares two archives tile by tile and exits 1 when any tile
//!   differs.
//! - `hrt record <archive.pmtiles> <out.jsonl>` writes the per-tile parity record: each layer's feature count and the
//!   digest of its features in the form `clock` compares.

mod clock;
mod merge_probe;
mod parity_profile;
mod pipeline;
mod record;
mod render_dump;
mod water_profile;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use hrt_profile::Profile;

fn build(input: &str, output: &str, profile: &impl Profile) -> ExitCode {
	let started = Instant::now();
	let output = PathBuf::from(output);
	let scratch = tempfile::tempdir().expect("a scratch directory");
	match pipeline::build(&PathBuf::from(input), &output, scratch.path(), profile) {
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

fn usage() -> ExitCode {
	eprintln!("usage: hrt render-test <input.osm.pbf> <output.pmtiles>");
	eprintln!("       hrt water-test <input.osm.pbf> <output.pmtiles>");
	eprintln!("       hrt render-dump <input.osm.pbf>");
	eprintln!("       hrt clock <a.pmtiles> <b.pmtiles> [max details]");
	eprintln!("       hrt record <archive.pmtiles> <out.jsonl>");
	ExitCode::from(2)
}

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	match args.first().map(String::as_str) {
		Some("render-test") if args.len() == 3 => build(&args[1], &args[2], &parity_profile::ParityProfile),
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
		Some("water-test") if args.len() == 3 || (args.len() == 4 && args[3] == "raw") => {
			let profile = water_profile::WaterProfile {
				raw: args.len() == 4,
				..water_profile::WaterProfile::default()
			};
			let code = build(&args[1], &args[2], &profile);
			eprintln!("merge snapping: {:?}", profile.merge_counts.lock().unwrap());
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
