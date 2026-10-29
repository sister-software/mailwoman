// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Project a row's labels onto its pieces.
//!
//! Both label sources build one label per character, and both reach `project`, so a span-era row and a
//! token-era row cannot differ in how a label lands on a piece. A piece takes the label of the first
//! non-space character it covers. Only the first piece of a run of one tag gets that tag's `B-` id; each
//! following piece of the same tag gets its `I-` id.

use crate::channel::Piece;
use crate::error::{quote, Error};
use crate::python_text::is_space;
use std::collections::HashMap;

/// The label vocabulary: the id of `O` and of each active tag's `B-` and `I-` labels.
#[derive(Debug, Clone)]
pub struct LabelTable {
	outside: i64,
	/// `(B id, I id)` per active tag, indexed by the tag's position in `tags`.
	ids: Vec<(i64, i64)>,
	tags: HashMap<String, u16>,
	pub ignore_index: i64,
}

/// One character's label after collapsing to the active tag set: the tag's index, or `None` for `O`.
pub type CharLabel = Option<u16>;

impl LabelTable {
	/// Builds the table from the label-to-id map and the active tags; every active tag needs both its labels.
	pub fn new(label_to_id: &HashMap<String, i64>, active_tags: &[String], ignore_index: i64) -> Result<Self, Error> {
		let id = |label: &str| {
			label_to_id
				.get(label)
				.copied()
				.ok_or_else(|| Error::Input(format!("label_to_id has no id for {label:?}")))
		};
		let mut ids = Vec::with_capacity(active_tags.len());
		let mut tags = HashMap::with_capacity(active_tags.len());
		for (index, tag) in active_tags.iter().enumerate() {
			ids.push((id(&format!("B-{tag}"))?, id(&format!("I-{tag}"))?));
			tags.insert(tag.clone(), index as u16);
		}
		Ok(Self {
			outside: id("O")?,
			ids,
			tags,
			ignore_index,
		})
	}

	/// The collapsed label of a BIO string: its tag when the prefix is `B` or `I` and the tag is active.
	pub fn collapse(&self, bio: &str) -> CharLabel {
		if bio == "O" {
			return None;
		}
		let (prefix, tag) = bio.split_once('-')?;
		if prefix != "B" && prefix != "I" {
			return None;
		}
		self.tags.get(tag).copied()
	}

	/// The collapsed label a span tag gives its characters, which is the collapse of `B-<tag>`.
	pub fn span_tag(&self, tag: &str) -> CharLabel {
		self.tags.get(tag).copied()
	}

	/// Each piece's label id.
	pub fn project(&self, raw: &[char], char_labels: &[CharLabel], pieces: &[Piece]) -> Vec<i64> {
		let mut out = Vec::with_capacity(pieces.len());
		let mut previous: CharLabel = None;
		for piece in pieces {
			let first = (piece.begin..piece.end)
				.find(|&i| i < raw.len() && !is_space(raw[i]))
				.and_then(|i| char_labels.get(i).copied().flatten());
			match first {
				None => {
					out.push(self.outside);
					previous = None;
				}
				Some(tag) => {
					let (b, i) = self.ids[tag as usize];
					out.push(if previous == Some(tag) { i } else { b });
					previous = Some(tag);
				}
			}
		}
		out
	}
}

/// The `(begin, end)` of each whitespace token in `raw`, each found at or after the previous token's end.
pub fn whitespace_spans(raw: &[char], tokens: &[Vec<char>]) -> Result<Vec<(usize, usize)>, Error> {
	let mut spans = Vec::with_capacity(tokens.len());
	let mut cursor = 0usize;
	for token in tokens {
		let found = find(raw, token, cursor).ok_or_else(|| {
			Error::Row(format!(
				"token {:?} not found in raw starting from offset {cursor}: {}",
				token.iter().collect::<String>(),
				quote(raw)
			))
		})?;
		let end = found + token.len();
		spans.push((found, end));
		cursor = end;
	}
	Ok(spans)
}

/// `str.find(needle, start)` over code points.
pub fn find(haystack: &[char], needle: &[char], start: usize) -> Option<usize> {
	if start > haystack.len() {
		return None;
	}
	if needle.is_empty() {
		return Some(start);
	}
	haystack[start..]
		.windows(needle.len())
		.position(|window| window == needle)
		.map(|i| i + start)
}

/// The per-character labels of a token-era row: each character of a token takes the token's label.
pub fn char_labels_from_tokens(
	raw: &[char],
	tokens: &[Vec<char>],
	labels: &[String],
	table: &LabelTable,
) -> Result<Vec<CharLabel>, Error> {
	if tokens.len() != labels.len() {
		return Err(Error::Row(format!(
			"tokens/labels length mismatch: {} vs {} in {}",
			tokens.len(),
			labels.len(),
			quote(raw)
		)));
	}
	let mut out = vec![None; raw.len()];
	for ((begin, end), label) in whitespace_spans(raw, tokens)?.into_iter().zip(labels) {
		let collapsed = table.collapse(label);
		for slot in &mut out[begin..end] {
			*slot = collapsed;
		}
	}
	Ok(out)
}

/// A row's span triple: sorted, non-overlapping `[start, end)` character ranges with a tag each.
pub struct Spans<'a> {
	pub starts: &'a [i64],
	pub ends: &'a [i64],
	pub tags: &'a [String],
}

impl Spans<'_> {
	/// Validates the triple against `raw` and returns its ranges, raising on any violation the corpus forbids.
	pub fn validated(&self, raw: &[char]) -> Result<Vec<(usize, usize)>, Error> {
		let n = self.starts.len();
		if self.ends.len() != n || self.tags.len() != n {
			return Err(Error::Row(format!(
				"span arrays length mismatch: starts={n} ends={} tags={} in {}",
				self.ends.len(),
				self.tags.len(),
				quote(raw)
			)));
		}
		let mut out = Vec::with_capacity(n);
		let (mut previous_start, mut previous_end) = (-1i64, 0i64);
		for ((&start, &end), tag) in self.starts.iter().zip(self.ends).zip(self.tags) {
			if !(0 <= start && start < end && end <= raw.len() as i64) {
				return Err(Error::Row(format!(
					"span out of bounds: {tag}@[{start}, {end}) over raw of length {}: {}",
					raw.len(),
					quote(raw)
				)));
			}
			if start < previous_start {
				return Err(Error::Row(format!(
					"spans not sorted: {tag}@[{start}, {end}) after [{previous_start}, {previous_end}) in {}",
					quote(raw)
				)));
			}
			if start < previous_end {
				return Err(Error::Row(format!(
					"spans overlap: {tag}@[{start}, {end}) overlaps [{previous_start}, {previous_end}) in {}",
					quote(raw)
				)));
			}
			out.push((start as usize, end as usize));
			previous_start = start;
			previous_end = end;
		}
		Ok(out)
	}

	/// The per-character labels of a span-era row, from already validated ranges.
	pub fn char_labels(&self, raw: &[char], ranges: &[(usize, usize)], table: &LabelTable) -> Vec<CharLabel> {
		let mut out = vec![None; raw.len()];
		for (&(start, end), tag) in ranges.iter().zip(self.tags) {
			let collapsed = table.span_tag(tag);
			for slot in &mut out[start..end] {
				*slot = collapsed;
			}
		}
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn table() -> LabelTable {
		let labels: HashMap<String, i64> = [
			("O", 0),
			("B-street", 1),
			("I-street", 2),
			("B-postcode", 3),
			("I-postcode", 4),
		]
		.into_iter()
		.map(|(k, v)| (k.to_string(), v))
		.collect();
		LabelTable::new(&labels, &["street".into(), "postcode".into()], -100).unwrap()
	}

	#[test]
	fn collapse_keeps_only_active_bio_labels() {
		let t = table();
		assert_eq!(t.collapse("B-street"), Some(0));
		assert_eq!(t.collapse("I-postcode"), Some(1));
		assert_eq!(t.collapse("O"), None);
		assert_eq!(t.collapse("B-venue"), None);
		assert_eq!(t.collapse("X-street"), None);
		assert_eq!(t.collapse("street"), None);
	}

	#[test]
	fn an_astral_span_end_past_the_code_point_length_raises_naming_the_row() {
		let raw: Vec<char> = "𦑃 1".chars().collect();
		let tags = vec!["street".to_string()];
		let spans = Spans {
			starts: &[0],
			ends: &[4],
			tags: &tags,
		};
		let err = spans.validated(&raw).unwrap_err().to_string();
		assert!(err.contains("out of bounds") && err.contains("𦑃 1"), "{err}");
	}

	#[test]
	fn unsorted_and_overlapping_spans_raise() {
		let raw: Vec<char> = "ab cd ef".chars().collect();
		let tags = vec!["street".to_string(), "street".to_string()];
		let unsorted = Spans {
			starts: &[3, 0],
			ends: &[5, 2],
			tags: &tags,
		};
		assert!(unsorted.validated(&raw).unwrap_err().to_string().contains("not sorted"));
		let overlapping = Spans {
			starts: &[0, 1],
			ends: &[3, 5],
			tags: &tags,
		};
		assert!(overlapping.validated(&raw).unwrap_err().to_string().contains("overlap"));
		let mismatched = Spans {
			starts: &[0],
			ends: &[3, 5],
			tags: &tags,
		};
		assert!(mismatched
			.validated(&raw)
			.unwrap_err()
			.to_string()
			.contains("length mismatch"));
	}

	#[test]
	fn a_missing_token_raises() {
		let raw: Vec<char> = "abc".chars().collect();
		let err = whitespace_spans(&raw, &["x".chars().collect()])
			.unwrap_err()
			.to_string();
		assert!(err.contains("not found"), "{err}");
	}
}
