// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The RGY1 envelope: parse and validate once, then borrow sections.

use crate::sections;

/// Why a byte sequence is not an RGY1 artifact this reader accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
	/// Fewer bytes than the fixed envelope.
	Truncated,
	/// The first four bytes are not `RGY1`.
	Magic,
	/// An envelope version this reader does not implement.
	Version(u16),
	/// An envelope flag bit this reader does not know.
	Flags(u16),
	/// A reserved field holds a value other than zero.
	Reserved,
	/// The stated total length differs from the byte count.
	Length,
	/// The header is not strict UTF-8.
	HeaderUTF8,
	/// A directory or payload offset breaks the layout rule.
	Layout,
	/// A section lies outside the artifact, overlaps another, or is misaligned.
	SectionBounds(u32),
	/// A section kind the reader does not know is marked required.
	UnknownRequiredKind(u16),
	/// A known kind written with an encoding the reader does not implement.
	Encoding(u16, u16),
	/// A section's element width does not fit its kind.
	ElementWidth(u16),
	/// A section's count and length disagree.
	Count(u16),
	/// A section's `aux` names a key space the reader does not know.
	KeySpace(u32),
	/// Offsets that are not monotonic or do not end at their target's length.
	Offsets,
	/// A pool string is not strict UTF-8.
	StringUTF8,
	/// The section a lookup needs is absent.
	MissingSection(u16),
	/// A caller-owned output buffer is too small.
	Capacity,
	/// Input and output spans overlap.
	Overlap,
}

/// One directory entry with its payload.
#[derive(Debug, Clone, Copy)]
pub struct Section<'a> {
	pub kind: u16,
	pub encoding: u16,
	pub element_width: u16,
	pub flags: u16,
	pub offset: u32,
	pub length: u32,
	pub count: u32,
	pub aux: u32,
	pub payload: &'a [u8],
}

/// A validated artifact borrowing the caller's bytes.
#[derive(Debug, Clone, Copy)]
pub struct Artifact<'a> {
	bytes: &'a [u8],
	header: &'a str,
	directory: &'a [u8],
	section_count: usize,
}

#[inline]
fn u16_at(bytes: &[u8], at: usize) -> u16 {
	u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

#[inline]
fn u32_at(bytes: &[u8], at: usize) -> u32 {
	u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Rounds up to the section alignment.
pub const fn align(value: usize) -> usize {
	value.div_ceil(sections::ALIGNMENT) * sections::ALIGNMENT
}

impl<'a> Artifact<'a> {
	/// Parses and validates the envelope, directory and every section's framing.
	///
	/// Section payloads are checked for the properties the directory states: bounds, alignment,
	/// order, kind, encoding, width and count. Pool offsets and relation offsets are checked when the
	/// typed view is built, because that is where the paired section is known.
	pub fn parse(bytes: &'a [u8]) -> Result<Self, Error> {
		if bytes.len() < sections::HEADER_OFFSET {
			return Err(Error::Truncated);
		}

		if &bytes[0..4] != sections::MAGIC {
			return Err(Error::Magic);
		}

		let version = u16_at(bytes, 4);

		if version != sections::VERSION {
			return Err(Error::Version(version));
		}

		let flags = u16_at(bytes, 6);

		if flags != 0 {
			return Err(Error::Flags(flags));
		}

		let header_length = u32_at(bytes, 8) as usize;
		let section_count = u32_at(bytes, 12) as usize;
		let directory_offset = u32_at(bytes, 16) as usize;
		let total_length = u32_at(bytes, 20) as usize;
		let first_payload = u32_at(bytes, 24) as usize;

		if u32_at(bytes, 28) != 0 {
			return Err(Error::Reserved);
		}

		if total_length != bytes.len() {
			return Err(Error::Length);
		}

		let header_end = sections::HEADER_OFFSET
			.checked_add(header_length)
			.ok_or(Error::Layout)?;

		if header_end > bytes.len() || directory_offset != align(header_end) {
			return Err(Error::Layout);
		}

		let directory_length = section_count
			.checked_mul(sections::DIRECTORY_ENTRY_BYTES)
			.ok_or(Error::Layout)?;
		let directory_end = directory_offset.checked_add(directory_length).ok_or(Error::Layout)?;

		if directory_end > bytes.len() || first_payload != align(directory_end) || first_payload > bytes.len() {
			return Err(Error::Layout);
		}

		let header =
			core::str::from_utf8(&bytes[sections::HEADER_OFFSET..header_end]).map_err(|_| Error::HeaderUTF8)?;

		if bytes[header_end..directory_offset].iter().any(|byte| *byte != 0) {
			return Err(Error::Layout);
		}

		let artifact = Artifact {
			bytes,
			header,
			directory: &bytes[directory_offset..directory_end],
			section_count,
		};

		let mut cursor = first_payload;

		for index in 0..section_count {
			let section = artifact.entry(index)?;
			let offset = section.offset as usize;
			let end = offset
				.checked_add(section.length as usize)
				.ok_or(Error::SectionBounds(index as u32))?;

			if !offset.is_multiple_of(sections::ALIGNMENT) || offset < cursor || end > bytes.len() {
				return Err(Error::SectionBounds(index as u32));
			}

			if bytes[cursor..offset].iter().any(|byte| *byte != 0) {
				return Err(Error::SectionBounds(index as u32));
			}

			cursor = end;
		}

		if bytes[cursor..].len() >= sections::ALIGNMENT || bytes[cursor..].iter().any(|byte| *byte != 0) {
			return Err(Error::Layout);
		}

		Ok(artifact)
	}

	/// The canonical JSON header, unparsed.
	pub fn header(&self) -> &'a str {
		self.header
	}

	/// The whole artifact.
	pub fn bytes(&self) -> &'a [u8] {
		self.bytes
	}

	/// The number of directory entries.
	pub fn section_count(&self) -> usize {
		self.section_count
	}

	fn entry(&self, index: usize) -> Result<Section<'a>, Error> {
		let at = index * sections::DIRECTORY_ENTRY_BYTES;
		let entry = &self.directory[at..at + sections::DIRECTORY_ENTRY_BYTES];
		let kind = u16_at(entry, 0);
		let encoding = u16_at(entry, 2);
		let element_width = u16_at(entry, 4);
		let flags = u16_at(entry, 6);
		let offset = u32_at(entry, 8);
		let length = u32_at(entry, 12);
		let count = u32_at(entry, 16);
		let aux = u32_at(entry, 20);

		match sections::encoding_of(kind) {
			Some(known) if known == encoding => {}
			Some(_) => return Err(Error::Encoding(kind, encoding)),
			None if flags & sections::FLAG_REQUIRED != 0 => return Err(Error::UnknownRequiredKind(kind)),
			None => {}
		}

		let end = (offset as usize)
			.checked_add(length as usize)
			.ok_or(Error::SectionBounds(index as u32))?;

		if end > self.bytes.len() {
			return Err(Error::SectionBounds(index as u32));
		}

		let section = Section {
			kind,
			encoding,
			element_width,
			flags,
			offset,
			length,
			count,
			aux,
			payload: &self.bytes[offset as usize..end],
		};

		section.check_shape()?;

		Ok(section)
	}

	/// Every section in directory order.
	pub fn sections(&self) -> impl Iterator<Item = Section<'a>> + '_ {
		(0..self.section_count).filter_map(move |index| self.entry(index).ok())
	}

	/// The first section of a kind with the given `aux`, or `None`.
	pub fn section(&self, kind: u16, aux: u32) -> Option<Section<'a>> {
		self.sections()
			.find(|section| section.kind == kind && section.aux == aux)
	}

	/// The first section of a kind, whatever its `aux`.
	pub fn first_section(&self, kind: u16) -> Option<Section<'a>> {
		self.sections().find(|section| section.kind == kind)
	}
}

impl Section<'_> {
	/// Checks width and count against the kind's rules.
	fn check_shape(&self) -> Result<(), Error> {
		let length = self.length as usize;
		let count = self.count as usize;

		match self.kind {
			sections::KIND_BITSET => {
				if self.element_width != 0 {
					return Err(Error::ElementWidth(self.kind));
				}

				let space = crate::key::key_space(self.aux).ok_or(Error::KeySpace(self.aux))?;

				if count != space as usize || length != count.div_ceil(8) {
					return Err(Error::Count(self.kind));
				}
			}
			sections::KIND_ID_TABLE => {
				if !matches!(self.element_width, 1 | 2 | 4) {
					return Err(Error::ElementWidth(self.kind));
				}

				let space = crate::key::key_space(self.aux).ok_or(Error::KeySpace(self.aux))?;

				if count != space as usize || length != count * self.element_width as usize {
					return Err(Error::Count(self.kind));
				}
			}
			sections::KIND_STRING_OFFSETS | sections::KIND_RELATION_OFFSETS | sections::KIND_RELATION_TARGETS => {
				if self.element_width != 4 {
					return Err(Error::ElementWidth(self.kind));
				}

				if length != count * 4 {
					return Err(Error::Count(self.kind));
				}
			}
			sections::KIND_UTF8 => {
				if self.element_width != 0 {
					return Err(Error::ElementWidth(self.kind));
				}

				if length != count {
					return Err(Error::Count(self.kind));
				}
			}
			sections::KIND_COLUMN => {
				if !matches!(self.element_width, 1 | 2 | 4 | 8) {
					return Err(Error::ElementWidth(self.kind));
				}

				if length != count * self.element_width as usize {
					return Err(Error::Count(self.kind));
				}
			}
			// An unknown optional kind is skipped; its shape is its own business.
			_ => {}
		}

		Ok(())
	}

	/// Reads the unsigned element at `index` for widths 1, 2 and 4.
	#[inline]
	pub fn element(&self, index: usize) -> u32 {
		let at = index * self.element_width as usize;

		match self.element_width {
			1 => self.payload[at] as u32,
			2 => u16_at(self.payload, at) as u32,
			_ => u32_at(self.payload, at),
		}
	}
}
