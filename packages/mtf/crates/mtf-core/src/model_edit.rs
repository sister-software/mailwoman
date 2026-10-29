// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Edit a serialized SentencePiece `ModelProto`'s vocabulary and write it back.
//!
//! The editor keeps every top-level field as the bytes it was read from, in order, and parses only the pieces
//! (field 1). An unedited model therefore serializes to its input bytes. A kept piece is written from its original
//! bytes too, so pruning changes only which pieces are present. An appended piece is encoded the way Python's
//! protobuf runtime encodes a `SentencePiece` whose `piece`, `score` and `type` were all set: fields 1, 2 and 3, in
//! that order. The pieces are written where the input's first piece stood, so appended pieces follow the kept ones,
//! as `pieces.add()` and `SerializeToString` place them.

use crate::error::Error;
use crate::proto::{parse_piece, PieceType, Reader};

const PIECES_FIELD: u64 = 1;

/// One vocabulary entry and the bytes it serializes to.
#[derive(Debug, Clone, PartialEq)]
pub struct EditablePiece {
	pub piece: String,
	pub score: f32,
	pub kind: PieceType,
	/// The piece message's payload, without its field tag and length.
	payload: Vec<u8>,
}

impl EditablePiece {
	/// A new piece, encoded with all three of its fields present.
	pub fn new(piece: &str, score: f32, kind: PieceType) -> Self {
		let mut payload = Vec::with_capacity(piece.len() + 10);
		put_tag(&mut payload, 1, 2);
		put_varint(&mut payload, piece.len() as u64);
		payload.extend_from_slice(piece.as_bytes());
		put_tag(&mut payload, 2, 5);
		payload.extend_from_slice(&score.to_le_bytes());
		put_tag(&mut payload, 3, 0);
		put_varint(&mut payload, kind.wire());
		Self {
			piece: piece.to_owned(),
			score,
			kind,
			payload,
		}
	}
}

enum Field {
	/// The position the vocabulary is written at.
	Pieces,
	/// Any other top-level field, as read.
	Raw(Vec<u8>),
}

/// A `ModelProto` whose vocabulary can be pruned and extended.
pub struct ModelEditor {
	fields: Vec<Field>,
	pieces: Vec<EditablePiece>,
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
	while value >= 0x80 {
		out.push((value as u8) | 0x80);
		value >>= 7;
	}
	out.push(value as u8);
}

fn put_tag(out: &mut Vec<u8>, field: u64, wire: u64) {
	put_varint(out, (field << 3) | wire);
}

impl ModelEditor {
	/// Reads a serialized model. The pieces must be contiguous, as every protobuf serializer writes a repeated field.
	pub fn parse(buf: &[u8]) -> Result<Self, Error> {
		let mut reader = Reader::new(buf);
		let mut fields = Vec::new();
		let mut pieces = Vec::new();
		let mut pieces_ended = false;
		loop {
			let start = reader.pos;
			let Some((field, value)) = reader.next()? else { break };
			if field == PIECES_FIELD {
				let crate::proto::Value::Len(payload) = value else {
					return Err(Error::MalformedModel(
						"a piece is not a length-delimited message".into(),
					));
				};
				if pieces_ended {
					return Err(Error::MalformedModel("the pieces are not contiguous".into()));
				}
				if pieces.is_empty() {
					fields.push(Field::Pieces);
				}
				let parsed = parse_piece(payload)?;
				pieces.push(EditablePiece {
					piece: parsed.piece.to_owned(),
					score: parsed.score,
					kind: parsed.kind,
					payload: payload.to_vec(),
				});
			} else {
				pieces_ended = !pieces.is_empty();
				fields.push(Field::Raw(buf[start..reader.pos].to_vec()));
			}
		}
		if pieces.is_empty() {
			fields.insert(0, Field::Pieces);
		}
		Ok(Self { fields, pieces })
	}

	/// The vocabulary, in id order.
	pub fn pieces(&self) -> &[EditablePiece] {
		&self.pieces
	}

	/// Keeps the pieces at `ids`, in the order given, as pruning does. An id may appear once.
	pub fn keep(&mut self, ids: &[usize]) -> Result<(), Error> {
		let mut seen = vec![false; self.pieces.len()];
		let mut kept = Vec::with_capacity(ids.len());
		for &id in ids {
			let slot = seen
				.get_mut(id)
				.ok_or_else(|| Error::MalformedModel(format!("piece id {id} is outside the vocabulary")))?;
			if *slot {
				return Err(Error::MalformedModel(format!("piece id {id} is kept twice")));
			}
			*slot = true;
			kept.push(self.pieces[id].clone());
		}
		self.pieces = kept;
		Ok(())
	}

	/// Appends a piece after the current vocabulary.
	pub fn push(&mut self, piece: EditablePiece) {
		self.pieces.push(piece);
	}

	/// The serialized model.
	pub fn to_bytes(&self) -> Vec<u8> {
		let mut out = Vec::new();
		for field in &self.fields {
			match field {
				Field::Raw(bytes) => out.extend_from_slice(bytes),
				Field::Pieces => {
					for piece in &self.pieces {
						put_tag(&mut out, PIECES_FIELD, 2);
						put_varint(&mut out, piece.payload.len() as u64);
						out.extend_from_slice(&piece.payload);
					}
				}
			}
		}
		out
	}
}
