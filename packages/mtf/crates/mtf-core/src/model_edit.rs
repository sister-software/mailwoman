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
//!
//! [`ModelEditor::retain_spec_fields`] drops fields from the trainer or normalizer spec. The native `spm_train`
//! sets every trainer flag explicitly, so its model records each default, while the Python wheel's model records
//! only the fields its caller named; dropping the others gives the wheel's bytes.

use crate::error::Error;
use crate::proto::{parse_piece, PieceType, Reader};

const PIECES_FIELD: u64 = 1;

/// `ModelProto.trainer_spec`.
pub const TRAINER_SPEC_FIELD: u64 = 2;
/// `ModelProto.normalizer_spec`.
pub const NORMALIZER_SPEC_FIELD: u64 = 3;

/// Each `TrainerSpec` field's name and number, from SentencePiece v0.2.2 `src/sentencepiece_model.proto`.
pub const TRAINER_SPEC_FIELDS: &[(&str, u64)] = &[
	("input", 1),
	("model_prefix", 2),
	("model_type", 3),
	("vocab_size", 4),
	("accept_language", 5),
	("self_test_sample_size", 6),
	("input_format", 7),
	("character_coverage", 10),
	("input_sentence_size", 11),
	("mining_sentence_size", 12),
	("training_sentence_size", 13),
	("seed_sentencepiece_size", 14),
	("shrinking_factor", 15),
	("num_threads", 16),
	("num_sub_iterations", 17),
	("max_sentence_length", 18),
	("shuffle_input_sentence", 19),
	("max_sentencepiece_length", 20),
	("split_by_unicode_script", 21),
	("split_by_whitespace", 22),
	("split_by_number", 23),
	("treat_whitespace_as_suffix", 24),
	("split_digits", 25),
	("allow_whitespace_only_pieces", 26),
	("control_symbols", 30),
	("user_defined_symbols", 31),
	("vocabulary_output_piece_score", 32),
	("hard_vocab_limit", 33),
	("use_all_vocab", 34),
	("byte_fallback", 35),
	("required_chars", 36),
	("unk_id", 40),
	("bos_id", 41),
	("eos_id", 42),
	("pad_id", 43),
	("unk_surface", 44),
	("unk_piece", 45),
	("bos_piece", 46),
	("eos_piece", 47),
	("pad_piece", 48),
	("train_extremely_large_corpus", 49),
	("enable_differential_privacy", 50),
	("differential_privacy_noise_level", 51),
	("differential_privacy_clipping_threshold", 52),
	("pretokenization_delimiter", 53),
	("seed_sentencepieces_file", 54),
];

/// Each `NormalizerSpec` field's name and number.
pub const NORMALIZER_SPEC_FIELDS: &[(&str, u64)] = &[
	("name", 1),
	("precompiled_charsmap", 2),
	("add_dummy_prefix", 3),
	("remove_extra_whitespaces", 4),
	("escape_whitespaces", 5),
	("normalization_rule_tsv", 6),
];

/// The number of the field named `name` in `fields`.
pub fn field_number(fields: &[(&str, u64)], name: &str) -> Option<u64> {
	fields.iter().find(|&&(n, _)| n == name).map(|&(_, number)| number)
}

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
	/// Any other top-level field, as read: its number and its bytes, tag included.
	Raw(u64, Vec<u8>),
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
				fields.push(Field::Raw(field, buf[start..reader.pos].to_vec()));
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

	/// Keeps only the fields of the top-level message `spec` (such as [`TRAINER_SPEC_FIELD`]) whose numbers
	/// `keep` admits, each as the bytes it was read from and in its original order. A model without the message
	/// is unchanged. Returns the numbers of the fields dropped, once each, in the order first seen.
	pub fn retain_spec_fields(&mut self, spec: u64, keep: &dyn Fn(u64) -> bool) -> Result<Vec<u64>, Error> {
		let mut dropped = Vec::new();
		for field in &mut self.fields {
			let Field::Raw(number, bytes) = field else { continue };
			if *number != spec {
				continue;
			}
			let mut outer = Reader::new(bytes);
			let Some((_, crate::proto::Value::Len(payload))) = outer.next()? else {
				return Err(Error::MalformedModel(format!(
					"field {spec} is not a length-delimited message"
				)));
			};
			let mut kept = Vec::with_capacity(payload.len());
			let mut inner = Reader::new(payload);
			loop {
				let start = inner.pos;
				let Some((sub, _)) = inner.next()? else { break };
				if keep(sub) {
					kept.extend_from_slice(&payload[start..inner.pos]);
				} else if !dropped.contains(&sub) {
					dropped.push(sub);
				}
			}
			let mut rewritten = Vec::with_capacity(kept.len() + 6);
			put_tag(&mut rewritten, spec, 2);
			put_varint(&mut rewritten, kept.len() as u64);
			rewritten.extend_from_slice(&kept);
			*bytes = rewritten;
		}
		Ok(dropped)
	}

	/// The serialized model.
	pub fn to_bytes(&self) -> Vec<u8> {
		let mut out = Vec::new();
		for field in &self.fields {
			match field {
				Field::Raw(_, bytes) => out.extend_from_slice(bytes),
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
