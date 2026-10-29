// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The four lexicon channels: gazetteer, country, street type and locality surface.
//!
//! Each lexicon maps a lowercased run of up to `max_ngram` words to a bit set. Painting reads only the raw
//! text, so a row paints the same values under either label source. A word is a run of non-space characters
//! with its leading and trailing non-alphanumeric characters stripped, and the longest matching run at each
//! word wins.

use crate::channel::{Channel, Piece};
use crate::error::Error;
use crate::python_text::{is_alnum, is_decimal, is_space, lower};
use serde_json::Value;
use std::collections::HashMap;

/// The country channel's width: `[country_surface, country_ambiguous]`.
pub const COUNTRY_FEATURE_DIM: usize = 2;
const COUNTRY_SURFACE_BIT: u64 = 1;
const COUNTRY_AMBIGUOUS_BIT: u64 = 2;

/// A lexicon in the gazetteer JSON schema, which the street-type, locality-surface and country lexicons share.
#[derive(Debug, Clone)]
pub struct Lexicon {
	pub feature_dim: usize,
	/// Each feature slot's bit, in slot order.
	pub slot_bits: Vec<u64>,
	pub max_ngram: usize,
	pub entries: HashMap<String, u64>,
	pub code_entries: HashMap<String, u64>,
	pub digit_guard: bool,
}

fn field<'a>(doc: &'a Value, key: &str, file: &str) -> Result<&'a Value, Error> {
	doc.get(key)
		.ok_or_else(|| Error::Input(format!("{file}: missing field {key:?}")))
}

fn unsigned(value: &Value, what: &str, file: &str) -> Result<u64, Error> {
	value
		.as_u64()
		.ok_or_else(|| Error::Input(format!("{file}: {what} is not a non-negative integer: {value}")))
}

fn bit_map(doc: &Value, key: &str, file: &str) -> Result<HashMap<String, u64>, Error> {
	let object = field(doc, key, file)?
		.as_object()
		.ok_or_else(|| Error::Input(format!("{file}: {key:?} is not an object")))?;
	object
		.iter()
		.map(|(k, v)| Ok((k.clone(), unsigned(v, &format!("{key}[{k:?}]"), file)?)))
		.collect()
}

impl Lexicon {
	/// Parses a lexicon file's JSON. `file` names it in errors.
	pub fn from_json(text: &str, file: &str) -> Result<Self, Error> {
		let doc: Value = serde_json::from_str(text).map_err(|e| Error::Input(format!("{file}: {e}")))?;
		let bits = bit_map(&doc, "bits", file)?;
		let slots = field(&doc, "slots", file)?
			.as_array()
			.ok_or_else(|| Error::Input(format!("{file}: \"slots\" is not an array")))?;
		let slot_bits = slots
			.iter()
			.map(|slot| {
				let name = slot
					.as_str()
					.ok_or_else(|| Error::Input(format!("{file}: a slot is not a string: {slot}")))?;
				bits.get(name)
					.copied()
					.ok_or_else(|| Error::Input(format!("{file}: slot {name:?} has no bit")))
			})
			.collect::<Result<Vec<_>, _>>()?;
		let digit_guard = match doc.get("rules").and_then(|r| r.get("digit_guard")) {
			None | Some(Value::Null) => false,
			Some(Value::Bool(b)) => *b,
			Some(other) => {
				return Err(Error::Input(format!(
					"{file}: rules.digit_guard is not a boolean: {other}"
				)))
			}
		};
		let feature_dim = unsigned(field(&doc, "feature_dim", file)?, "feature_dim", file)? as usize;
		if feature_dim != slot_bits.len() {
			return Err(Error::Input(format!(
				"{file}: feature_dim {feature_dim} differs from the {} slots",
				slot_bits.len()
			)));
		}
		Ok(Self {
			feature_dim,
			slot_bits,
			max_ngram: unsigned(field(&doc, "max_ngram", file)?, "max_ngram", file)? as usize,
			entries: bit_map(&doc, "entries", file)?,
			code_entries: bit_map(&doc, "code_entries", file)?,
			digit_guard,
		})
	}

	fn features(&self, bits: u64) -> Vec<f64> {
		self.slot_bits
			.iter()
			.map(|&bit| if bits & bit != 0 { 1.0 } else { 0.0 })
			.collect()
	}
}

/// A word's start, end and stripped text, or an empty text for a word with no alphanumeric character.
struct Word {
	start: usize,
	end: usize,
	text: Vec<char>,
}

fn strip_word(word: &[char]) -> &[char] {
	let start = word.iter().position(|&c| is_alnum(c)).unwrap_or(word.len());
	let end = word.iter().rposition(|&c| is_alnum(c)).map_or(start, |i| i + 1);
	&word[start..end]
}

fn words(raw: &[char]) -> Vec<Word> {
	let mut out = Vec::new();
	let mut i = 0;
	while i < raw.len() {
		if is_space(raw[i]) {
			i += 1;
			continue;
		}
		let start = i;
		while i < raw.len() && !is_space(raw[i]) {
			i += 1;
		}
		let surface = &raw[start..i];
		let stripped = strip_word(surface);
		if stripped.is_empty() {
			out.push(Word {
				start,
				end: start,
				text: Vec::new(),
			});
			continue;
		}
		let head = surface.iter().take_while(|&&c| !is_alnum(c)).count();
		out.push(Word {
			start: start + head,
			end: start + head + stripped.len(),
			text: stripped.to_vec(),
		});
	}
	out
}

fn has_decimal(word: &Word) -> bool {
	word.text.iter().any(|&c| is_decimal(c))
}

fn digit_adjacent(words: &[Word], i: usize, n: usize) -> bool {
	if words[i..i + n].iter().any(has_decimal) {
		return true;
	}
	if let Some(before) = words[..i].iter().rev().find(|w| !w.text.is_empty()) {
		if has_decimal(before) {
			return true;
		}
	}
	words[i + n..]
		.iter()
		.find(|w| !w.text.is_empty())
		.is_some_and(has_decimal)
}

/// Each character's matched bits, zero where no lexicon run matched.
pub fn char_paint(raw: &[char], lexicon: &Lexicon) -> Vec<u64> {
	let mut char_bits = vec![0u64; raw.len()];
	let words = words(raw);
	let mut i = 0;
	while i < words.len() {
		if words[i].text.is_empty() {
			i += 1;
			continue;
		}
		let mut matched = None;
		for n in (1..=lexicon.max_ngram.min(words.len() - i)).rev() {
			let run = &words[i..i + n];
			if run.iter().any(|w| w.text.is_empty()) {
				continue;
			}
			let mut joined: Vec<char> = Vec::new();
			for (k, w) in run.iter().enumerate() {
				if k > 0 {
					joined.push(' ');
				}
				joined.extend_from_slice(&w.text);
			}
			let mut bits = lexicon.entries.get(&lower(&joined)).copied().unwrap_or(0);
			if n == 1 {
				let surface: String = run[0].text.iter().collect();
				bits |= lexicon.code_entries.get(&surface).copied().unwrap_or(0);
			}
			if bits != 0 {
				matched = Some((n, bits));
				break;
			}
		}
		match matched {
			Some((n, bits)) => {
				if lexicon.digit_guard && digit_adjacent(&words, i, n) {
					i += n;
					continue;
				}
				let begin = words[i].start;
				let end = words[i + n - 1].end.min(raw.len());
				for slot in &mut char_bits[begin..end] {
					*slot = bits;
				}
				i += n;
			}
			None => i += 1,
		}
	}
	char_bits
}

/// The bits of the first non-space character a piece covers, zero when it covers none.
fn piece_bits(raw: &[char], char_bits: &[u64], piece: &Piece) -> u64 {
	(piece.begin..piece.end)
		.find(|&c| c < raw.len() && !is_space(raw[c]))
		.map_or(0, |c| char_bits[c])
}

/// A lexicon channel over the pieces: a piece with matched bits carries the slot features with confidence 1.
pub fn paint(raw: &[char], pieces: &[Piece], lexicon: &Lexicon) -> Channel {
	let char_bits = char_paint(raw, lexicon);
	let mut channel = Channel::zeros(lexicon.feature_dim, pieces.len());
	for (i, piece) in pieces.iter().enumerate() {
		let bits = piece_bits(raw, &char_bits, piece);
		if bits != 0 {
			channel.set(i, &lexicon.features(bits), 1.0);
		}
	}
	channel
}

/// The country channel: `[surface, ambiguous]` from bits 1 and 2, with the surface value as confidence.
pub fn country(raw: &[char], pieces: &[Piece], lexicon: &Lexicon) -> Channel {
	let char_bits = char_paint(raw, lexicon);
	let mut channel = Channel::zeros(COUNTRY_FEATURE_DIM, pieces.len());
	for (i, piece) in pieces.iter().enumerate() {
		let bits = piece_bits(raw, &char_bits, piece);
		let surface = if bits & COUNTRY_SURFACE_BIT != 0 { 1.0 } else { 0.0 };
		let ambiguous = if bits & COUNTRY_AMBIGUOUS_BIT != 0 { 1.0 } else { 0.0 };
		channel.set(i, &[surface, ambiguous], surface);
	}
	channel
}

/// Zeroes every gazetteer piece within `window` pieces of a piece the postcode anchor painted, excluding the anchor
/// piece itself.
///
/// `anchor_confidence` is the anchor channel already fitted to the row width, which can be shorter than the
/// gazetteer channel when the row has more pieces than that width.
pub fn suppress_near_postcode(channel: &mut Channel, anchor_confidence: &[f64], window: usize) {
	let n = channel.len();
	let mut suppress = vec![false; n];
	for (i, _) in anchor_confidence.iter().take(n).enumerate().filter(|(_, &c)| c > 0.0) {
		let window_range = i.saturating_sub(window)..(i + window + 1).min(n);
		for (j, slot) in suppress
			.iter_mut()
			.enumerate()
			.take(window_range.end)
			.skip(window_range.start)
		{
			if j != i {
				*slot = true;
			}
		}
	}
	let zero = vec![0.0; channel.dim];
	for (i, &s) in suppress.iter().enumerate() {
		if s {
			channel.set(i, &zero, 0.0);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn lexicon(entries: &[(&str, u64)], digit_guard: bool) -> Lexicon {
		Lexicon {
			feature_dim: 2,
			slot_bits: vec![1, 2],
			max_ngram: 3,
			entries: entries.iter().map(|&(k, v)| (k.to_string(), v)).collect(),
			code_entries: HashMap::new(),
			digit_guard,
		}
	}

	fn chars(s: &str) -> Vec<char> {
		s.chars().collect()
	}

	#[test]
	fn a_trailing_spacing_mark_is_stripped_like_punctuation() {
		// U+0940 is Mc, which Python's isalnum rejects, so the word "की," strips to "क".
		let raw = chars("की,");
		let lex = lexicon(&[("क", 1)], false);
		assert_eq!(char_paint(&raw, &lex), vec![1, 0, 0]);
	}

	#[test]
	fn the_longest_run_wins_and_the_digit_guard_skips_it() {
		let raw = chars("New York 10001");
		let lex = lexicon(&[("new york", 2), ("york", 1)], false);
		assert_eq!(&char_paint(&raw, &lex)[..8], &[2; 8]);
		let guarded = lexicon(&[("new york", 2), ("york", 1)], true);
		assert!(char_paint(&raw, &guarded).iter().all(|&b| b == 0));
	}

	#[test]
	fn python_whitespace_splits_words() {
		let raw = chars("a\u{1C}b");
		let lex = lexicon(&[("b", 1)], false);
		assert_eq!(char_paint(&raw, &lex), vec![0, 0, 1]);
	}
}
