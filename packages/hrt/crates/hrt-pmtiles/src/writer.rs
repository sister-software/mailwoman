// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The archive writer.
//!
//! Tile bodies stream to a scratch file as they arrive, because the header and directories that precede them in the
//! archive are known only once the last tile is in. [`Writer::finish`] then writes the header, the root directory,
//! the metadata and any leaf directories, and copies the tile data after them.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::BuildHasher;
use std::io::{self, Seek, SeekFrom, Write};

use flate2::write::GzEncoder;

use crate::directory::{serialize_directory, Entry};
use crate::header::{Compression, Header, TileType, HEADER_LENGTH};
use crate::tile_id::tile_id_to_zxy;

/// The bytes a reader fetches first. The header and the root directory must fit within them.
const FIRST_FETCH_BYTES: usize = 16_384;

/// Leaf directory sizes start at this many entries and grow by [`LEAF_GROWTH`] until the root directory fits.
const FIRST_LEAF_SIZE: usize = 4_096;

const LEAF_GROWTH: f64 = 1.2;

/// What the header records about the archive beyond its tiles.
#[derive(Clone, Debug)]
pub struct WriterOptions {
	pub tile_type: TileType,
	/// How each tile body was compressed before [`Writer::add_tile`] received it.
	pub tile_compression: Compression,
	/// `[west, south, east, north]` in degrees.
	pub bounds: [f64; 4],
	/// `(zoom, longitude, latitude)`.
	pub center: (u8, f64, f64),
	/// The `(minimum, maximum)` zoom the header records. Planetiler records its configured zoom range, whichever zooms
	/// hold tiles. Unset, the header records the range of the tiles added, or 0 and 0 when none were.
	pub zoom_range: Option<(u8, u8)>,
	/// Tile bodies at or below this length are stored once, however many tiles share them. A longer body is written
	/// each time it arrives unless it repeats the previous tile, because a hash table over every planet tile would hold
	/// hundreds of millions of entries for bodies that rarely repeat.
	pub dedupe_max_length: usize,
}

impl Default for WriterOptions {
	fn default() -> Self {
		WriterOptions {
			tile_type: TileType::Mvt,
			tile_compression: Compression::Gzip,
			bounds: [-180.0, -85.051_128_78, 180.0, 85.051_128_78],
			center: (0, 0.0, 0.0),
			zoom_range: None,
			dedupe_max_length: 4_096,
		}
	}
}

/// What [`Writer::finish`] wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveSummary {
	/// Tile ids the archive answers, counting each id within a run.
	pub addressed_tiles: u64,
	/// Directory entries, counting a run as one.
	pub tile_entries: u64,
	/// Distinct tile bodies stored.
	pub tile_contents: u64,
	pub leaf_directories: usize,
	pub archive_length: u64,
}

/// A 128-bit fingerprint of a tile body, from two independently keyed hashers. Two bodies are treated as identical when
/// their fingerprints match; at 128 bits a false match among 10^10 tiles has a probability near 10^-19.
type Fingerprint = (u64, u64);

/// Writes one PMTiles v3 archive from tiles added in ascending tile id order.
pub struct Writer {
	options: WriterOptions,
	scratch: File,
	entries: Vec<Entry>,
	last_fingerprint: Option<Fingerprint>,
	stored: HashMap<Fingerprint, (u64, u32)>,
	hashers: (RandomState, RandomState),
	data_length: u64,
	addressed_tiles: u64,
	tile_contents: u64,
	min_zoom: u8,
	max_zoom: u8,
}

fn gzip(bytes: &[u8]) -> io::Result<Vec<u8>> {
	let mut encoder = GzEncoder::new(Vec::with_capacity(bytes.len() / 2 + 16), flate2::Compression::default());
	encoder.write_all(bytes)?;
	encoder.finish()
}

impl Writer {
	/// A writer that streams tile bodies to `scratch`, an empty file opened for reading and writing.
	pub fn new(options: WriterOptions, scratch: File) -> Self {
		Writer {
			options,
			scratch,
			entries: Vec::new(),
			last_fingerprint: None,
			stored: HashMap::new(),
			hashers: (RandomState::new(), RandomState::new()),
			data_length: 0,
			addressed_tiles: 0,
			tile_contents: 0,
			min_zoom: u8::MAX,
			max_zoom: 0,
		}
	}

	fn fingerprint(&self, body: &[u8]) -> Fingerprint {
		(self.hashers.0.hash_one(body), self.hashers.1.hash_one(body))
	}

	/// Adds a tile body, already compressed as [`WriterOptions::tile_compression`] states.
	///
	/// # Errors
	///
	/// Fails when the scratch file cannot be written, or when `tile_id` is not above the previous tile's id.
	pub fn add_tile(&mut self, tile_id: u64, body: &[u8]) -> io::Result<()> {
		if let Some(last) = self.entries.last() {
			if tile_id < last.tile_id + u64::from(last.run_length) {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					format!(
						"tile {tile_id} arrived after tile {}",
						last.tile_id + u64::from(last.run_length) - 1
					),
				));
			}
		}

		let length = u32::try_from(body.len())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("tile {tile_id} exceeds 4 GiB")))?;
		let fingerprint = self.fingerprint(body);
		let (z, _, _) = tile_id_to_zxy(tile_id);

		self.min_zoom = self.min_zoom.min(z);
		self.max_zoom = self.max_zoom.max(z);
		self.addressed_tiles += 1;

		// A tile that repeats the previous one and directly follows it extends that entry's run.
		if let Some(last) = self.entries.last_mut() {
			if self.last_fingerprint == Some(fingerprint) && last.tile_id + u64::from(last.run_length) == tile_id {
				last.run_length += 1;
				return Ok(());
			}
		}

		self.last_fingerprint = Some(fingerprint);

		if let Some(&(offset, stored_length)) = self.stored.get(&fingerprint) {
			self.entries.push(Entry {
				tile_id,
				offset,
				length: stored_length,
				run_length: 1,
			});
			return Ok(());
		}

		let offset = self.data_length;
		self.scratch.write_all(body)?;
		self.data_length += u64::from(length);
		self.tile_contents += 1;

		if body.len() <= self.options.dedupe_max_length {
			self.stored.insert(fingerprint, (offset, length));
		}

		self.entries.push(Entry {
			tile_id,
			offset,
			length,
			run_length: 1,
		});

		Ok(())
	}

	/// The compressed root directory and leaf directories, splitting the entries into leaves until the header and root
	/// fit in the reader's first fetch.
	fn directories(&self) -> io::Result<(Vec<u8>, Vec<u8>, usize)> {
		let root = gzip(&serialize_directory(&self.entries))?;

		if HEADER_LENGTH + root.len() <= FIRST_FETCH_BYTES {
			return Ok((root, Vec::new(), 0));
		}

		let mut leaf_size = FIRST_LEAF_SIZE;

		loop {
			let mut leaves = Vec::new();
			let mut pointers = Vec::new();

			for chunk in self.entries.chunks(leaf_size) {
				let leaf = gzip(&serialize_directory(chunk))?;
				pointers.push(Entry {
					tile_id: chunk[0].tile_id,
					offset: leaves.len() as u64,
					length: leaf.len() as u32,
					run_length: 0,
				});
				leaves.extend_from_slice(&leaf);
			}

			let root = gzip(&serialize_directory(&pointers))?;

			if HEADER_LENGTH + root.len() <= FIRST_FETCH_BYTES {
				return Ok((root, leaves, pointers.len()));
			}

			leaf_size = (leaf_size as f64 * LEAF_GROWTH).ceil() as usize;
		}
	}

	/// Writes the archive to `out`: header, root directory, gzip metadata, leaf directories, then the tile data.
	///
	/// `metadata` is the archive's JSON metadata, such as its `vector_layers`.
	///
	/// # Errors
	///
	/// Fails when the scratch file or `out` fails. An archive with no tiles has an empty root directory, as Planetiler
	/// writes for a build whose sources produce no features.
	pub fn finish(mut self, metadata: &[u8], out: &mut impl Write) -> io::Result<ArchiveSummary> {
		let (root, leaves, leaf_directories) = self.directories()?;
		let metadata = gzip(metadata)?;

		let root_offset = HEADER_LENGTH as u64;
		let metadata_offset = root_offset + root.len() as u64;
		let leaves_offset = metadata_offset + metadata.len() as u64;
		let data_offset = leaves_offset + leaves.len() as u64;
		let [min_lon, min_lat, max_lon, max_lat] = self.options.bounds;
		let (min_zoom, max_zoom) = match self.options.zoom_range {
			Some(range) => range,
			None if self.entries.is_empty() => (0, 0),
			None => (self.min_zoom, self.max_zoom),
		};

		let header = Header {
			root_directory_offset: root_offset,
			root_directory_length: root.len() as u64,
			metadata_offset,
			metadata_length: metadata.len() as u64,
			leaf_directories_offset: leaves_offset,
			leaf_directories_length: leaves.len() as u64,
			tile_data_offset: data_offset,
			tile_data_length: self.data_length,
			addressed_tiles: self.addressed_tiles,
			tile_entries: self.entries.len() as u64,
			tile_contents: self.tile_contents,
			clustered: true,
			internal_compression: Compression::Gzip,
			tile_compression: self.options.tile_compression,
			tile_type: self.options.tile_type,
			min_zoom,
			max_zoom,
			min_lon,
			min_lat,
			max_lon,
			max_lat,
			center_zoom: self.options.center.0,
			center_lon: self.options.center.1,
			center_lat: self.options.center.2,
		};

		out.write_all(&header.to_bytes())?;
		out.write_all(&root)?;
		out.write_all(&metadata)?;
		out.write_all(&leaves)?;

		self.scratch.flush()?;
		self.scratch.seek(SeekFrom::Start(0))?;
		let copied = io::copy(&mut self.scratch, out)?;

		if copied != self.data_length {
			return Err(io::Error::new(
				io::ErrorKind::UnexpectedEof,
				format!(
					"the scratch file held {copied} bytes of tile data, and {} were written",
					self.data_length
				),
			));
		}

		Ok(ArchiveSummary {
			addressed_tiles: self.addressed_tiles,
			tile_entries: self.entries.len() as u64,
			tile_contents: self.tile_contents,
			leaf_directories,
			archive_length: data_offset + self.data_length,
		})
	}
}
