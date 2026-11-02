// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! An external merge sort of `(key, value)` records, ordered by key and then by value bytes.
//!
//! Each writer collects records until it holds `chunk_bytes`, sorts them on rayon's threads and writes them to a
//! chunk file. Reading merges every chunk with a heap. A chunk file is a run of records, each an 8-byte little-endian
//! key, a 4-byte little-endian value length and the value.

use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::Mutex;

use rayon::prelude::*;

/// The sort's shared state: where chunks go and which chunks exist.
pub struct Sorter {
	dir: PathBuf,
	chunk_bytes: usize,
	chunks: Mutex<Vec<PathBuf>>,
	next_chunk: AtomicUsize,
	records: AtomicU64,
}

/// A single thread's buffer of records not yet written to a chunk.
pub struct ChunkWriter<'a> {
	sorter: &'a Sorter,
	entries: Vec<(u64, u32, u32)>,
	data: Vec<u8>,
}

impl Sorter {
	/// Creates a sort that writes chunk files into `dir`, each holding about `chunk_bytes` of values.
	pub fn new(dir: impl Into<PathBuf>, chunk_bytes: usize) -> Self {
		Sorter {
			dir: dir.into(),
			chunk_bytes,
			chunks: Mutex::new(Vec::new()),
			next_chunk: AtomicUsize::new(0),
			records: AtomicU64::new(0),
		}
	}

	/// Returns a buffer for one thread to add records through.
	pub fn writer(&self) -> ChunkWriter<'_> {
		ChunkWriter {
			sorter: self,
			entries: Vec::new(),
			data: Vec::new(),
		}
	}

	/// Returns the number of records written to chunks.
	pub fn records(&self) -> u64 {
		self.records.load(AtomicOrdering::Relaxed)
	}

	/// Opens every chunk and returns the records in sorted order.
	pub fn merge(self) -> io::Result<Merged> {
		let chunks = self.chunks.into_inner().unwrap();
		let mut readers = Vec::with_capacity(chunks.len());
		let mut heap = BinaryHeap::with_capacity(chunks.len());
		for (source, path) in chunks.iter().enumerate() {
			let mut reader = BufReader::with_capacity(1 << 20, File::open(path)?);
			if let Some((key, value)) = read_record(&mut reader)? {
				heap.push(Reverse(Head { key, value, source }));
			}
			readers.push(reader);
		}
		Ok(Merged {
			readers,
			heap,
			paths: chunks,
		})
	}
}

impl ChunkWriter<'_> {
	/// Adds a record, writing a chunk when the buffer is full.
	pub fn add(&mut self, key: u64, value: &[u8]) -> io::Result<()> {
		self.entries.push((key, self.data.len() as u32, value.len() as u32));
		self.data.extend_from_slice(value);
		if self.data.len() >= self.sorter.chunk_bytes {
			self.flush()?;
		}
		Ok(())
	}

	fn flush(&mut self) -> io::Result<()> {
		if self.entries.is_empty() {
			return Ok(());
		}
		let data = &self.data;
		let value = |&(_, offset, length): &(u64, u32, u32)| &data[offset as usize..(offset + length) as usize];
		self.entries
			.par_sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| value(a).cmp(value(b))));

		let index = self.sorter.next_chunk.fetch_add(1, AtomicOrdering::Relaxed);
		let path = self.sorter.dir.join(format!("chunk-{index:06}.bin"));
		let mut out = BufWriter::with_capacity(1 << 20, File::create(&path)?);
		for entry in &self.entries {
			let bytes = value(entry);
			out.write_all(&entry.0.to_le_bytes())?;
			out.write_all(&(bytes.len() as u32).to_le_bytes())?;
			out.write_all(bytes)?;
		}
		out.flush()?;
		self.sorter
			.records
			.fetch_add(self.entries.len() as u64, AtomicOrdering::Relaxed);
		self.sorter.chunks.lock().unwrap().push(path);
		self.entries.clear();
		self.data.clear();
		Ok(())
	}

	/// Writes the remaining records to a final chunk.
	pub fn finish(mut self) -> io::Result<()> {
		self.flush()
	}
}

fn read_record(reader: &mut impl Read) -> io::Result<Option<(u64, Vec<u8>)>> {
	let mut key = [0u8; 8];
	match reader.read_exact(&mut key) {
		Ok(()) => {}
		Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
		Err(error) => return Err(error),
	}
	let mut length = [0u8; 4];
	reader.read_exact(&mut length)?;
	let mut value = vec![0u8; u32::from_le_bytes(length) as usize];
	reader.read_exact(&mut value)?;
	Ok(Some((u64::from_le_bytes(key), value)))
}

#[derive(PartialEq, Eq)]
struct Head {
	key: u64,
	value: Vec<u8>,
	source: usize,
}

impl Ord for Head {
	fn cmp(&self, other: &Self) -> Ordering {
		self.key
			.cmp(&other.key)
			.then_with(|| self.value.cmp(&other.value))
			.then(self.source.cmp(&other.source))
	}
}

impl PartialOrd for Head {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

/// The merged records, in key then value order. Dropping it deletes the chunk files.
pub struct Merged {
	readers: Vec<BufReader<File>>,
	heap: BinaryHeap<Reverse<Head>>,
	paths: Vec<PathBuf>,
}

impl Iterator for Merged {
	type Item = io::Result<(u64, Vec<u8>)>;

	fn next(&mut self) -> Option<Self::Item> {
		let Reverse(head) = self.heap.pop()?;
		match read_record(&mut self.readers[head.source]) {
			Ok(Some((key, value))) => self.heap.push(Reverse(Head {
				key,
				value,
				source: head.source,
			})),
			Ok(None) => {}
			Err(error) => return Some(Err(error)),
		}
		Some(Ok((head.key, head.value)))
	}
}

impl Drop for Merged {
	fn drop(&mut self) {
		for path in &self.paths {
			let _ = std::fs::remove_file(path);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn records_from_several_chunks_merge_in_key_then_value_order() {
		let dir = tempfile::tempdir().unwrap();
		let sorter = Sorter::new(dir.path(), 16);
		std::thread::scope(|scope| {
			for thread in 0..3u64 {
				let sorter = &sorter;
				scope.spawn(move || {
					let mut writer = sorter.writer();
					for i in 0..50u64 {
						let key = (i * 7 + thread * 13) % 40;
						writer.add(key, &[(i % 3) as u8, thread as u8]).unwrap();
					}
					writer.finish().unwrap();
				});
			}
		});
		assert_eq!(sorter.records(), 150);
		let merged: Vec<(u64, Vec<u8>)> = sorter.merge().unwrap().map(Result::unwrap).collect();
		assert_eq!(merged.len(), 150);
		assert!(merged.windows(2).all(|pair| pair[0] <= pair[1]));
		assert_eq!(
			std::fs::read_dir(dir.path()).unwrap().count(),
			0,
			"chunk files are removed after merging"
		);
	}
}
