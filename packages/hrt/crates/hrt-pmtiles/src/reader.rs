// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Reading a PMTiles v3 archive from a file with positional reads.

use std::fs::File;
use std::io::{self, Read};
use std::os::unix::fs::FileExt;
use std::path::Path;

use flate2::read::GzDecoder;

use crate::directory::{deserialize_directory, Entry};
use crate::header::{Compression, Header, HEADER_LENGTH};

/// An open archive: its header and the file it reads tiles from.
pub struct Reader {
	file: File,
	pub header: Header,
}

fn invalid(message: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// Decompresses bytes with the archive's internal or tile compression.
pub fn decompress(bytes: Vec<u8>, compression: Compression) -> io::Result<Vec<u8>> {
	match compression {
		Compression::None | Compression::Unknown => Ok(bytes),
		Compression::Gzip => {
			let mut out = Vec::with_capacity(bytes.len() * 4);
			GzDecoder::new(bytes.as_slice()).read_to_end(&mut out)?;
			Ok(out)
		}
		other => Err(invalid(&format!("{other:?} compression is not supported"))),
	}
}

impl Reader {
	pub fn open(path: &Path) -> io::Result<Reader> {
		let file = File::open(path)?;
		let mut bytes = [0u8; HEADER_LENGTH];
		file.read_exact_at(&mut bytes, 0)?;
		let header = Header::from_bytes(&bytes).ok_or_else(|| invalid("not a PMTiles v3 archive"))?;
		Ok(Reader { file, header })
	}

	fn read(&self, offset: u64, length: u64) -> io::Result<Vec<u8>> {
		let mut bytes = vec![0u8; length as usize];
		self.file.read_exact_at(&mut bytes, offset)?;
		Ok(bytes)
	}

	fn directory(&self, offset: u64, length: u64) -> io::Result<Vec<Entry>> {
		let bytes = decompress(self.read(offset, length)?, self.header.internal_compression)?;
		deserialize_directory(&bytes).ok_or_else(|| invalid("malformed directory"))
	}

	/// Returns the archive's metadata JSON, decompressed.
	pub fn metadata(&self) -> io::Result<Vec<u8>> {
		decompress(
			self.read(self.header.metadata_offset, self.header.metadata_length)?,
			self.header.internal_compression,
		)
	}

	/// Returns every tile entry in ascending tile id, with leaf directories resolved and runs left as they are.
	pub fn entries(&self) -> io::Result<Vec<Entry>> {
		let mut out = Vec::new();
		let root = self.directory(self.header.root_directory_offset, self.header.root_directory_length)?;
		for entry in root {
			if entry.run_length == 0 {
				let leaf = self.directory(
					self.header.leaf_directories_offset + entry.offset,
					u64::from(entry.length),
				)?;
				if leaf.iter().any(|leaf_entry| leaf_entry.run_length == 0) {
					return Err(invalid("nested leaf directories are not supported"));
				}
				out.extend(leaf);
			} else {
				out.push(entry);
			}
		}
		Ok(out)
	}

	/// Returns a tile's body as stored, still under the archive's tile compression.
	pub fn tile_body(&self, entry: &Entry) -> io::Result<Vec<u8>> {
		self.read(self.header.tile_data_offset + entry.offset, u64::from(entry.length))
	}

	/// Returns a tile's body with the tile compression removed.
	pub fn tile(&self, entry: &Entry) -> io::Result<Vec<u8>> {
		decompress(self.tile_body(entry)?, self.header.tile_compression)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{tile_id, Writer, WriterOptions};

	#[test]
	fn a_written_archive_reads_back_through_its_directories() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("test.pmtiles");
		let mut writer = Writer::new(WriterOptions::default(), tempfile::tempfile().unwrap());
		let mut ids = Vec::new();
		for z in 0..=7u8 {
			for x in 0..(1u32 << z) {
				ids.push((tile_id(z, x, 0), vec![z, x as u8, (x * 7 % 251) as u8]));
			}
		}
		ids.sort();
		for (id, body) in &ids {
			writer.add_tile(*id, body).unwrap();
		}
		let mut out = std::io::BufWriter::new(File::create(&path).unwrap());
		writer.finish(b"{}", &mut out).unwrap();
		drop(out);

		let reader = Reader::open(&path).unwrap();
		assert_eq!(reader.metadata().unwrap(), b"{}");
		let entries = reader.entries().unwrap();
		let mut seen = Vec::new();
		for entry in &entries {
			let body = reader.tile_body(entry).unwrap();
			for offset in 0..u64::from(entry.run_length) {
				seen.push((entry.tile_id + offset, body.clone()));
			}
		}
		assert_eq!(seen, ids);
	}
}
