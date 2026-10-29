// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! One sampled corpus row and its char-offset span triple.

use crate::error::{quote, Error, Result};
use mtf_channels::labels::Spans;

/// A row's span triple: `[start, end)` code-point ranges over `raw`, each with a tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpanTriple {
	pub starts: Vec<i64>,
	pub ends: Vec<i64>,
	pub tags: Vec<String>,
}

/// One row as the sampler yields it.
///
/// `spans` is `None` for a row from a file without the span columns, the token-label path. Every transformation
/// returns a new row, so a row the sampler has yielded never changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
	pub raw: String,
	pub tokens: Vec<String>,
	pub labels: Vec<String>,
	pub country: Option<String>,
	pub source: String,
	pub spans: Option<SpanTriple>,
}

impl Row {
	/// The span triple, refusing one whose three arrays differ in length.
	pub fn span_triple(&self) -> Result<Option<&SpanTriple>> {
		let Some(triple) = &self.spans else {
			return Ok(None);
		};
		if triple.starts.len() != triple.ends.len() || triple.starts.len() != triple.tags.len() {
			return Err(Error::Row(format!(
				"span triple arrays not parallel — starts={} ends={} tags={} (raw={})",
				triple.starts.len(),
				triple.ends.len(),
				triple.tags.len(),
				quote(&self.raw)
			)));
		}
		Ok(Some(triple))
	}

	/// The triple as the encoder reads it.
	pub fn encoder_spans(&self) -> Option<Spans<'_>> {
		self.spans.as_ref().map(|t| Spans {
			starts: &t.starts,
			ends: &t.ends,
			tags: &t.tags,
		})
	}

	/// The row's text as code points, the unit every offset counts in.
	pub fn chars(&self) -> Vec<char> {
		self.raw.chars().collect()
	}
}

/// Code points of a string.
pub(crate) fn chars(s: &str) -> Vec<char> {
	s.chars().collect()
}

/// A string from code points.
pub(crate) fn string(c: &[char]) -> String {
	c.iter().collect()
}
