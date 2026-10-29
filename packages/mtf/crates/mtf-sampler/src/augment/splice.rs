// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Edit a row's text and re-target its tokens, labels and spans.
//!
//! Every edit returns a new row. A span whose boundary falls inside an edited token cannot be re-targeted and is an
//! error naming the row.

use crate::error::{quote, Error, Result};
use crate::row::{chars, string, Row, SpanTriple};
use crate::text;
use mtf_channels::python_text;

/// The `(begin, end)` code-point span of each whitespace token, each found at or after the previous token's end.
pub fn token_spans(raw: &[char], tokens: &[String]) -> Result<Vec<(usize, usize)>> {
	let tokens: Vec<Vec<char>> = tokens.iter().map(|t| chars(t)).collect();
	mtf_channels::labels::whitespace_spans(raw, &tokens).map_err(Error::from)
}

/// The row with the token at `idx` replaced by `expansion`, which may be several words.
pub fn splice_expansion(row: &Row, idx: usize, expansion: &str) -> Result<Row> {
	let raw = row.chars();
	let spans = token_spans(&raw, &row.tokens)?;
	let (s, e) = spans[idx];
	let expansion_chars = chars(expansion);
	let delta = expansion_chars.len() as i64 - (e - s) as i64;
	let (tokens, labels) = expand_token(&row.tokens, &row.labels, idx, expansion);
	let mut out = Row {
		raw: string(&raw[..s]) + expansion + &string(&raw[e..]),
		tokens,
		labels,
		..row.clone()
	};
	if let Some(triple) = row.span_triple()? {
		let (s, e) = (s as i64, e as i64);
		let mut starts = Vec::with_capacity(triple.starts.len());
		let mut ends = Vec::with_capacity(triple.ends.len());
		for (&start, &end) in triple.starts.iter().zip(&triple.ends) {
			if end <= s {
				starts.push(start);
				ends.push(end);
			} else if start >= e {
				starts.push(start + delta);
				ends.push(end + delta);
			} else if start <= s && end >= e {
				starts.push(start);
				ends.push(end + delta);
			} else {
				return Err(Error::Row(format!(
					"span [{start}, {end}) has a boundary inside the expanded token {:?} at [{s}, {e}) — \
					 un-retargetable (raw={})",
					row.tokens[idx],
					quote(&row.raw)
				)));
			}
		}
		out.spans = Some(SpanTriple {
			starts,
			ends,
			tags: triple.tags.clone(),
		});
	}
	Ok(out)
}

/// The tokens and labels with the token at `idx` replaced by the words of `expansion`. A `B-` label is followed by
/// `I-` labels of its tag, an `I-` label repeats, and `O` stays `O`.
pub fn expand_token(tokens: &[String], labels: &[String], idx: usize, expansion: &str) -> (Vec<String>, Vec<String>) {
	let words = text::split_whitespace(expansion);
	if words.len() == 1 {
		let mut out = tokens.to_vec();
		out[idx] = words[0].clone();
		return (out, labels.to_vec());
	}
	let original = &labels[idx];
	let expanded: Vec<String> = if let Some(tag) = original.strip_prefix("B-") {
		std::iter::once(original.clone())
			.chain(std::iter::repeat_n(format!("I-{tag}"), words.len() - 1))
			.collect()
	} else if original.starts_with("I-") {
		vec![original.clone(); words.len()]
	} else {
		vec!["O".to_owned(); words.len()]
	};
	let new_tokens = [&tokens[..idx], &words[..], &tokens[idx + 1..]].concat();
	let new_labels = [&labels[..idx], &expanded[..], &labels[idx + 1..]].concat();
	(new_tokens, new_labels)
}

/// The row with the whitespace between the region token at `idx` and the postcode token after it removed from `raw`.
/// The tokens and labels stay split, because the tokens are located by substring search.
pub fn glue_region_postcode(row: &Row, idx: usize) -> Result<Row> {
	let raw = row.chars();
	let spans = token_spans(&raw, &row.tokens)?;
	let region_end = spans[idx].1;
	let postcode_begin = spans[idx + 1].0;
	let gap = (postcode_begin - region_end) as i64;
	let mut out = Row {
		raw: string(&raw[..region_end]) + &string(&raw[postcode_begin..]),
		..row.clone()
	};
	if let Some(triple) = row.span_triple()? {
		let (region_end, postcode_begin) = (region_end as i64, postcode_begin as i64);
		let mut starts = Vec::with_capacity(triple.starts.len());
		let mut ends = Vec::with_capacity(triple.ends.len());
		for (&start, &end) in triple.starts.iter().zip(&triple.ends) {
			if start < postcode_begin && postcode_begin < end {
				return Err(Error::Row(format!(
					"span [{start}, {end}) straddles the glue gap [{region_end}, {postcode_begin}) (raw={})",
					quote(&row.raw)
				)));
			}
			starts.push(if start >= postcode_begin { start - gap } else { start });
			ends.push(if end > region_end { end - gap } else { end });
		}
		out.spans = Some(SpanTriple {
			starts,
			ends,
			tags: triple.tags.clone(),
		});
	}
	Ok(out)
}

/// A lowercased copy, or `None` when lowercasing a character would change the row's length.
pub fn lowercase_row(row: &Row) -> Result<Option<Row>> {
	let raw = row.chars();
	if raw.iter().any(|&c| python_text::lower(&[c]).chars().count() != 1) {
		return Ok(None);
	}
	Ok(Some(Row {
		raw: python_text::lower(&raw),
		tokens: row.tokens.iter().map(|t| python_text::lower(&chars(t))).collect(),
		..row.clone()
	}))
}

/// The separator characters the punctuation drop removes.
pub const DROP_PUNCT: [char; 3] = [',', '"', '\''];

/// A copy with every separator comma and quote outside a span removed, or `None` when the row has no span triple or
/// no such character.
pub fn drop_separator_punct(row: &Row) -> Result<Option<Row>> {
	let Some(triple) = row.span_triple()? else {
		return Ok(None);
	};
	let raw = row.chars();
	let n = raw.len() as i64;
	let mut covered = vec![false; raw.len()];
	for (&s, &e) in triple.starts.iter().zip(&triple.ends) {
		for p in s.max(0)..e.min(n) {
			covered[p as usize] = true;
		}
	}
	let drop: Vec<usize> = (0..raw.len())
		.filter(|&p| DROP_PUNCT.contains(&raw[p]) && !covered[p])
		.collect();
	if drop.is_empty() {
		return Ok(None);
	}
	let dropped = |p: usize| drop.binary_search(&p).is_ok();
	// The offset less the number of dropped positions before it.
	let shifted = |offset: i64| offset - drop.partition_point(|&p| (p as i64) < offset) as i64;
	let new_raw: String = (0..raw.len()).filter(|&p| !dropped(p)).map(|p| raw[p]).collect();
	let spans = token_spans(&raw, &row.tokens)?;
	if spans.len() != row.labels.len() {
		return Err(Error::Row(format!(
			"tokens/labels length mismatch: {} vs {} (raw={})",
			spans.len(),
			row.labels.len(),
			quote(&row.raw)
		)));
	}
	let mut tokens = Vec::new();
	let mut labels = Vec::new();
	for (&(ts, te), label) in spans.iter().zip(&row.labels) {
		let rebuilt: String = (ts..te).filter(|&j| !dropped(j)).map(|j| raw[j]).collect();
		if !rebuilt.is_empty() {
			tokens.push(rebuilt);
			labels.push(label.clone());
		}
	}
	Ok(Some(Row {
		raw: new_raw,
		tokens,
		labels,
		spans: Some(SpanTriple {
			starts: triple.starts.iter().map(|&s| shifted(s)).collect(),
			ends: triple.ends.iter().map(|&e| shifted(e)).collect(),
			tags: triple.tags.clone(),
		}),
		..row.clone()
	}))
}

/// An upper-cased copy, or `None` when upper-casing a character would change the row's length or the row is already
/// upper case.
pub fn upper_case_row(row: &Row) -> Result<Option<Row>> {
	let raw = row.chars();
	if raw.iter().any(|&c| python_text::upper(&[c]).chars().count() != 1) {
		return Ok(None);
	}
	let upper = python_text::upper(&raw);
	if upper == row.raw {
		return Ok(None);
	}
	Ok(Some(Row {
		raw: upper,
		tokens: row.tokens.iter().map(|t| python_text::upper(&chars(t))).collect(),
		..row.clone()
	}))
}
