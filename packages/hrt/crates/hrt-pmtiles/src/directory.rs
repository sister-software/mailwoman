// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Directory entries and their serialization.
//!
//! A directory lists entries in ascending tile id. Its encoding is columnar varints: the entry count, then each tile id
//! as a delta from the previous one, then every run length, every length, and every offset. An offset equal to the
//! previous entry's offset plus its length is written as 0; any other offset is written plus 1.

/// One directory entry.
///
/// A `run_length` of 0 marks a pointer to a leaf directory: `offset` and `length` then locate the leaf within the leaf
/// directories section. Otherwise the entry covers `run_length` consecutive tile ids that share one tile body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
	pub tile_id: u64,
	pub offset: u64,
	pub length: u32,
	pub run_length: u32,
}

fn write_varint(buffer: &mut Vec<u8>, mut value: u64) {
	while value >= 0x80 {
		buffer.push((value as u8) | 0x80);
		value >>= 7;
	}
	buffer.push(value as u8);
}

fn read_varint(bytes: &[u8], position: &mut usize) -> Option<u64> {
	let mut value = 0u64;

	for shift in (0..64).step_by(7) {
		let byte = *bytes.get(*position)?;
		*position += 1;
		value |= u64::from(byte & 0x7f) << shift;
		if byte < 0x80 {
			return Some(value);
		}
	}

	None
}

/// The uncompressed bytes of a directory.
///
/// # Panics
///
/// Panics when the entries are not in strictly ascending tile id order.
pub fn serialize_directory(entries: &[Entry]) -> Vec<u8> {
	let mut buffer = Vec::with_capacity(entries.len() * 8 + 8);

	write_varint(&mut buffer, entries.len() as u64);

	let mut last_id = 0u64;
	for (index, entry) in entries.iter().enumerate() {
		assert!(
			index == 0 || entry.tile_id > last_id,
			"directory entries are not in ascending tile id order"
		);
		write_varint(&mut buffer, entry.tile_id - last_id);
		last_id = entry.tile_id;
	}

	for entry in entries {
		write_varint(&mut buffer, u64::from(entry.run_length));
	}

	for entry in entries {
		write_varint(&mut buffer, u64::from(entry.length));
	}

	for (index, entry) in entries.iter().enumerate() {
		let follows_previous =
			index > 0 && entry.offset == entries[index - 1].offset + u64::from(entries[index - 1].length);
		write_varint(&mut buffer, if follows_previous { 0 } else { entry.offset + 1 });
	}

	buffer
}

/// The entries of an uncompressed directory, or `None` when the bytes end early.
pub fn deserialize_directory(bytes: &[u8]) -> Option<Vec<Entry>> {
	let mut position = 0;
	let count = read_varint(bytes, &mut position)? as usize;
	let mut entries = Vec::with_capacity(count);
	let mut last_id = 0u64;

	for _ in 0..count {
		last_id += read_varint(bytes, &mut position)?;
		entries.push(Entry {
			tile_id: last_id,
			offset: 0,
			length: 0,
			run_length: 0,
		});
	}

	for entry in &mut entries {
		entry.run_length = u32::try_from(read_varint(bytes, &mut position)?).ok()?;
	}

	for entry in &mut entries {
		entry.length = u32::try_from(read_varint(bytes, &mut position)?).ok()?;
	}

	for index in 0..count {
		let value = read_varint(bytes, &mut position)?;
		entries[index].offset = if value == 0 && index > 0 {
			entries[index - 1].offset + u64::from(entries[index - 1].length)
		} else {
			value.checked_sub(1)?
		};
	}

	Some(entries)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn round_trips_runs_contiguous_offsets_and_leaf_pointers() {
		let entries = vec![
			Entry {
				tile_id: 0,
				offset: 0,
				length: 100,
				run_length: 1,
			},
			Entry {
				tile_id: 1,
				offset: 100,
				length: 50,
				run_length: 3,
			},
			Entry {
				tile_id: 9,
				offset: 0,
				length: 100,
				run_length: 1,
			},
			Entry {
				tile_id: 300,
				offset: 4_000,
				length: 9,
				run_length: 0,
			},
		];

		let bytes = serialize_directory(&entries);

		assert_eq!(deserialize_directory(&bytes), Some(entries));
	}

	#[test]
	fn writes_a_contiguous_offset_as_zero() {
		let entries = vec![
			Entry {
				tile_id: 5,
				offset: 0,
				length: 10,
				run_length: 1,
			},
			Entry {
				tile_id: 6,
				offset: 10,
				length: 10,
				run_length: 1,
			},
		];

		// Count, two id deltas, two run lengths, two lengths, then offsets 0+1 and 0.
		assert_eq!(serialize_directory(&entries), vec![2, 5, 1, 1, 1, 10, 10, 1, 0]);
	}

	#[test]
	fn refuses_a_truncated_directory() {
		let bytes = serialize_directory(&[Entry {
			tile_id: 7,
			offset: 0,
			length: 300,
			run_length: 1,
		}]);

		assert_eq!(deserialize_directory(&bytes[..bytes.len() - 1]), None);
	}
}
