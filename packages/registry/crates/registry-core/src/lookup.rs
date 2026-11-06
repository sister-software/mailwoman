// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Typed views over sections, and the batch classification the WebAssembly adapter exports.

use crate::artifact::{Artifact, Error, Section};
use crate::key;
use crate::sections;

/// A dense bitset over a key space.
#[derive(Debug, Clone, Copy)]
pub struct Bitset<'a> {
	bits: &'a [u8],
	arity: u32,
}

impl<'a> Bitset<'a> {
	/// The bitset section of an artifact, whatever its arity.
	pub fn from_artifact(artifact: &Artifact<'a>) -> Result<Self, Error> {
		let section = artifact
			.first_section(sections::KIND_BITSET)
			.ok_or(Error::MissingSection(sections::KIND_BITSET))?;

		Ok(Bitset {
			bits: section.payload,
			arity: section.aux,
		})
	}

	/// The key arity the bitset is indexed by.
	pub fn arity(&self) -> u32 {
		self.arity
	}

	/// Whether `key` is a member. A key outside the space is not a member.
	#[inline]
	pub fn test(&self, key: u32) -> bool {
		let byte = (key >> 3) as usize;

		byte < self.bits.len() && self.bits[byte] & (1 << (key & 7)) != 0
	}

	/// Whether the code, in its canonical spelling, is a member. A code outside the grammar is not.
	#[inline]
	pub fn contains(&self, code: &[u8]) -> bool {
		key::encode(self.arity, code).is_some_and(|key| self.test(key))
	}

	/// The number of set bits.
	pub fn len(&self) -> usize {
		self.bits.iter().map(|byte| byte.count_ones() as usize).sum()
	}

	/// Whether no bit is set.
	pub fn is_empty(&self) -> bool {
		self.bits.iter().all(|byte| *byte == 0)
	}
}

/// A direct-address table from key to row id, with zero as absent.
#[derive(Debug, Clone, Copy)]
pub struct IdTable<'a> {
	section: Section<'a>,
}

impl<'a> IdTable<'a> {
	/// The id table of an artifact for one arity.
	pub fn from_artifact(artifact: &Artifact<'a>, arity: u32) -> Result<Self, Error> {
		let section = artifact
			.section(sections::KIND_ID_TABLE, arity)
			.ok_or(Error::MissingSection(sections::KIND_ID_TABLE))?;

		Ok(IdTable { section })
	}

	/// The row id for a key, or `None` when the key is absent.
	#[inline]
	pub fn get(&self, key: u32) -> Option<u32> {
		if key >= self.section.count {
			return None;
		}

		match self.section.element(key as usize) {
			0 => None,
			id => Some(id - 1),
		}
	}

	/// The row id for a code in its canonical spelling.
	#[inline]
	pub fn lookup(&self, code: &[u8]) -> Option<u32> {
		key::encode(self.section.aux, code).and_then(|key| self.get(key))
	}
}

/// A fixed-width record column.
#[derive(Debug, Clone, Copy)]
pub struct Column<'a> {
	section: Section<'a>,
}

impl<'a> Column<'a> {
	/// The column whose `aux` is `index` in the header's column list.
	pub fn from_artifact(artifact: &Artifact<'a>, index: u32) -> Result<Self, Error> {
		let section = artifact
			.section(sections::KIND_COLUMN, index)
			.ok_or(Error::MissingSection(sections::KIND_COLUMN))?;

		Ok(Column { section })
	}

	/// The number of rows.
	pub fn len(&self) -> usize {
		self.section.count as usize
	}

	/// Whether the column has no rows.
	pub fn is_empty(&self) -> bool {
		self.section.count == 0
	}

	/// An unsigned integer cell of width 1, 2 or 4.
	#[inline]
	pub fn integer(&self, row: usize) -> Option<u32> {
		(row < self.len() && self.section.element_width != 8).then(|| self.section.element(row))
	}

	/// A double cell.
	#[inline]
	pub fn double(&self, row: usize) -> Option<f64> {
		if row >= self.len() || self.section.element_width != 8 {
			return None;
		}

		let at = row * 8;
		let mut bytes = [0u8; 8];
		bytes.copy_from_slice(&self.section.payload[at..at + 8]);

		Some(f64::from_le_bytes(bytes))
	}
}

/// A string pool: offsets into a strict UTF-8 byte section.
#[derive(Debug, Clone, Copy)]
pub struct StringPool<'a> {
	offsets: Section<'a>,
	bytes: &'a [u8],
}

impl<'a> StringPool<'a> {
	/// The pool of an artifact, checking that the offsets are monotonic and end at the bytes' length.
	pub fn from_artifact(artifact: &Artifact<'a>) -> Result<Self, Error> {
		let offsets = artifact
			.first_section(sections::KIND_STRING_OFFSETS)
			.ok_or(Error::MissingSection(sections::KIND_STRING_OFFSETS))?;
		let bytes = artifact
			.first_section(sections::KIND_UTF8)
			.ok_or(Error::MissingSection(sections::KIND_UTF8))?;

		if offsets.count == 0 {
			return Err(Error::Offsets);
		}

		let mut previous = 0u32;

		for index in 0..offsets.count as usize {
			let offset = offsets.element(index);

			if offset < previous {
				return Err(Error::Offsets);
			}

			previous = offset;
		}

		if previous != bytes.length {
			return Err(Error::Offsets);
		}

		core::str::from_utf8(bytes.payload).map_err(|_| Error::StringUTF8)?;

		Ok(StringPool {
			offsets,
			bytes: bytes.payload,
		})
	}

	/// The number of strings.
	pub fn len(&self) -> usize {
		self.offsets.count as usize - 1
	}

	/// Whether the pool holds no string.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	/// The string at `index`.
	#[inline]
	pub fn get(&self, index: usize) -> Option<&'a str> {
		if index >= self.len() {
			return None;
		}

		let start = self.offsets.element(index) as usize;
		let end = self.offsets.element(index + 1) as usize;

		// The pool was checked as strict UTF-8 as a whole; a slice at offsets the writer placed on
		// character boundaries is valid, and an offset inside a multi-byte sequence answers `None`.
		core::str::from_utf8(&self.bytes[start..end]).ok()
	}
}

/// A one-to-many relation: `offsets[source + 1] - offsets[source]` targets per source key.
#[derive(Debug, Clone, Copy)]
pub struct Relation<'a> {
	offsets: Section<'a>,
	targets: Section<'a>,
}

impl<'a> Relation<'a> {
	/// The relation whose `aux` is `index` in the header's relation list.
	pub fn from_artifact(artifact: &Artifact<'a>, index: u32) -> Result<Self, Error> {
		let offsets = artifact
			.section(sections::KIND_RELATION_OFFSETS, index)
			.ok_or(Error::MissingSection(sections::KIND_RELATION_OFFSETS))?;
		let targets = artifact
			.section(sections::KIND_RELATION_TARGETS, index)
			.ok_or(Error::MissingSection(sections::KIND_RELATION_TARGETS))?;

		if offsets.count == 0 {
			return Err(Error::Offsets);
		}

		let mut previous = 0u32;

		for at in 0..offsets.count as usize {
			let offset = offsets.element(at);

			if offset < previous {
				return Err(Error::Offsets);
			}

			previous = offset;
		}

		if previous != targets.count {
			return Err(Error::Offsets);
		}

		Ok(Relation { offsets, targets })
	}

	/// The number of source keys.
	pub fn sources(&self) -> usize {
		self.offsets.count as usize - 1
	}

	/// The target row ids of one source key.
	pub fn targets(&self, source: u32) -> impl Iterator<Item = u32> + 'a {
		let targets = self.targets;
		let (start, end) = if (source as usize) < self.sources() {
			(
				self.offsets.element(source as usize) as usize,
				self.offsets.element(source as usize + 1) as usize,
			)
		} else {
			(0, 0)
		};

		(start..end).map(move |index| targets.element(index))
	}
}

/// The classification mask bits `classify_many` writes.
pub mod mask {
	/// The code is an officially assigned ISO 3166-1 alpha-3 country code.
	pub const COUNTRY: u8 = 1;
	/// The code is an IATA airport code in the profile.
	pub const AIRPORT: u8 = 2;
	/// The code is both: the generated collision bit.
	pub const COLLISION: u8 = 4;
	/// The three bytes are not upper-case ASCII letters.
	pub const INVALID: u8 = 0x80;
}

/// Whether sixteen bytes are all upper-case ASCII letters, with `simd128` when the build enables it.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn all_upper_ascii_16(chunk: &[u8]) -> bool {
	use core::arch::wasm32::*;

	// SAFETY: the caller passes exactly sixteen bytes; `v128_load` reads sixteen.
	let vector = unsafe { v128_load(chunk.as_ptr() as *const v128) };
	let below = u8x16_lt(vector, u8x16_splat(b'A'));
	let above = u8x16_gt(vector, u8x16_splat(b'Z'));

	!v128_any_true(v128_or(below, above))
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline]
fn all_upper_ascii_16(chunk: &[u8]) -> bool {
	chunk.iter().all(|byte| byte.is_ascii_uppercase())
}

/// Classifies `count` packed three-byte codes into caller-owned masks.
///
/// `packed` holds `count * 3` bytes; `out` holds at least `count` bytes and receives one mask each.
/// The input is validated in sixteen-byte chunks first, so a batch of canonical codes takes the
/// vector path and only a chunk with a stray byte falls back to per-code checks.
///
/// # Errors
/// `Capacity` when `out` is shorter than `count` or `packed` shorter than `count * 3`;
/// `Overlap` when the two spans share memory.
pub fn classify_many(
	country: &Bitset,
	airport: &Bitset,
	collision: &Bitset,
	packed: &[u8],
	count: usize,
	out: &mut [u8],
) -> Result<usize, Error> {
	let needed = count.checked_mul(3).ok_or(Error::Capacity)?;

	if packed.len() < needed || out.len() < count {
		return Err(Error::Capacity);
	}

	let packed = &packed[..needed];
	let out = &mut out[..count];
	let input = packed.as_ptr_range();
	let output = out.as_ptr_range();

	if input.start < output.end && output.start < input.end {
		return Err(Error::Overlap);
	}

	let mut chunk_start = 0usize;

	while chunk_start + 16 <= needed {
		if !all_upper_ascii_16(&packed[chunk_start..chunk_start + 16]) {
			break;
		}

		chunk_start += 16;
	}

	let clean_codes = chunk_start / 3;

	for index in 0..count {
		let code = &packed[index * 3..index * 3 + 3];
		// The chunk check already established the prefix as upper-case letters, so its codes skip the per-byte test.
		let key = if index < clean_codes {
			Some(key::encode3_unchecked(code))
		} else {
			key::encode3(code)
		};

		out[index] = match key {
			None => mask::INVALID,
			Some(key) => {
				let mut bits = 0u8;

				if country.test(key) {
					bits |= mask::COUNTRY;
				}

				if airport.test(key) {
					bits |= mask::AIRPORT;
				}

				if collision.test(key) {
					bits |= mask::COLLISION;
				}

				bits
			}
		};
	}

	Ok(count)
}

/// Tests `count` packed codes against one bitset, writing 1, 0 or `mask::INVALID` per code.
pub fn test_many(bitset: &Bitset, packed: &[u8], count: usize, out: &mut [u8]) -> Result<usize, Error> {
	let arity = bitset.arity();
	let width = if arity == key::ARITY_NUMERIC { 3 } else { arity as usize };
	let needed = count.checked_mul(width).ok_or(Error::Capacity)?;

	if packed.len() < needed || out.len() < count {
		return Err(Error::Capacity);
	}

	let input = packed[..needed].as_ptr_range();
	let output = out[..count].as_ptr_range();

	if input.start < output.end && output.start < input.end {
		return Err(Error::Overlap);
	}

	for index in 0..count {
		let code = &packed[index * width..index * width + width];

		out[index] = match key::encode(arity, code) {
			None => mask::INVALID,
			Some(key) => bitset.test(key) as u8,
		};
	}

	Ok(count)
}
