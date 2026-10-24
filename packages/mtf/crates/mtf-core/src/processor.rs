// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Derived from Google SentencePiece v0.2.2 `src/sentencepiece_processor.cc` and
// `src/model_interface.cc`. Copyright 2016 Google Inc. Licensed under the Apache License,
// Version 2.0 (`third-party/sentencepiece/LICENSE` in this workspace). Modified: ported from C++ to
// Rust and reduced to unigram encode and decode.

//! A loaded model with SentencePiece v0.2.2's encode and decode behavior.

use crate::error::Error;
use crate::normalizer::Normalizer;
use crate::proto::{parse_model, PieceType};
use crate::unigram::{self, ByteTrie, Candidate};
use crate::utf8;
use std::collections::HashMap;

const SPACE_SYMBOL: &str = "\u{2581}";
const REPLACEMENT_CHAR: &str = "\u{FFFD}";
const UNK_PENALTY: f32 = 10.0;
const MAX_PIECE_SIZE: usize = 8000;

/// One piece of an encoded input.
///
/// `begin` and `end` are UTF-8 byte offsets into the original input. A byte-fallback piece other than
/// the last one for its character has `begin == end`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedPiece {
	pub id: u32,
	pub piece: String,
	pub begin: usize,
	pub end: usize,
}

struct Piece {
	text: String,
	score: f32,
	kind: PieceType,
}

/// A loaded unigram model.
pub struct Processor {
	pieces: Vec<Piece>,
	piece_index: ByteTrie,
	user_defined: ByteTrie,
	/// IDs of every piece by its text, used to find byte-fallback pieces.
	ids: HashMap<String, u32>,
	normalizer: Normalizer,
	unk_id: u32,
	unk_score: f32,
	byte_fallback: bool,
	unk_surface: String,
	add_dummy_prefix: bool,
	remove_extra_whitespaces: bool,
}

impl Processor {
	/// Loads a serialized SentencePiece `ModelProto`.
	///
	/// The model must be unigram and must not carry a denormalizer charsmap, the two semantic features
	/// this crate does not implement.
	pub fn from_model_proto(bytes: &[u8]) -> Result<Self, Error> {
		let model = parse_model(bytes)?;
		if model.trainer_spec.model_type != 1 {
			return Err(Error::Unsupported(format!(
				"model_type {} (only unigram is implemented)",
				model.trainer_spec.model_type
			)));
		}
		if model.has_denormalizer_charsmap {
			return Err(Error::Unsupported(
				"denormalizer_spec with a precompiled charsmap".into(),
			));
		}

		let mut piece_index = ByteTrie::new();
		let mut user_defined = ByteTrie::new();
		let mut ids = HashMap::with_capacity(model.pieces.len());
		let mut unk_id = None;
		let mut min_score = f32::MAX;
		let mut pieces = Vec::with_capacity(model.pieces.len());
		for (i, p) in model.pieces.into_iter().enumerate() {
			let id = i as u32;
			if p.piece.len() >= MAX_PIECE_SIZE {
				return Err(Error::MalformedModel("piece is too long".into()));
			}
			if p.piece.is_empty() {
				return Err(Error::MalformedModel("piece must not be empty".into()));
			}
			if p.piece.contains('\0') {
				return Err(Error::MalformedModel("piece must not include null character".into()));
			}
			if !p.score.is_finite() {
				return Err(Error::MalformedModel("score is NaN or Inf".into()));
			}
			if ids.insert(p.piece.clone(), id).is_some() {
				return Err(Error::MalformedModel(format!("{} is already defined", p.piece)));
			}
			match p.kind {
				PieceType::Normal | PieceType::UserDefined | PieceType::Unused => {
					piece_index.insert(p.piece.as_bytes(), id as i32);
				}
				PieceType::Unknown => {
					if unk_id.replace(id).is_some() {
						return Err(Error::MalformedModel("unk is already defined".into()));
					}
				}
				PieceType::Control | PieceType::Byte => {}
			}
			if p.kind == PieceType::UserDefined {
				user_defined.insert(p.piece.as_bytes(), id as i32);
			}
			if p.kind == PieceType::Normal {
				min_score = min_score.min(p.score);
			}
			pieces.push(Piece {
				text: p.piece,
				score: p.score,
				kind: p.kind,
			});
		}
		if min_score == f32::MAX {
			min_score = 0.0;
		}
		let unk_id = unk_id.ok_or_else(|| Error::MalformedModel("unk is not defined".into()))?;
		if model.trainer_spec.byte_fallback {
			for b in 0..=255u8 {
				let name = byte_piece(b);
				match ids.get(&name) {
					Some(&id) if pieces[id as usize].kind == PieceType::Byte => {}
					_ => return Err(Error::MalformedModel(format!("byte piece {name} is not defined"))),
				}
			}
		}

		let spec = &model.normalizer_spec;
		let normalizer = Normalizer::new(
			&spec.precompiled_charsmap,
			spec.add_dummy_prefix,
			spec.remove_extra_whitespaces,
			spec.escape_whitespaces,
			model.trainer_spec.treat_whitespace_as_suffix,
		)?;
		Ok(Self {
			pieces,
			piece_index,
			user_defined,
			ids,
			normalizer,
			unk_id,
			unk_score: min_score - UNK_PENALTY,
			byte_fallback: model.trainer_spec.byte_fallback,
			unk_surface: model.trainer_spec.unk_surface,
			add_dummy_prefix: spec.add_dummy_prefix,
			remove_extra_whitespaces: spec.remove_extra_whitespaces,
		})
	}

	/// The number of vocabulary rows.
	pub fn vocab_size(&self) -> usize {
		self.pieces.len()
	}

	/// Encodes `input` into pieces with original-input byte offsets.
	pub fn encode(&self, input: &str) -> Result<Vec<EncodedPiece>, Error> {
		let input = input.as_bytes();
		let normalized = self.normalizer.normalize(input, &self.user_defined)?;
		let norm_to_orig = &normalized.norm_to_orig;
		let segments = unigram::encode(
			&normalized.text,
			&self.piece_index,
			|id| match self.pieces[id as usize].kind {
				PieceType::UserDefined => Candidate::UserDefined,
				PieceType::Unused => Candidate::Unused,
				_ => Candidate::Scored(self.pieces[id as usize].score),
			},
			self.unk_id as i32,
			self.unk_score,
		);

		let mut out: Vec<EncodedPiece> = Vec::with_capacity(segments.len());
		let mut consumed = 0usize;
		let mut is_prev_unk = false;
		for (start, end, id) in segments {
			let w = &normalized.text[start..end];
			let id = id as u32;
			let is_unk = id == self.unk_id;
			let (Some(&orig_begin), Some(&orig_end)) =
				(norm_to_orig.get(consumed), norm_to_orig.get(consumed + w.len()))
			else {
				return Err(Error::Internal("piece extends past the normalized text".into()));
			};
			if orig_begin > orig_end || orig_end > input.len() {
				return Err(Error::Internal("piece offsets fall outside the input".into()));
			}
			if is_unk && self.byte_fallback {
				for (i, &b) in w.iter().enumerate() {
					let piece = byte_piece(b);
					let id = self.ids[&piece];
					let end = if i == w.len() - 1 { orig_end } else { orig_begin };
					out.push(EncodedPiece {
						id,
						piece,
						begin: orig_begin,
						end,
					});
				}
			} else if is_prev_unk && is_unk {
				let last = out.last_mut().expect("a previous unknown piece exists");
				last.piece.push_str(&lossy(w));
				last.end = orig_end;
			} else {
				out.push(EncodedPiece {
					id,
					piece: lossy(w),
					begin: orig_begin,
					end: orig_end,
				});
			}
			consumed += w.len();
			is_prev_unk = is_unk;
		}
		if consumed != normalized.text.len() {
			return Err(Error::Internal("all normalized characters are not consumed".into()));
		}
		Ok(out)
	}

	/// Decodes vocabulary IDs into text.
	pub fn decode(&self, ids: &[u32]) -> Result<String, Error> {
		for &id in ids {
			if id as usize >= self.pieces.len() {
				return Err(Error::InvalidID(id as i64));
			}
		}
		let mut text: Vec<u8> = Vec::new();
		let mut byte_start = 0usize;
		let mut is_bos_ws = true;
		let mut bos_ws_seen = false;
		for (i, &id) in ids.iter().enumerate() {
			if self.pieces[id as usize].kind == PieceType::Byte {
				continue;
			}
			self.decode_bytes(&ids[byte_start..i], &mut text)?;
			if bos_ws_seen || !text.is_empty() {
				is_bos_ws = false;
			}
			byte_start = i + 1;
			let decoded;
			(decoded, bos_ws_seen) = self.decode_piece(id, is_bos_ws);
			text.extend_from_slice(decoded.as_bytes());
		}
		self.decode_bytes(&ids[byte_start..], &mut text)?;
		Ok(String::from_utf8_lossy(&text).into_owned())
	}

	fn decode_piece(&self, id: u32, is_bos_ws: bool) -> (String, bool) {
		let piece = &self.pieces[id as usize];
		match piece.kind {
			PieceType::Control => return (String::new(), false),
			PieceType::Unknown => return (self.unk_surface.clone(), false),
			_ => {}
		}
		let mut text = piece.text.as_str();
		let mut has_bos_ws = false;
		if is_bos_ws && (self.add_dummy_prefix || self.remove_extra_whitespaces) {
			if let Some(rest) = text.strip_prefix(SPACE_SYMBOL) {
				text = rest;
				has_bos_ws = true;
			}
			if self.remove_extra_whitespaces {
				has_bos_ws = false;
			}
		}
		(text.replace(SPACE_SYMBOL, " "), has_bos_ws)
	}

	/// Appends the characters a run of byte pieces spells, mapping each invalid byte to U+FFFD.
	fn decode_bytes(&self, ids: &[u32], text: &mut Vec<u8>) -> Result<(), Error> {
		if ids.is_empty() {
			return Ok(());
		}
		let mut bytes = Vec::with_capacity(ids.len());
		for &id in ids {
			let b = piece_byte(&self.pieces[id as usize].text)
				.ok_or_else(|| Error::Internal(format!("byte piece {id} does not name a byte")))?;
			bytes.push(b);
		}
		let mut offset = 0;
		while offset < bytes.len() {
			let (valid, length) = utf8::decode_prefix(&bytes[offset..]);
			if valid {
				text.extend_from_slice(&bytes[offset..offset + length]);
			} else {
				text.extend_from_slice(REPLACEMENT_CHAR.as_bytes());
			}
			offset += length;
		}
		Ok(())
	}
}

fn byte_piece(b: u8) -> String {
	format!("<0x{b:02X}>")
}

fn piece_byte(piece: &str) -> Option<u8> {
	let hex = piece.strip_prefix("<0x")?.strip_suffix('>')?;
	if hex.len() != 2 {
		return None;
	}
	u8::from_str_radix(hex, 16).ok()
}

/// Converts a normalized byte range to a string.
///
/// The normalizer emits valid UTF-8, and a unigram piece boundary always falls on a character
/// boundary, so the lossy conversion never substitutes in practice.
fn lossy(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes).into_owned()
}
