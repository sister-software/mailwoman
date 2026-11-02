// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Writes archives and reads them back through the header and directories, as a reader does.

use std::io::Read;

use flate2::read::GzDecoder;
use hrt_pmtiles::{deserialize_directory, tile_id, Entry, Writer, WriterOptions, HEADER_LENGTH};

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
	u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
	let mut out = Vec::new();
	GzDecoder::new(bytes).read_to_end(&mut out).unwrap();
	out
}

/// Finds a tile body the way the `pmtiles` reader does: the last entry at or before the id, followed into leaves.
fn read_tile(archive: &[u8], id: u64) -> Option<Vec<u8>> {
	let mut offset = u64_at(archive, 8) as usize;
	let mut length = u64_at(archive, 16) as usize;
	let leaves = u64_at(archive, 40) as usize;
	let data = u64_at(archive, 56) as usize;

	for _ in 0..4 {
		let entries = deserialize_directory(&gunzip(&archive[offset..offset + length])).unwrap();
		let entry: &Entry = entries.iter().rev().find(|entry| entry.tile_id <= id)?;

		if entry.run_length == 0 {
			offset = leaves + entry.offset as usize;
			length = entry.length as usize;
			continue;
		}

		if id >= entry.tile_id + u64::from(entry.run_length) {
			return None;
		}

		let start = data + entry.offset as usize;
		return Some(archive[start..start + entry.length as usize].to_vec());
	}

	panic!("directory depth exceeded");
}

fn write(tiles: &[(u64, Vec<u8>)]) -> (Vec<u8>, hrt_pmtiles::ArchiveSummary) {
	let mut writer = Writer::new(WriterOptions::default(), tempfile::tempfile().unwrap());

	for (id, body) in tiles {
		writer.add_tile(*id, body).unwrap();
	}

	let mut archive = Vec::new();
	let summary = writer.finish(br#"{"vector_layers":[]}"#, &mut archive).unwrap();

	(archive, summary)
}

#[test]
fn reads_back_every_tile_and_folds_repeats_into_runs() {
	let ocean = b"ocean".to_vec();
	let tiles = vec![
		(tile_id(0, 0, 0), b"world".to_vec()),
		(tile_id(1, 0, 0), ocean.clone()),
		(tile_id(1, 0, 1), ocean.clone()),
		(tile_id(1, 1, 1), b"land".to_vec()),
		(tile_id(1, 1, 0), ocean.clone()),
	];

	let (archive, summary) = write(&tiles);

	assert_eq!(&archive[0..8], b"PMTiles\x03");
	assert_eq!(summary.addressed_tiles, 5);
	// The two adjacent ocean tiles fold into one run, and the third ocean tile points at the stored body.
	assert_eq!(summary.tile_entries, 4);
	assert_eq!(summary.tile_contents, 3);
	assert_eq!(summary.archive_length, archive.len() as u64);

	for (id, body) in &tiles {
		assert_eq!(read_tile(&archive, *id).as_ref(), Some(body));
	}

	assert_eq!(read_tile(&archive, tile_id(2, 0, 0)), None);
	assert_eq!(
		&gunzip(&archive[u64_at(&archive, 24) as usize..][..u64_at(&archive, 32) as usize]),
		br#"{"vector_layers":[]}"#
	);
}

#[test]
fn splits_a_large_directory_into_leaves_that_still_resolve() {
	// Zoom 9 has 262,144 tiles. Distinct bodies of varied length keep every tile its own entry with a length gzip
	// cannot predict, as in a real archive, so the root cannot hold them. Equal lengths would compress the directory
	// to a few kilobytes.
	let tiles: Vec<(u64, Vec<u8>)> = (0..512u32)
		.flat_map(|x| (0..512u32).map(move |y| (x, y)))
		.map(|(x, y)| {
			(
				tile_id(9, x, y),
				format!("{x}/{y}")
					.repeat(1 + ((x * 7919 + y * 104_729) % 61) as usize)
					.into_bytes(),
			)
		})
		.collect::<std::collections::BTreeMap<_, _>>()
		.into_iter()
		.collect();

	let (archive, summary) = write(&tiles);

	assert!(summary.leaf_directories > 0);
	assert!(HEADER_LENGTH as u64 + u64_at(&archive, 16) <= 16_384);

	for (id, body) in tiles.iter().step_by(997) {
		assert_eq!(read_tile(&archive, *id).as_ref(), Some(body));
	}
}

#[test]
fn refuses_a_tile_out_of_order() {
	let mut writer = Writer::new(WriterOptions::default(), tempfile::tempfile().unwrap());

	writer.add_tile(5, b"a").unwrap();

	assert!(writer.add_tile(3, b"b").is_err());
}
