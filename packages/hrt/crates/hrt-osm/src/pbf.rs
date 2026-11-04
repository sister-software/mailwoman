// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Reading an OpenStreetMap PBF file block by block, with the decompression and decoding spread across threads.

use std::io;
use std::path::Path;

use osmpbf::{BlobDecode, BlobReader, PrimitiveBlock};
use rayon::prelude::*;

/// Returns the file header's bounding box as `[west, south, east, north]` degrees, or `None` when it has none.
///
/// The header stores nanodegrees. osmpbf multiplies by 1e-9, and Planetiler divides by 1e9, which can differ in the last
/// bit, so the integer is recovered and divided as Planetiler divides it.
pub fn header_bounds(path: &Path) -> io::Result<Option<[f64; 4]>> {
	let mut blobs = BlobReader::from_path(path).map_err(io::Error::other)?;
	let Some(blob) = blobs.next() else {
		return Ok(None);
	};
	let header = match blob.map_err(io::Error::other)?.decode().map_err(io::Error::other)? {
		BlobDecode::OsmHeader(header) => header,
		_ => return Ok(None),
	};
	let degrees = |value: f64| (value / 1e-9).round() / 1e9;
	Ok(header.bbox().map(|bbox| {
		[
			degrees(bbox.left),
			degrees(bbox.bottom),
			degrees(bbox.right),
			degrees(bbox.top),
		]
	}))
}

/// Decodes every data block of a PBF file in parallel and hands each result to `sink` in file order.
///
/// The reader takes compressed blobs from the file a batch at a time. `decode` runs on rayon's threads, one call per
/// block, and `sink` runs on the calling thread in the order the blocks appear in the file. A batch holds at most twice
/// the thread count of blocks, which bounds how many decoded results wait in memory at once.
pub fn for_each_block<T, D, S>(path: &Path, decode: D, mut sink: S) -> io::Result<()>
where
	T: Send,
	D: Fn(&PrimitiveBlock) -> T + Sync,
	S: FnMut(T),
{
	let batch_size = rayon::current_num_threads().max(1) * 2;
	let mut blobs = BlobReader::from_path(path).map_err(io::Error::other)?;
	loop {
		let mut batch = Vec::with_capacity(batch_size);
		for blob in blobs.by_ref().take(batch_size) {
			batch.push(blob.map_err(io::Error::other)?);
		}
		if batch.is_empty() {
			return Ok(());
		}

		let results: Vec<io::Result<Option<T>>> = batch
			.par_iter()
			.map(|blob| match blob.decode().map_err(io::Error::other)? {
				BlobDecode::OsmData(block) => Ok(Some(decode(&block))),
				BlobDecode::OsmHeader(_) | BlobDecode::Unknown(_) => Ok(None),
			})
			.collect();
		for result in results {
			if let Some(value) = result? {
				sink(value);
			}
		}
	}
}
