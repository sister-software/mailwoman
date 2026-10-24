// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Field numbers and defaults follow Google SentencePiece v0.2.2 `src/sentencepiece_model.proto`.
// Copyright 2016 Google Inc. Licensed under the Apache License, Version 2.0
// (`third-party/sentencepiece/LICENSE` in this workspace). Modified: the schema is read by a
// hand-written Rust wire decoder instead of generated protobuf code.

//! A reader for the SentencePiece `ModelProto` fields the unigram processor uses.
//!
//! Every field this module does not name is skipped. A field the processor would need to honor and
//! this crate does not implement is refused in [`crate::processor`].

use crate::error::Error;

/// The `ModelProto.SentencePiece.Type` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PieceType {
	Normal,
	Unknown,
	Control,
	UserDefined,
	Unused,
	Byte,
}

impl PieceType {
	fn from_wire(value: u64) -> Result<Self, Error> {
		Ok(match value {
			1 => Self::Normal,
			2 => Self::Unknown,
			3 => Self::Control,
			4 => Self::UserDefined,
			5 => Self::Unused,
			6 => Self::Byte,
			other => return Err(Error::MalformedModel(format!("unknown piece type {other}"))),
		})
	}
}

pub struct PieceProto {
	pub piece: String,
	pub score: f32,
	pub kind: PieceType,
}

pub struct TrainerSpecProto {
	/// `model_type`; 1 is unigram.
	pub model_type: u64,
	pub treat_whitespace_as_suffix: bool,
	pub byte_fallback: bool,
	pub unk_surface: String,
}

pub struct NormalizerSpecProto {
	pub precompiled_charsmap: Vec<u8>,
	pub add_dummy_prefix: bool,
	pub remove_extra_whitespaces: bool,
	pub escape_whitespaces: bool,
}

pub struct ModelProto {
	pub pieces: Vec<PieceProto>,
	pub trainer_spec: TrainerSpecProto,
	pub normalizer_spec: NormalizerSpecProto,
	/// Whether a denormalizer spec carries a non-empty charsmap.
	pub has_denormalizer_charsmap: bool,
}

const WIRE_VARINT: u64 = 0;
const WIRE_FIXED64: u64 = 1;
const WIRE_LEN: u64 = 2;
const WIRE_FIXED32: u64 = 5;

struct Reader<'a> {
	buf: &'a [u8],
	pos: usize,
}

enum Value<'a> {
	Varint(u64),
	Fixed32(u32),
	Len(&'a [u8]),
	Other,
}

impl<'a> Reader<'a> {
	fn new(buf: &'a [u8]) -> Self {
		Self { buf, pos: 0 }
	}

	fn varint(&mut self) -> Result<u64, Error> {
		let mut result = 0u64;
		for shift in (0..64).step_by(7) {
			let byte = *self.buf.get(self.pos).ok_or_else(|| truncated("varint"))?;
			self.pos += 1;
			result |= ((byte & 0x7F) as u64) << shift;
			if byte & 0x80 == 0 {
				return Ok(result);
			}
		}
		Err(Error::MalformedModel("varint longer than 10 bytes".into()))
	}

	fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
		let end = self
			.pos
			.checked_add(n)
			.filter(|&end| end <= self.buf.len())
			.ok_or_else(|| truncated("field"))?;
		let slice = &self.buf[self.pos..end];
		self.pos = end;
		Ok(slice)
	}

	/// Reads the next `(field number, value)`, or `None` at the end of the message.
	fn next(&mut self) -> Result<Option<(u64, Value<'a>)>, Error> {
		if self.pos >= self.buf.len() {
			return Ok(None);
		}
		let key = self.varint()?;
		let field = key >> 3;
		let value = match key & 7 {
			WIRE_VARINT => Value::Varint(self.varint()?),
			WIRE_FIXED64 => {
				self.take(8)?;
				Value::Other
			}
			WIRE_LEN => {
				let n = self.varint()? as usize;
				Value::Len(self.take(n)?)
			}
			WIRE_FIXED32 => {
				let b = self.take(4)?;
				Value::Fixed32(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
			}
			wire => return Err(Error::MalformedModel(format!("unsupported wire type {wire}"))),
		};
		Ok(Some((field, value)))
	}
}

fn truncated(what: &str) -> Error {
	Error::MalformedModel(format!("truncated {what}"))
}

fn utf8(bytes: &[u8], what: &str) -> Result<String, Error> {
	String::from_utf8(bytes.to_vec()).map_err(|_| Error::MalformedModel(format!("{what} is not UTF-8")))
}

fn parse_piece(buf: &[u8]) -> Result<PieceProto, Error> {
	let mut piece = PieceProto {
		piece: String::new(),
		score: 0.0,
		kind: PieceType::Normal,
	};
	let mut r = Reader::new(buf);
	while let Some((field, value)) = r.next()? {
		match (field, value) {
			(1, Value::Len(b)) => piece.piece = utf8(b, "piece")?,
			(2, Value::Fixed32(bits)) => piece.score = f32::from_bits(bits),
			(3, Value::Varint(v)) => piece.kind = PieceType::from_wire(v)?,
			_ => {}
		}
	}
	Ok(piece)
}

fn parse_trainer_spec(buf: &[u8], spec: &mut TrainerSpecProto) -> Result<(), Error> {
	let mut r = Reader::new(buf);
	while let Some((field, value)) = r.next()? {
		match (field, value) {
			(3, Value::Varint(v)) => spec.model_type = v,
			(24, Value::Varint(v)) => spec.treat_whitespace_as_suffix = v != 0,
			(35, Value::Varint(v)) => spec.byte_fallback = v != 0,
			(44, Value::Len(b)) => spec.unk_surface = utf8(b, "unk_surface")?,
			_ => {}
		}
	}
	Ok(())
}

fn parse_normalizer_spec(buf: &[u8], spec: &mut NormalizerSpecProto) -> Result<(), Error> {
	let mut r = Reader::new(buf);
	while let Some((field, value)) = r.next()? {
		match (field, value) {
			(2, Value::Len(b)) => spec.precompiled_charsmap = b.to_vec(),
			(3, Value::Varint(v)) => spec.add_dummy_prefix = v != 0,
			(4, Value::Varint(v)) => spec.remove_extra_whitespaces = v != 0,
			(5, Value::Varint(v)) => spec.escape_whitespaces = v != 0,
			_ => {}
		}
	}
	Ok(())
}

fn default_normalizer_spec() -> NormalizerSpecProto {
	NormalizerSpecProto {
		precompiled_charsmap: Vec::new(),
		add_dummy_prefix: true,
		remove_extra_whitespaces: true,
		escape_whitespaces: true,
	}
}

/// Parses serialized `ModelProto` bytes, applying the proto's declared defaults to absent fields.
pub fn parse_model(buf: &[u8]) -> Result<ModelProto, Error> {
	let mut model = ModelProto {
		pieces: Vec::new(),
		trainer_spec: TrainerSpecProto {
			model_type: 1,
			treat_whitespace_as_suffix: false,
			byte_fallback: false,
			unk_surface: " \u{2047} ".into(),
		},
		normalizer_spec: default_normalizer_spec(),
		has_denormalizer_charsmap: false,
	};
	let mut r = Reader::new(buf);
	while let Some((field, value)) = r.next()? {
		match (field, value) {
			(1, Value::Len(b)) => model.pieces.push(parse_piece(b)?),
			(2, Value::Len(b)) => parse_trainer_spec(b, &mut model.trainer_spec)?,
			(3, Value::Len(b)) => parse_normalizer_spec(b, &mut model.normalizer_spec)?,
			(5, Value::Len(b)) => {
				let mut denormalizer = default_normalizer_spec();
				parse_normalizer_spec(b, &mut denormalizer)?;
				model.has_denormalizer_charsmap = !denormalizer.precompiled_charsmap.is_empty();
			}
			_ => {}
		}
	}
	Ok(model)
}
