// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt record`: the per-tile parity record, one JSON object per line.
//!
//! Each line is `{"tile":"z/x/y","layers":{"<name>":{"features":N,"digest":"<16 hex digits>"}}}`, with tiles in Hilbert
//! order and layers in name order. A layer's digest is the 64-bit FNV-1a hash of its features in the canonical form
//! `hrt clock` compares, sorted, so two archives whose tiles `clock` calls equal produce the same record. A test can
//! keep a record from the Java build and compare a fresh `hrt` build against it without storing either archive.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::{self, BufWriter, Write};
use std::path::Path;

use hrt_e::decode_tile;
use hrt_pmtiles::{tile_id_to_zxy, Reader};

use crate::clock::canonical;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv1a(hash: &mut u64, bytes: &[u8]) {
	for &byte in bytes {
		*hash ^= u64::from(byte);
		*hash = hash.wrapping_mul(FNV_PRIME);
	}
}

fn json_string(text: &str) -> String {
	let mut out = String::with_capacity(text.len() + 2);
	out.push('"');
	for character in text.chars() {
		match character {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			c if (c as u32) < 0x20 => {
				let _ = write!(out, "\\u{:04x}", c as u32);
			}
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

/// Writes the parity record of `archive` to `out`, returning the number of tiles written.
pub fn write_record(archive: &Path, out: &Path) -> io::Result<u64> {
	let reader = Reader::open(archive)?;
	let mut writer = BufWriter::new(std::fs::File::create(out)?);
	let mut tiles = 0;
	for entry in reader.entries()? {
		let layers = decode_tile(&reader.tile(&entry)?).map_err(|error| io::Error::other(error.0))?;
		let mut summary: BTreeMap<String, (usize, u64)> = BTreeMap::new();
		for layer in &layers {
			let mut features: Vec<String> = layer
				.features
				.iter()
				.map(|feature| format!("{:?}", canonical(feature)))
				.collect();
			features.sort();
			let mut hash = FNV_OFFSET;
			for feature in &features {
				fnv1a(&mut hash, feature.as_bytes());
				fnv1a(&mut hash, b"\n");
			}
			summary.insert(layer.name.clone(), (features.len(), hash));
		}
		let mut layers_json = String::new();
		for (index, (name, (count, hash))) in summary.iter().enumerate() {
			if index > 0 {
				layers_json.push(',');
			}
			let _ = write!(
				layers_json,
				"{}:{{\"features\":{count},\"digest\":\"{hash:016x}\"}}",
				json_string(name)
			);
		}
		for offset in 0..u64::from(entry.run_length) {
			let (z, x, y) = tile_id_to_zxy(entry.tile_id + offset);
			writeln!(writer, "{{\"tile\":\"{z}/{x}/{y}\",\"layers\":{{{layers_json}}}}}")?;
			tiles += 1;
		}
	}
	writer.flush()?;
	Ok(tiles)
}
