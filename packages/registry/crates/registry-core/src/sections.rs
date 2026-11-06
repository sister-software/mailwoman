// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The RGY1 section kinds. Generated from `definitions/sections.json` by
//! `tools/generate-sections.run.ts`. Edit the definition rather than this file.

pub const MAGIC: &[u8; 4] = b"RGY1";
pub const VERSION: u16 = 1;
pub const HEADER_OFFSET: usize = 32;
pub const DIRECTORY_ENTRY_BYTES: usize = 24;
pub const ALIGNMENT: usize = 8;
pub const FLAG_REQUIRED: u16 = 1;

pub const KIND_BITSET: u16 = 1;
pub const KIND_ID_TABLE: u16 = 2;
pub const KIND_STRING_OFFSETS: u16 = 3;
pub const KIND_UTF8: u16 = 4;
pub const KIND_COLUMN: u16 = 5;
pub const KIND_RELATION_OFFSETS: u16 = 6;
pub const KIND_RELATION_TARGETS: u16 = 7;

/// The encoding version a kind is written with, or `None` for an unknown kind.
pub fn encoding_of(kind: u16) -> Option<u16> {
	match kind {
		KIND_BITSET => Some(1),
		KIND_ID_TABLE => Some(1),
		KIND_STRING_OFFSETS => Some(1),
		KIND_UTF8 => Some(1),
		KIND_COLUMN => Some(1),
		KIND_RELATION_OFFSETS => Some(1),
		KIND_RELATION_TARGETS => Some(1),
		_ => None,
	}
}

/// The kind's name, for diagnostics.
pub fn name_of(kind: u16) -> &'static str {
	match kind {
		KIND_BITSET => "bitset",
		KIND_ID_TABLE => "id-table",
		KIND_STRING_OFFSETS => "string-offsets",
		KIND_UTF8 => "utf8",
		KIND_COLUMN => "column",
		KIND_RELATION_OFFSETS => "relation-offsets",
		KIND_RELATION_TARGETS => "relation-targets",
		_ => "unknown",
	}
}
