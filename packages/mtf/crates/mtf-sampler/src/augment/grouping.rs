// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Copy a row with grouping characters added around it or around one of its parts (#2845).
//!
//! The copy wraps the whole row in a pair, wraps the venue or building name in quotes or brackets, sets a trailing
//! country in parentheses, or appends a parenthesized note. A grouping character carries no component. It joins
//! the token beside it, as a separator comma does, and every span after it shifts by its length, so each span still
//! covers exactly its component's text.

use super::splice::token_spans;
use crate::error::{quote, Error, Result};
use crate::pyrandom::PyRandom;
use crate::row::{chars, string, Row, SpanTriple};
use crate::text;
use mtf_channels::python_text::{is_cjk_named, is_space};

/// Pairs that wrap a whole row or a trailing country in Latin-script text.
pub const LATIN_PAIRS: [(&str, &str); 5] = [("\"", "\""), ("[", "]"), ("(", ")"), ("«", "»"), ("{", "}")];

/// Pairs that wrap a name in Latin-script text.
pub const LATIN_NAME_PAIRS: [(&str, &str); 4] = [("\"", "\""), ("«", "»"), ("“", "”"), ("(", ")")];

/// Pairs used in Han, Kana and Hangul text, where the full-width forms are the ones written.
pub const CJK_PAIRS: [(&str, &str); 4] = [("「", "」"), ("（", "）"), ("『", "』"), ("【", "】")];

/// Notes appended in parentheses. Each is a remark rather than an address component, so every token is `O`.
pub const NOTES: [&str; 5] = [
	"rear entrance",
	"by appointment",
	"main office",
	"head office",
	"temporary address",
];

/// The component tags a name pair may wrap.
pub const NAME_TAGS: [&str; 2] = ["venue", "building_name"];

fn is_cjk(raw: &str) -> bool {
	raw.chars().any(is_cjk_named)
}

/// `text` inserted with no whitespace into `raw` at `position`, attached to the token it touches.
fn insert(row: &Row, position: usize, text: &str) -> Result<Row> {
	let raw = row.chars();
	let spans = token_spans(&raw, &row.tokens)?;
	let mut tokens = row.tokens.clone();
	let attached = spans.iter().enumerate().find_map(|(index, &(start, end))| {
		if start == position {
			Some((index, true))
		} else if end == position {
			Some((index, false))
		} else {
			None
		}
	});
	match attached {
		Some((index, true)) => tokens[index] = format!("{text}{}", tokens[index]),
		Some((index, false)) => tokens[index] = format!("{}{text}", tokens[index]),
		None => {
			return Err(Error::Row(format!(
				"insert position {position} is not a token edge (raw={})",
				quote(&row.raw)
			)))
		}
	}
	let mut out = Row {
		raw: string(&raw[..position]) + text + &string(&raw[position..]),
		tokens,
		..row.clone()
	};
	if let Some(triple) = row.span_triple()? {
		let width = chars(text).len() as i64;
		let position = position as i64;
		out.spans = Some(SpanTriple {
			starts: triple
				.starts
				.iter()
				.map(|&s| if s >= position { s + width } else { s })
				.collect(),
			ends: triple
				.ends
				.iter()
				.map(|&e| if e > position { e + width } else { e })
				.collect(),
			tags: triple.tags.clone(),
		});
	}
	Ok(out)
}

/// `" " + text` appended to `raw` as new `O` tokens.
fn append_words(row: &Row, text: &str) -> Row {
	let words = text::split_whitespace(text);
	let mut tokens = row.tokens.clone();
	let mut labels = row.labels.clone();
	labels.extend(std::iter::repeat_n("O".to_owned(), words.len()));
	tokens.extend(words);
	Row {
		raw: format!("{} {text}", row.raw),
		tokens,
		labels,
		..row.clone()
	}
}

/// A copy of `row` wrapped in `pair`, or `None` when `raw` does not begin and end on a token edge.
///
/// A corpus row's tokens may leave out punctuation, as `osm-ru` writes `114, СНТ «Пчёлка»` with the tokens `114`,
/// `СНТ` and `Пчёлка`. Its text then runs past its last token, and the closing character has no token to join
/// (#2878). The row is skipped, so the variant and pair draws already taken are the only ones it consumes.
pub fn wrap_row(row: &Row, pair: (&str, &str)) -> Result<Option<Row>> {
	let raw = row.chars();
	let spans = token_spans(&raw, &row.tokens)?;
	let starts_on_edge = spans.iter().any(|&(start, _)| start == 0);
	let ends_on_edge = spans.iter().any(|&(_, end)| end == raw.len());
	if !starts_on_edge || !ends_on_edge {
		return Ok(None);
	}
	let opened = insert(row, 0, pair.0)?;
	let end = chars(&opened.raw).len();
	insert(&opened, end, pair.1).map(Some)
}

/// A copy with the first span tagged one of `tags` wrapped in `pair`, or `None` when no such span begins and ends on
/// token edges.
pub fn wrap_span(row: &Row, tags: &[&str], pair: (&str, &str)) -> Result<Option<Row>> {
	let Some(triple) = row.span_triple()? else {
		return Ok(None);
	};
	let raw = row.chars();
	let spans = token_spans(&raw, &row.tokens)?;
	let is_edge = |offset: i64| spans.iter().any(|&(s, e)| s as i64 == offset || e as i64 == offset);
	for ((&start, &end), tag) in triple.starts.iter().zip(&triple.ends).zip(&triple.tags) {
		if tags.contains(&tag.as_str()) && is_edge(start) && is_edge(end) {
			let closed = insert(row, end as usize, pair.1)?;
			return insert(&closed, start as usize, pair.0).map(Some);
		}
	}
	Ok(None)
}

/// One grouped copy of `row`, choosing a variant the row supports, or `None` when the chosen variant does not apply.
pub fn group_row(row: &Row, rng: &mut PyRandom) -> Result<Option<Row>> {
	if row.tokens.is_empty() {
		return Ok(None);
	}
	let cjk = is_cjk(&row.raw);
	let mut variants: Vec<&str> = if cjk {
		vec!["wrap_row"]
	} else {
		vec!["wrap_row", "note"]
	};
	if let Some(triple) = row.span_triple()? {
		if triple.tags.iter().any(|t| NAME_TAGS.contains(&t.as_str())) {
			variants.push("wrap_name");
		}
		// `len(raw.rstrip())`.
		let stripped_len = {
			let raw = row.chars();
			(raw.len() - raw.iter().rev().take_while(|&&c| is_space(c)).count()) as i64
		};
		if triple.tags.last().is_some_and(|t| t == "country") && triple.ends.last() == Some(&stripped_len) {
			variants.push("wrap_country");
		}
	}
	let variant = variants[rng.choice_index(variants.len())?];
	let pick = |rng: &mut PyRandom, pairs: &[(&'static str, &'static str)]| -> Result<(&'static str, &'static str)> {
		Ok(pairs[rng.choice_index(pairs.len())?])
	};
	match variant {
		"wrap_row" => {
			let pair = if cjk {
				pick(rng, &CJK_PAIRS)?
			} else {
				pick(rng, &LATIN_PAIRS)?
			};
			wrap_row(row, pair)
		}
		"wrap_name" => {
			let pair = if cjk {
				pick(rng, &CJK_PAIRS)?
			} else {
				pick(rng, &LATIN_NAME_PAIRS)?
			};
			wrap_span(row, &NAME_TAGS, pair)
		}
		"wrap_country" => wrap_span(row, &["country"], ("(", ")")),
		_ => {
			let note = NOTES[rng.choice_index(NOTES.len())?];
			Ok(Some(append_words(row, &format!("({note})"))))
		}
	}
}
