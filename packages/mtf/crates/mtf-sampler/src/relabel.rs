// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Split a street span into its directional prefix, name and suffix (#511).
//!
//! A corpus that labels `North Main Street` as one street teaches the model nothing about the affixes. The relabel
//! pass rewrites such a span, on the BIO labels and on the span triple, as `street_prefix`, `street` and
//! `street_suffix` when the affix lexicon names the first word as a directional and the last as a suffix. A span
//! already followed by a `street_suffix` is left alone.

use crate::error::{Error, Result};
use crate::row::{string, Row, SpanTriple};
use crate::text::non_space_runs;
use mtf_channels::python_text::lower;
use rustc_hash::FxHashSet;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

const STREET_SUFFIX_TAG: &str = "street_suffix";

/// The affix lexicon: directional and suffix surfaces mapped to their canonical forms, and the suffixes that may
/// also end a street name.
#[derive(Debug, Clone)]
pub struct AffixRelabelLexicon {
	pub directionals: HashMap<String, String>,
	pub suffixes: HashMap<String, String>,
	pub version: String,
	pub name_prone: FxHashSet<String>,
}

fn string_map(value: &Value) -> HashMap<String, String> {
	value
		.as_object()
		.map(|m| {
			m.iter()
				.filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
				.collect()
		})
		.unwrap_or_default()
}

impl AffixRelabelLexicon {
	pub fn load(path: &Path) -> Result<Self> {
		if !path.is_file() {
			return Err(Error::Input(format!(
				"affix relabel lexicon not found: {}",
				path.display()
			)));
		}
		let text = std::fs::read_to_string(path).map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
		let data: Value = serde_json::from_str(&text).map_err(|e| Error::Input(format!("{}: {e}", path.display())))?;
		for key in ["directionals", "suffixes", "version"] {
			if data.get(key).is_none() {
				return Err(Error::Input(format!(
					"affix relabel lexicon missing key {key:?}: {}",
					path.display()
				)));
			}
		}
		let directionals = string_map(&data["directionals"]);
		let suffixes = string_map(&data["suffixes"]);
		if directionals.is_empty() || suffixes.is_empty() {
			return Err(Error::Input(format!(
				"affix relabel lexicon has empty vocab: {}",
				path.display()
			)));
		}
		Ok(Self {
			directionals,
			suffixes,
			version: data["version"].as_str().unwrap_or_default().to_owned(),
			name_prone: data
				.get("name_prone")
				.and_then(Value::as_array)
				.map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
				.unwrap_or_default(),
		})
	}
}

fn lowered(word: &str) -> String {
	lower(&word.chars().collect::<Vec<_>>())
}

fn is_affix_shaped(words: &[&str], lex: &AffixRelabelLexicon) -> bool {
	match (words.first(), words.last()) {
		(Some(first), Some(last)) => {
			lex.suffixes.contains_key(&lowered(last)) || lex.directionals.contains_key(&lowered(first))
		}
		_ => true,
	}
}

/// `(prefix words, suffix words)` when the span's words split into a directional, a name and a suffix.
pub fn split_street_span(words: &[&str], lex: &AffixRelabelLexicon) -> Option<(usize, usize)> {
	if words.len() < 2 {
		return None;
	}
	let mut prefix = 0;
	let mut rest = words;
	if words.len() > 2 && lex.directionals.contains_key(&lowered(words[0])) {
		prefix = 1;
		rest = &words[1..];
	}
	if rest.len() < 2 || !lex.suffixes.contains_key(&lowered(rest[rest.len() - 1])) {
		return None;
	}
	let name = &rest[..rest.len() - 1];
	if is_affix_shaped(name, lex) {
		let tail = lex.suffixes.get(&lowered(name[name.len() - 1]));
		let licensed = name.len() >= 2
			&& tail.is_some_and(|t| lex.name_prone.contains(t))
			&& !lex.directionals.contains_key(&lowered(name[0]));
		if !licensed {
			return None;
		}
	}
	Some((prefix, 1))
}

fn bio_component(label: &str) -> Option<&str> {
	label.strip_prefix("B-").or_else(|| label.strip_prefix("I-"))
}

/// Relabels a row in place, on its BIO labels and its span triple. Returns whether anything changed.
pub fn relabel_row(row: &mut Row, lex: &AffixRelabelLexicon) -> Result<bool> {
	let mut changed = false;
	let n = row.labels.len();
	let mut i = 0;
	while i < n {
		if row.labels[i] != "B-street" {
			i += 1;
			continue;
		}
		let mut j = i + 1;
		while j < n && row.labels[j] == "I-street" {
			j += 1;
		}
		if j < n && bio_component(&row.labels[j]) == Some(STREET_SUFFIX_TAG) {
			i = j;
			continue;
		}
		let words: Vec<&str> = row.tokens[i.min(row.tokens.len())..j.min(row.tokens.len())]
			.iter()
			.map(String::as_str)
			.collect();
		if let Some((prefix, suffix)) = split_street_span(&words, lex) {
			if prefix > 0 {
				row.labels[i] = "B-street_prefix".into();
			}
			let name_start = i + prefix;
			row.labels[name_start] = "B-street".into();
			for k in name_start + 1..j - suffix {
				row.labels[k] = "I-street".into();
			}
			row.labels[j - suffix] = "B-street_suffix".into();
			changed = true;
		}
		i = j;
	}
	if relabel_spans(row, lex)? {
		changed = true;
	}
	Ok(changed)
}

/// Relabels the span triple. Returns whether anything changed.
pub fn relabel_spans(row: &mut Row, lex: &AffixRelabelLexicon) -> Result<bool> {
	let Some(triple) = row.span_triple()? else {
		return Ok(false);
	};
	let raw = row.chars();
	let mut out = SpanTriple {
		starts: Vec::new(),
		ends: Vec::new(),
		tags: Vec::new(),
	};
	let mut changed = false;
	let n = triple.tags.len();
	for index in 0..n {
		let (start, end, tag) = (triple.starts[index], triple.ends[index], &triple.tags[index]);
		let keep = |out: &mut SpanTriple| {
			out.starts.push(start);
			out.ends.push(end);
			out.tags.push(tag.clone());
		};
		if tag != "street" || (index + 1 < n && triple.tags[index + 1] == STREET_SUFFIX_TAG) {
			keep(&mut out);
			continue;
		}
		// `raw[start:end]` with Python's clamping of the slice bounds.
		let len = raw.len() as i64;
		let clamp = |o: i64| if o < 0 { (o + len).max(0) } else { o.min(len) } as usize;
		let (a, b) = (clamp(start), clamp(end));
		let piece: &[char] = if a < b { &raw[a..b] } else { &[] };
		let words: Vec<(String, i64, i64)> = non_space_runs(piece)
			.into_iter()
			.map(|(s, e)| (string(&piece[s..e]), start + s as i64, start + e as i64))
			.collect();
		let surfaces: Vec<&str> = words.iter().map(|(w, _, _)| w.as_str()).collect();
		let Some((prefix, suffix)) = split_street_span(&surfaces, lex) else {
			keep(&mut out);
			continue;
		};
		changed = true;
		if prefix > 0 {
			out.starts.push(words[0].1);
			out.ends.push(words[0].2);
			out.tags.push("street_prefix".into());
		}
		let name = &words[prefix..words.len() - suffix];
		out.starts.push(name[0].1);
		out.ends.push(name[name.len() - 1].2);
		out.tags.push("street".into());
		let last = &words[words.len() - 1];
		out.starts.push(last.1);
		out.ends.push(last.2);
		out.tags.push(STREET_SUFFIX_TAG.into());
	}
	if changed {
		row.spans = Some(out);
	}
	Ok(changed)
}
