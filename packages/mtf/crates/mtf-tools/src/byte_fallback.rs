// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The rate at which a tokenizer falls back to raw bytes, overall and per script: `tokenizer/byte_fallback.py`.

use crate::args::Result;
use mtf_channels::python_text::{is_script_skipped, script_block, strip};
use mtf_core::Processor;
use serde_json::{json, Value};

/// A coarse script tag for a string: one of the script blocks, `mixed`, or `other`.
///
/// Spaces, numbers, punctuation, separators and symbols are skipped. A character whose Unicode name starts with no
/// block's prefix, or that has no name, counts as `other`. A block holding at least 90% of the counted characters
/// names the string, so surrounding Latin punctuation does not force `mixed`.
pub fn detect_script(text: &str) -> &'static str {
	let mut blocks: Vec<(&'static str, usize)> = Vec::new();
	for c in text.chars() {
		if is_script_skipped(c) {
			continue;
		}
		let block = script_block(c).unwrap_or("other");
		match blocks.iter_mut().find(|(name, _)| *name == block) {
			Some((_, n)) => *n += 1,
			None => blocks.push((block, 1)),
		}
	}
	match blocks.len() {
		0 => "other",
		1 => blocks[0].0,
		_ => {
			let total: usize = blocks.iter().map(|(_, n)| n).sum();
			let mut top = blocks[0];
			for &entry in &blocks[1..] {
				if entry.1 > top.1 {
					top = entry;
				}
			}
			if top.1 as f64 / total as f64 >= 0.9 {
				top.0
			} else {
				"mixed"
			}
		}
	}
}

/// Whether a piece is a byte-fallback piece, `<0xNN>`.
fn is_byte_piece(piece: &str) -> bool {
	let bytes = piece.as_bytes();
	bytes.len() == 6
		&& piece.starts_with("<0x")
		&& bytes[5] == b'>'
		&& bytes[3].is_ascii_hexdigit()
		&& bytes[4].is_ascii_hexdigit()
}

#[derive(Default, Clone, Copy)]
struct Tally {
	lines: u64,
	pieces: u64,
	byte_fallback_pieces: u64,
}

impl Tally {
	fn json(self) -> Value {
		let rate = if self.pieces > 0 {
			self.byte_fallback_pieces as f64 / self.pieces as f64
		} else {
			0.0
		};
		json!({
			"lines": self.lines,
			"pieces": self.pieces,
			"byte_fallback_pieces": self.byte_fallback_pieces,
			"rate": rate,
		})
	}
}

/// `measure_byte_fallback`: each non-blank line, stripped, is encoded and its byte pieces counted. `per_script` is a
/// list of `[script, tally]` pairs in first-seen order, because a JSON object here would sort its keys.
pub fn measure(processor: &Processor, lines: &[String]) -> Result<Value> {
	let mut overall = Tally::default();
	let mut per_script: Vec<(&'static str, Tally)> = Vec::new();
	for line in lines {
		let chars: Vec<char> = line.chars().collect();
		let stripped: String = strip(&chars).iter().collect();
		if stripped.is_empty() {
			continue;
		}
		let script = detect_script(&stripped);
		let pieces = processor.encode(&stripped).map_err(|e| format!("{stripped:?}: {e}"))?;
		let n = pieces.len() as u64;
		let fallback = pieces.iter().filter(|p| is_byte_piece(&p.piece)).count() as u64;
		overall.lines += 1;
		overall.pieces += n;
		overall.byte_fallback_pieces += fallback;
		let bucket = match per_script.iter_mut().position(|(name, _)| *name == script) {
			Some(i) => &mut per_script[i].1,
			None => {
				per_script.push((script, Tally::default()));
				&mut per_script.last_mut().expect("just pushed").1
			}
		};
		bucket.lines += 1;
		bucket.pieces += n;
		bucket.byte_fallback_pieces += fallback;
	}
	Ok(json!({
		"overall": overall.json(),
		"per_script": per_script.into_iter().map(|(name, t)| json!([name, t.json()])).collect::<Vec<_>>(),
	}))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn pure_blocks_name_their_script() {
		for (text, script) in [
			("1600 Pennsylvania Avenue NW", "latin"),
			("東京都新宿区西新宿", "cjk"),
			("Москва, ул. Тверская", "cyrillic"),
			("Երեւան, Աբովյան", "armenian"),
			("Αθήνα", "greek"),
			("القاهرة", "arabic"),
			("ירושלים", "hebrew"),
			("नई दिल्ली", "devanagari"),
			("กรุงเทพมหานคร", "thai"),
		] {
			assert_eq!(detect_script(text), script, "{text}");
		}
	}

	#[test]
	fn a_majority_block_names_a_mixed_string() {
		assert_eq!(detect_script("〒100-0005 東京都千代田区丸の内"), "cjk");
		assert_eq!(detect_script("Tokyo 東京 City"), "mixed");
	}

	#[test]
	fn an_unlisted_block_is_other() {
		assert_eq!(detect_script("თბილისი"), "other");
		assert_eq!(detect_script("12 - 34"), "other");
	}

	#[test]
	fn only_the_byte_form_is_a_byte_piece() {
		assert!(is_byte_piece("<0xE6>"));
		assert!(is_byte_piece("<0x0a>"));
		assert!(!is_byte_piece("<0xG0>"));
		assert!(!is_byte_piece("▁<0xE6>"));
	}
}
