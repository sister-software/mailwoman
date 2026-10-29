// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Move a row's postcode to the far side of its locality-and-region block (#2750).
//!
//! `Calle Mayor 12, 28013 Madrid` becomes `Calle Mayor 12, Madrid 28013`. The side the postcode starts on must be
//! the side libaddressinput's `fmt` states for the country, read from `postcode-layouts.json`, so the augmentation
//! never writes a native-order duplicate. The separator between the block and the postcode belongs to the boundary
//! between them and stays there. A whitespace token holding the separator (`Madrid,`) is split at the boundary and
//! keeps only its word, so each token moves with the unit it sits in. A row that cannot be moved without a guess is
//! skipped under a named reason, which the caller counts.

use super::splice::token_spans;
use crate::error::{Error, Result};
use crate::row::{chars, string, Row, SpanTriple};
use mtf_channels::python_text::{is_space, upper};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Why a row was not moved. Each value is a counter key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SkipReason {
	/// The row stores no char-offset span triple.
	NoSpans,
	/// The row has no street span, so it is not an address line with an admin tail.
	NoStreet,
	/// The row has no postcode span.
	NoPostcode,
	/// libaddressinput states no layout printing a postcode for the row's country.
	NoLayout,
	/// The country's layout prints a postcode and no locality.
	NoLocalityField,
	/// The country's layout prints the postcode inside the locality-and-region block.
	LayoutBetween,
	/// The locality and region spans do not form one block with the postcode beside it, joined by a separator.
	NotBlock,
	/// The postcode already sits on the side the country's layout does not use.
	NonNative,
	/// A token holds text on both sides of a unit boundary, so it cannot move with either side.
	WordAcrossBoundary,
	/// The input's spans overlap or nest.
	SpansOverlap,
	/// The moved block or the postcode starts or ends on whitespace.
	SpanEdgeWhitespace,
	/// The moved row's spans are out of bounds, unsorted or overlapping.
	InvalidOutput,
}

impl SkipReason {
	pub fn as_str(self) -> &'static str {
		match self {
			SkipReason::NoSpans => "no_spans",
			SkipReason::NoStreet => "no_street",
			SkipReason::NoPostcode => "no_postcode",
			SkipReason::NoLayout => "no_layout",
			SkipReason::NoLocalityField => "no_locality_field",
			SkipReason::LayoutBetween => "layout_between",
			SkipReason::NotBlock => "not_block",
			SkipReason::NonNative => "non_native",
			SkipReason::WordAcrossBoundary => "word_across_boundary",
			SkipReason::SpansOverlap => "spans_overlap",
			SkipReason::SpanEdgeWhitespace => "span_edge_whitespace",
			SkipReason::InvalidOutput => "invalid_output",
		}
	}
}

/// Each country's postcode side relative to its locality-and-region block: `before`, `after`, `between`, or `None`
/// for a layout without a locality.
#[derive(Debug, Clone, Default)]
pub struct PostcodeLayouts(HashMap<String, Option<String>>);

impl PostcodeLayouts {
	pub fn load(path: &Path) -> Result<Self> {
		let text = std::fs::read_to_string(path).map_err(|e| Error::Input(format!("{}: {e}", path.display())))?;
		Self::from_json(&text, path)
	}

	pub fn from_json(text: &str, path: &Path) -> Result<Self> {
		let doc: Value = serde_json::from_str(text).map_err(|e| Error::Input(format!("{}: {e}", path.display())))?;
		let countries = doc
			.get("countries")
			.and_then(Value::as_object)
			.ok_or_else(|| Error::Input(format!("{} has no countries object", path.display())))?;
		Ok(Self(
			countries
				.iter()
				.map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
				.collect(),
		))
	}

	pub fn from_pairs(pairs: &[(&str, Option<&str>)]) -> Self {
		Self(
			pairs
				.iter()
				.map(|&(k, v)| (k.to_owned(), v.map(str::to_owned)))
				.collect(),
		)
	}
}

/// The tags the postcode moves across.
const ADMIN_BLOCK_TAGS: [&str; 2] = ["locality", "region"];

fn is_admin(tag: &str) -> bool {
	ADMIN_BLOCK_TAGS.contains(&tag)
}

/// `[\s,;/.\-–—]+` as a full match.
fn is_separator(text: &[char]) -> bool {
	!text.is_empty()
		&& text
			.iter()
			.all(|&c| is_space(c) || matches!(c, ',' | ';' | '/' | '.' | '-' | '–' | '—'))
}

/// Whether the spans, in order, are non-empty, in bounds, sorted and disjoint.
fn spans_ordered(length: i64, spans: impl IntoIterator<Item = (i64, i64)>) -> bool {
	let mut previous_end = 0;
	for (start, end) in spans {
		if !(previous_end <= start && start < end && end <= length) {
			return false;
		}
		previous_end = end;
	}
	true
}

/// The span indices of consecutive admin-block spans walking `positions` from the postcode outward.
fn admin_run(order: &[usize], tags: &[String], positions: impl Iterator<Item = usize>) -> Vec<usize> {
	let mut run = Vec::new();
	for position in positions {
		let index = order[position];
		if !is_admin(&tags[index]) {
			break;
		}
		run.push(index);
	}
	run
}

/// The moved row, or the reason the row was skipped.
pub fn move_postcode(row: &Row, layouts: &PostcodeLayouts) -> Result<std::result::Result<Row, SkipReason>> {
	let Some(triple) = row.span_triple()? else {
		return Ok(Err(SkipReason::NoSpans));
	};
	let (starts, ends, tags) = (&triple.starts, &triple.ends, &triple.tags);
	if !tags.iter().any(|t| t == "street") {
		return Ok(Err(SkipReason::NoStreet));
	}
	if !tags.iter().any(|t| t == "postcode") {
		return Ok(Err(SkipReason::NoPostcode));
	}
	let country = upper(&chars(row.country.as_deref().unwrap_or("")));
	let Some(native) = layouts.0.get(&country) else {
		return Ok(Err(SkipReason::NoLayout));
	};
	let Some(native) = native.as_deref() else {
		return Ok(Err(SkipReason::NoLocalityField));
	};
	if native == "between" {
		return Ok(Err(SkipReason::LayoutBetween));
	}
	if tags.iter().filter(|t| *t == "postcode").count() != 1 {
		return Ok(Err(SkipReason::NotBlock));
	}
	let raw = row.chars();
	let length = raw.len() as i64;
	let mut order: Vec<usize> = (0..starts.len()).collect();
	order.sort_by_key(|&i| starts[i]);
	if !spans_ordered(length, order.iter().map(|&i| (starts[i], ends[i]))) {
		return Ok(Err(SkipReason::SpansOverlap));
	}
	let postcode_index = tags.iter().position(|t| t == "postcode").expect("counted above");
	let position = order.iter().position(|&i| i == postcode_index).expect("a permutation");
	let before = admin_run(&order, tags, (0..position).rev());
	let after = admin_run(&order, tags, position + 1..order.len());
	let admin_total = tags.iter().filter(|t| is_admin(t)).count();
	let run = if before.is_empty() { &after } else { &before };
	if (!before.is_empty() && !after.is_empty())
		|| run.len() != admin_total
		|| !run.iter().any(|&i| tags[i] == "locality")
	{
		return Ok(Err(SkipReason::NotBlock));
	}
	let side = if before.is_empty() { "before" } else { "after" };
	if side != native {
		return Ok(Err(SkipReason::NonNative));
	}

	let block = (
		run.iter().map(|&i| starts[i]).min().expect("a non-empty run"),
		run.iter().map(|&i| ends[i]).max().expect("a non-empty run"),
	);
	let pc = (starts[postcode_index], ends[postcode_index]);
	let ((s1, e1), (s2, e2)) = if side == "after" { (block, pc) } else { (pc, block) };
	if [s1, e1 - 1, s2, e2 - 1].iter().any(|&o| is_space(raw[o as usize])) {
		return Ok(Err(SkipReason::SpanEdgeWhitespace));
	}
	let gap: &[char] = if e1 <= s2 { &raw[e1 as usize..s2 as usize] } else { &[] };
	if !is_separator(gap) {
		return Ok(Err(SkipReason::NotBlock));
	}
	let moved: Vec<usize> = run.iter().copied().chain([postcode_index]).collect();
	if (0..starts.len()).any(|i| !moved.contains(&i) && starts[i] < e2 && ends[i] > s1) {
		return Ok(Err(SkipReason::NotBlock));
	}

	// Where an offset lands once the units at [s1, e1) and [s2, e2) swap around the separator. A start is inside a
	// unit on [s, e) and an end on (s, e], so a span ending where a unit starts stays put.
	let shifted = |offset: i64, end: bool| -> i64 {
		let inside_first = if end {
			s1 < offset && offset <= e1
		} else {
			s1 <= offset && offset < e1
		};
		let inside_second = if end {
			s2 < offset && offset <= e2
		} else {
			s2 <= offset && offset < e2
		};
		if inside_first {
			offset + (e2 - e1)
		} else if inside_second {
			offset - (s2 - s1)
		} else if e1 <= offset && offset <= s2 {
			offset + (e2 - s2) - (e1 - s1)
		} else {
			offset
		}
	};
	let slice = |a: i64, b: i64| -> &[char] {
		if a < b {
			&raw[a as usize..b as usize]
		} else {
			&[]
		}
	};
	let mut new_raw: Vec<char> = Vec::with_capacity(raw.len());
	new_raw.extend_from_slice(slice(0, s1));
	new_raw.extend_from_slice(slice(s2, e2));
	new_raw.extend_from_slice(slice(e1, s2));
	new_raw.extend_from_slice(slice(s1, e1));
	new_raw.extend_from_slice(slice(e2, length));

	let token_ranges = token_spans(&raw, &row.tokens)?;
	if token_ranges.len() != row.labels.len() {
		return Err(Error::Row(format!(
			"tokens/labels length mismatch: {} vs {} in {:?}",
			token_ranges.len(),
			row.labels.len(),
			row.raw
		)));
	}
	let mut placed: Vec<(i64, String, String)> = Vec::with_capacity(token_ranges.len());
	for (&(start, end), label) in token_ranges.iter().zip(&row.labels) {
		let (start, end) = (start as i64, end as i64);
		let mut edges = vec![start, end];
		edges.extend([s1, e1, s2, e2].into_iter().filter(|&b| start < b && b < end));
		edges.sort_unstable();
		edges.dedup();
		let mut pieces: Vec<(i64, i64)> = edges
			.windows(2)
			.map(|w| (w[0], w[1]))
			.filter(|&(a, b)| !is_separator(slice(a, b)))
			.collect();
		if pieces.is_empty() && edges.len() == 2 {
			// A token of separator alone (the `-` in `São Paulo - SP`) inside one unit moves with that unit.
			pieces = vec![(start, end)];
		}
		if pieces.len() != 1 {
			return Ok(Err(SkipReason::WordAcrossBoundary));
		}
		let (piece_start, piece_end) = pieces[0];
		placed.push((
			shifted(piece_start, false),
			string(slice(piece_start, piece_end)),
			label.clone(),
		));
	}
	placed.sort_by_key(|item| item.0);
	let new_tokens: Vec<String> = placed.iter().map(|(_, t, _)| t.clone()).collect();
	let found = token_spans(&new_raw, &new_tokens)?;
	if found
		.iter()
		.map(|&(s, _)| s as i64)
		.ne(placed.iter().map(|&(s, _, _)| s))
	{
		return Ok(Err(SkipReason::WordAcrossBoundary));
	}

	let mut spans: Vec<(i64, i64, String)> = starts
		.iter()
		.zip(ends)
		.zip(tags)
		.map(|((&s, &e), t)| (shifted(s, false), shifted(e, true), t.clone()))
		.collect();
	spans.sort();
	if !spans_ordered(new_raw.len() as i64, spans.iter().map(|(s, e, _)| (*s, *e))) {
		return Ok(Err(SkipReason::InvalidOutput));
	}
	Ok(Ok(Row {
		raw: string(&new_raw),
		tokens: new_tokens,
		labels: placed.into_iter().map(|(_, _, l)| l).collect(),
		spans: Some(SpanTriple {
			starts: spans.iter().map(|(s, _, _)| *s).collect(),
			ends: spans.iter().map(|(_, e, _)| *e).collect(),
			tags: spans.into_iter().map(|(_, _, t)| t).collect(),
		}),
		..row.clone()
	}))
}
