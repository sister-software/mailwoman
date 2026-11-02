// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The PMTiles v3 header: 127 bytes, little-endian, at offset 0.

/// The header's length in bytes.
pub const HEADER_LENGTH: usize = 127;

/// A compression method, as the header's byte records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Compression {
	Unknown = 0,
	None = 1,
	Gzip = 2,
	Brotli = 3,
	Zstd = 4,
}

/// A tile format, as the header's byte records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TileType {
	Unknown = 0,
	Mvt = 1,
	Png = 2,
	Jpeg = 3,
	Webp = 4,
	Avif = 5,
}

/// Every field of the header. Coordinates are degrees; the encoding stores them as integers in units of 1e-7 degree.
#[derive(Clone, Debug, PartialEq)]
pub struct Header {
	pub root_directory_offset: u64,
	pub root_directory_length: u64,
	pub metadata_offset: u64,
	pub metadata_length: u64,
	pub leaf_directories_offset: u64,
	pub leaf_directories_length: u64,
	pub tile_data_offset: u64,
	pub tile_data_length: u64,
	pub addressed_tiles: u64,
	pub tile_entries: u64,
	pub tile_contents: u64,
	pub clustered: bool,
	pub internal_compression: Compression,
	pub tile_compression: Compression,
	pub tile_type: TileType,
	pub min_zoom: u8,
	pub max_zoom: u8,
	pub min_lon: f64,
	pub min_lat: f64,
	pub max_lon: f64,
	pub max_lat: f64,
	pub center_zoom: u8,
	pub center_lon: f64,
	pub center_lat: f64,
}

/// A coordinate in the header's integer unit of 1e-7 degree.
fn e7(degrees: f64) -> i32 {
	(degrees * 1e7).round() as i32
}

impl Header {
	/// The header's 127 bytes.
	pub fn to_bytes(&self) -> [u8; HEADER_LENGTH] {
		let mut bytes = [0u8; HEADER_LENGTH];

		bytes[0..7].copy_from_slice(b"PMTiles");
		bytes[7] = 3;

		let words = [
			self.root_directory_offset,
			self.root_directory_length,
			self.metadata_offset,
			self.metadata_length,
			self.leaf_directories_offset,
			self.leaf_directories_length,
			self.tile_data_offset,
			self.tile_data_length,
			self.addressed_tiles,
			self.tile_entries,
			self.tile_contents,
		];

		for (index, word) in words.iter().enumerate() {
			let start = 8 + index * 8;
			bytes[start..start + 8].copy_from_slice(&word.to_le_bytes());
		}

		bytes[96] = u8::from(self.clustered);
		bytes[97] = self.internal_compression as u8;
		bytes[98] = self.tile_compression as u8;
		bytes[99] = self.tile_type as u8;
		bytes[100] = self.min_zoom;
		bytes[101] = self.max_zoom;
		bytes[102..106].copy_from_slice(&e7(self.min_lon).to_le_bytes());
		bytes[106..110].copy_from_slice(&e7(self.min_lat).to_le_bytes());
		bytes[110..114].copy_from_slice(&e7(self.max_lon).to_le_bytes());
		bytes[114..118].copy_from_slice(&e7(self.max_lat).to_le_bytes());
		bytes[118] = self.center_zoom;
		bytes[119..123].copy_from_slice(&e7(self.center_lon).to_le_bytes());
		bytes[123..127].copy_from_slice(&e7(self.center_lat).to_le_bytes());

		bytes
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn lays_out_the_magic_version_and_little_endian_fields() {
		let header = Header {
			root_directory_offset: 127,
			root_directory_length: 20,
			metadata_offset: 147,
			metadata_length: 0,
			leaf_directories_offset: 147,
			leaf_directories_length: 0,
			tile_data_offset: 147,
			tile_data_length: 3,
			addressed_tiles: 1,
			tile_entries: 1,
			tile_contents: 1,
			clustered: true,
			internal_compression: Compression::Gzip,
			tile_compression: Compression::Gzip,
			tile_type: TileType::Mvt,
			min_zoom: 0,
			max_zoom: 15,
			min_lon: -180.0,
			min_lat: -85.0,
			max_lon: 180.0,
			max_lat: 85.0,
			center_zoom: 3,
			center_lon: 139.7671,
			center_lat: 35.6812,
		};

		let bytes = header.to_bytes();

		assert_eq!(&bytes[0..8], b"PMTiles\x03");
		assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 127);
		assert_eq!(bytes[96..102], [1, 2, 2, 1, 0, 15]);
		assert_eq!(i32::from_le_bytes(bytes[102..106].try_into().unwrap()), -1_800_000_000);
		assert_eq!(i32::from_le_bytes(bytes[119..123].try_into().unwrap()), 1_397_671_000);
	}
}
