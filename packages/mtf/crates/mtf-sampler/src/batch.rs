// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Sampled rows encoded into the arrays a training step reads, through `mtf-channels`.

use crate::error::{Error, Result};
use crate::row::Row;
use mtf_channels::{EncodedBatch, Encoder, Piece, RowInput};
use mtf_core::Processor;

/// The code-point index of the character owning each UTF-8 byte of `text`, plus the end.
fn byte_to_char(text: &str) -> Vec<usize> {
	let mut out = vec![0usize; text.len() + 1];
	let mut chars = 0;
	for (b, ch) in text.char_indices() {
		for slot in &mut out[b..b + ch.len_utf8()] {
			*slot = chars;
		}
		chars += 1;
	}
	out[text.len()] = chars;
	out
}

/// One piece as `(id, piece, char_begin, char_end)`, with code-point offsets.
pub type PieceTuple = (u32, String, usize, usize);

/// The tokenizer's pieces of `raw` with code-point offsets. A `▁` piece's range includes the space before its word.
pub fn encode_pieces(processor: &Processor, raw: &str) -> std::result::Result<Vec<PieceTuple>, mtf_channels::Error> {
	let map = byte_to_char(raw);
	let chars = map[raw.len()];
	let pieces = processor
		.encode(raw)
		.map_err(|e| mtf_channels::Error::Row(format!("tokenizer failed on {raw:?}: {e}")))?;
	Ok(pieces
		.into_iter()
		.map(|p| {
			let begin = map[p.begin.min(raw.len())];
			let end = if p.end <= raw.len() { map[p.end] } else { chars };
			(p.id, p.piece, begin, end)
		})
		.collect())
}

/// The encoder's view of each row.
pub fn row_inputs(rows: &[Row]) -> Vec<RowInput<'_>> {
	rows.iter()
		.map(|r| RowInput {
			raw: &r.raw,
			tokens: &r.tokens,
			labels: &r.labels,
			spans: r.encoder_spans(),
		})
		.collect()
}

/// A batch of sampled rows encoded with `encoder`, tokenized by `processor`.
pub fn encode_rows(encoder: &Encoder, processor: &Processor, rows: &[Row]) -> Result<EncodedBatch> {
	encoder
		.encode_rows(&row_inputs(rows), |_, raw| {
			Ok(encode_pieces(processor, raw)?
				.into_iter()
				.map(|(id, _, begin, end)| Piece { id, begin, end })
				.collect())
		})
		.map_err(|e| match e {
			mtf_channels::Error::Input(m) => Error::Input(m),
			other => Error::Row(other.to_string()),
		})
}
