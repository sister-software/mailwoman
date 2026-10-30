// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Address rows written the way the Python augmentation tests wrote them: a row from its tokens and labels, a span
//! triple added beside them, and `make_row`, which locates each span in the text and derives the labels from them.

#![allow(dead_code)]

use mtf_sampler::augment::postcode_move::PostcodeLayouts;
use mtf_sampler::augment::splice::token_spans;
use mtf_sampler::pyrandom::{PyRandom, Seed};
use mtf_sampler::{Row, SpanTriple};
use std::path::PathBuf;

/// A generator seeded as `random.Random(seed)`.
pub fn rng(seed: i128) -> PyRandom {
	PyRandom::new(Seed::Int(seed))
}

fn strings(items: &[&str]) -> Vec<String> {
	items.iter().map(|s| (*s).to_owned()).collect()
}

/// A token-label row without a span triple, from country `US` and source `test`.
pub fn row(raw: &str, tokens: &[&str], labels: &[&str]) -> Row {
	Row {
		raw: raw.to_owned(),
		tokens: strings(tokens),
		labels: strings(labels),
		country: Some("US".to_owned()),
		source: "test".to_owned(),
		spans: None,
	}
}

/// `row` with the span triple set.
pub fn with_spans(row: Row, starts: &[i64], ends: &[i64], tags: &[&str]) -> Row {
	Row {
		spans: Some(SpanTriple {
			starts: starts.to_vec(),
			ends: ends.to_vec(),
			tags: strings(tags),
		}),
		..row
	}
}

/// `row` with its country and source set.
pub fn from(row: Row, country: &str, source: &str) -> Row {
	Row {
		country: Some(country.to_owned()),
		source: source.to_owned(),
		..row
	}
}

/// `raw[start:end]` over code points.
pub fn slice(raw: &str, start: i64, end: i64) -> String {
	raw.chars().skip(start as usize).take((end - start) as usize).collect()
}

/// Each span's `(tag, text)` in triple order.
pub fn span_texts(row: &Row) -> Vec<(String, String)> {
	let triple = row.spans.as_ref().expect("a span row");
	triple
		.starts
		.iter()
		.zip(&triple.ends)
		.zip(&triple.tags)
		.map(|((&s, &e), t)| (t.clone(), slice(&row.raw, s, e)))
		.collect()
}

/// `span_texts` sorted, which the postcode move compares because it reorders the triple.
pub fn sorted_span_texts(row: &Row) -> Vec<(String, String)> {
	let mut texts = span_texts(row);
	texts.sort();
	texts
}

/// `(tag, text)` pairs from string literals.
pub fn texts(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
	pairs.iter().map(|&(t, s)| (t.to_owned(), s.to_owned())).collect()
}

/// Every span is non-empty, in bounds, sorted and disjoint.
pub fn assert_span_invariants(row: &Row) {
	let triple = row.spans.as_ref().expect("a span row");
	let length = row.raw.chars().count() as i64;
	let mut previous_end = 0;
	for (&s, &e) in triple.starts.iter().zip(&triple.ends) {
		assert!(
			0 <= s && s < e && e <= length,
			"span [{s}, {e}) over {length} code points"
		);
		assert!(s >= previous_end, "span [{s}, {e}) starts before {previous_end}");
		previous_end = e;
	}
}

/// The corpus tokenizer's word runs, `[\w'\-]+`, which never include separator commas.
pub fn word_tokens(raw: &str) -> Vec<String> {
	let mut out = Vec::new();
	let mut current = String::new();
	for c in raw.chars() {
		if c.is_alphanumeric() || matches!(c, '_' | '\'' | '-') {
			current.push(c);
		} else if !current.is_empty() {
			out.push(std::mem::take(&mut current));
		}
	}
	if !current.is_empty() {
		out.push(current);
	}
	out
}

/// Each token's BIO label by span containment, as `alignRow` assigns them. A token keeps its trailing comma, so
/// containment is read on the token's word.
pub fn labels_from_spans(raw: &str, tokens: &[String], starts: &[i64], ends: &[i64], tags: &[String]) -> Vec<String> {
	let chars: Vec<char> = raw.chars().collect();
	let mut seen = std::collections::HashSet::new();
	let mut labels = Vec::new();
	for (token_start, token_end) in token_spans(&chars, tokens).expect("the tokens are in the text") {
		let word = &chars[token_start..token_end];
		let trimmed = word.len() - word.iter().rev().take_while(|c| matches!(c, ',' | ';')).count();
		let word_end = (token_start + trimmed) as i64;
		let token_start = token_start as i64;
		let mut label = "O".to_owned();
		for (index, (&start, &end)) in starts.iter().zip(ends).enumerate() {
			if start <= token_start && word_end <= end {
				label = format!("{}-{}", if seen.contains(&index) { "I" } else { "B" }, tags[index]);
				seen.insert(index);
				break;
			}
		}
		labels.push(label);
	}
	labels
}

/// A row with spans located left to right and labels assigned by span containment, from source `openaddresses`.
pub fn make_row(raw: &str, spans: &[(&str, &str)], country: &str, tokens: Option<&[&str]>) -> Row {
	let chars: Vec<char> = raw.chars().collect();
	let (mut starts, mut ends) = (Vec::new(), Vec::new());
	let mut cursor = 0usize;
	for (_, text) in spans {
		let needle: Vec<char> = text.chars().collect();
		let start = mtf_channels::labels::find(&chars, &needle, cursor).expect("the span text is in the row");
		starts.push(start as i64);
		ends.push((start + needle.len()) as i64);
		cursor = start + needle.len();
	}
	let tags: Vec<String> = spans.iter().map(|(t, _)| (*t).to_owned()).collect();
	let tokens = tokens.map_or_else(|| word_tokens(raw), strings);
	Row {
		raw: raw.to_owned(),
		labels: labels_from_spans(raw, &tokens, &starts, &ends, &tags),
		tokens,
		country: Some(country.to_owned()),
		source: "openaddresses".to_owned(),
		spans: Some(SpanTriple { starts, ends, tags }),
	}
}

/// `postcode-layouts.json`, the layout table the Python augmentation reads.
pub fn layouts_path() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/trainer/data/postcode-layouts.json")
}

/// The layout table read from `postcode-layouts.json`.
pub fn layouts() -> PostcodeLayouts {
	PostcodeLayouts::load(&layouts_path()).expect("the layout table loads")
}
