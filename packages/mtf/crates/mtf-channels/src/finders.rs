// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The regex-backed span finders: postcode shapes and postcode syntax.
//!
//! The patterns are written for Python's `re`. In a `str` pattern, `\d` matches any decimal digit, `\s` any
//! character `str.isspace` accepts, `\w` any alphanumeric character or the underscore, and `\b` the boundary
//! between a `\w` character and anything else. The Rust regex engines define all four differently: `\w` there
//! includes combining marks and connector punctuation. `translate` therefore rewrites each of them into an
//! explicit class built from the reference interpreter's tables, so a compiled pattern matches what Python
//! matched. `fancy-regex` supplies the lookbehind and lookahead the shapes use.

use crate::error::Error;
use crate::python_text::{self, is_decimal, is_space, strip, upper};
use fancy_regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Mutex;

/// The ranges of a predicate over every scalar value, as a regex class body.
fn class_body(predicate: fn(char) -> bool) -> String {
	let mut out = String::new();
	let mut start: Option<u32> = None;
	let mut previous = 0u32;
	let flush = |out: &mut String, a: u32, b: u32| {
		if a == b {
			let _ = write!(out, "\\x{{{a:X}}}");
		} else {
			let _ = write!(out, "\\x{{{a:X}}}-\\x{{{b:X}}}");
		}
	};
	for c in (0..=char::MAX as u32).filter_map(char::from_u32) {
		let code = c as u32;
		if predicate(c) {
			match start {
				Some(_) if code == previous + 1 || (previous == 0xD7FF && code == 0xE000) => {}
				Some(s) => {
					flush(&mut out, s, previous);
					start = Some(code);
				}
				None => start = Some(code),
			}
			previous = code;
		}
	}
	if let Some(s) = start {
		flush(&mut out, s, previous);
	}
	out
}

/// The Python class bodies `translate` substitutes, built once per process.
struct Classes {
	digit: String,
	space: String,
	word: String,
}

fn classes() -> &'static Classes {
	static CLASSES: std::sync::OnceLock<Classes> = std::sync::OnceLock::new();
	CLASSES.get_or_init(|| Classes {
		digit: class_body(is_decimal),
		space: class_body(is_space),
		word: class_body(python_text::is_word),
	})
}

/// A Python `re` pattern rewritten so `\d`, `\s`, `\w`, `\b` and their negations keep Python's meaning.
pub fn translate(pattern: &str) -> Result<String, Error> {
	let c = classes();
	let word_boundary = format!("(?:(?<=[{w}])(?![{w}])|(?<![{w}])(?=[{w}]))", w = c.word);
	let not_word_boundary = format!("(?:(?<=[{w}])(?=[{w}])|(?<![{w}])(?![{w}]))", w = c.word);
	let mut out = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	let mut in_class = false;
	let mut class_start = false;
	while let Some(ch) = chars.next() {
		if ch == '\\' {
			let escaped = chars
				.next()
				.ok_or_else(|| Error::Input(format!("pattern {pattern:?} ends in a backslash")))?;
			let body = match escaped {
				'd' => Some(&c.digit),
				's' => Some(&c.space),
				'w' => Some(&c.word),
				_ => None,
			};
			match (in_class, escaped, body) {
				(true, _, Some(body)) => out.push_str(body),
				(true, 'D' | 'S' | 'W' | 'b' | 'B', _) => {
					return Err(Error::Input(format!(
						"pattern {pattern:?} uses \\{escaped} inside a class, which translate does not rewrite"
					)))
				}
				(false, _, Some(body)) => {
					let _ = write!(out, "[{body}]");
				}
				(false, 'D', _) => {
					let _ = write!(out, "[^{}]", c.digit);
				}
				(false, 'S', _) => {
					let _ = write!(out, "[^{}]", c.space);
				}
				(false, 'W', _) => {
					let _ = write!(out, "[^{}]", c.word);
				}
				(false, 'b', _) => out.push_str(&word_boundary),
				(false, 'B', _) => out.push_str(&not_word_boundary),
				_ => {
					out.push('\\');
					out.push(escaped);
				}
			}
			class_start = false;
			continue;
		}
		if in_class {
			if ch == ']' && !class_start {
				in_class = false;
			}
			class_start = class_start && ch == '^';
			out.push(ch);
			continue;
		}
		if ch == '[' {
			in_class = true;
			class_start = true;
		}
		out.push(ch);
	}
	if in_class {
		return Err(Error::Input(format!("pattern {pattern:?} leaves a class open")));
	}
	Ok(out)
}

fn compile(pattern: &str, ignore_case: bool) -> Result<Regex, Error> {
	let translated = translate(pattern)?;
	let source = if ignore_case {
		format!("(?i){translated}")
	} else {
		translated
	};
	Regex::new(&source).map_err(|e| Error::Input(format!("pattern {pattern:?} does not compile: {e}")))
}

/// The byte-offset-to-character-index table of a string, one entry per byte plus the end.
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

/// Every match of `regex` over `text`, as character ranges, in the order `re.finditer` returns them.
fn find_all(regex: &Regex, text: &str, map: &[usize], label: &str) -> Result<Vec<(usize, usize)>, Error> {
	regex
		.find_iter(text)
		.map(|m| {
			m.map(|m| (map[m.start()], map[m.end()]))
				.map_err(|e| Error::Finder(format!("{label} on {text:?}: {e}")))
		})
		.collect()
}

/// One postcode-shaped match: its character range, the record's kind, and its priority (lower wins an overlap).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeMatch {
	pub start: usize,
	pub end: usize,
	pub kind: String,
	pub priority: usize,
}

/// The postcode shapes the anchor's `shaped` mode paints, from `features/postcode-shapes.json`.
pub struct PostcodeShapes {
	/// `(label, kind, pattern)` in record order, each row the record marks `javascriptOnly` left out.
	shapes: Vec<(String, String, Regex)>,
}

impl PostcodeShapes {
	/// Compiles every shape the record does not mark `javascriptOnly`. `file` names the record in errors.
	pub fn from_record(text: &str, file: &str) -> Result<Self, Error> {
		let doc: Value = serde_json::from_str(text).map_err(|e| Error::Input(format!("{file}: {e}")))?;
		let rows = doc
			.get("shapes")
			.and_then(Value::as_array)
			.ok_or_else(|| Error::Input(format!("{file}: \"shapes\" is not an array")))?;
		let mut shapes = Vec::new();
		for row in rows {
			if row.get("javascriptOnly").is_some() {
				continue;
			}
			let text_field = |key: &str| {
				row.get(key)
					.and_then(Value::as_str)
					.map(str::to_string)
					.ok_or_else(|| Error::Input(format!("{file}: a shape lacks {key:?}: {row}")))
			};
			let pattern = text_field("pattern")?;
			shapes.push((text_field("label")?, text_field("kind")?, compile(&pattern, false)?));
		}
		Ok(Self { shapes })
	}

	/// The labels of the compiled shapes, in priority order.
	pub fn labels(&self) -> Vec<&str> {
		self.shapes.iter().map(|(label, _, _)| label.as_str()).collect()
	}

	/// Non-overlapping postcode-shaped ranges, accepted longest first and then by priority, in start order.
	pub fn collect_matches(&self, text: &str) -> Result<Vec<ShapeMatch>, Error> {
		let map = byte_to_char(text);
		let mut candidates = Vec::new();
		for (priority, (label, kind, regex)) in self.shapes.iter().enumerate() {
			for (start, end) in find_all(regex, text, &map, label)? {
				candidates.push(ShapeMatch {
					start,
					end,
					kind: kind.clone(),
					priority,
				});
			}
		}
		candidates.sort_by_key(|c| (std::cmp::Reverse(c.end - c.start), c.priority));
		let mut accepted: Vec<ShapeMatch> = Vec::new();
		for c in candidates {
			if accepted.iter().any(|a| c.start < a.end && a.start < c.end) {
				continue;
			}
			accepted.push(c);
		}
		accepted.sort_by_key(|c| c.start);
		Ok(accepted)
	}
}

/// Each country's postcode pattern and printed prefix, from `data/postcode-syntax.json`.
pub struct PostcodeSyntax {
	/// `(pattern, prefix)` in country-code order.
	countries: Vec<(Regex, Option<Vec<char>>)>,
	accepted: Mutex<HashMap<String, usize>>,
}

impl PostcodeSyntax {
	/// Compiles every country's pattern case-insensitively. `file` names the record in errors.
	pub fn from_json(text: &str, file: &str) -> Result<Self, Error> {
		let doc: Value = serde_json::from_str(text).map_err(|e| Error::Input(format!("{file}: {e}")))?;
		let countries = doc
			.get("countries")
			.and_then(Value::as_object)
			.ok_or_else(|| Error::Input(format!("{file}: \"countries\" is not an object")))?;
		let mut sorted: Vec<(&String, &Value)> = countries.iter().collect();
		sorted.sort_by(|a, b| a.0.cmp(b.0));
		let mut out = Vec::with_capacity(sorted.len());
		for (code, entry) in sorted {
			let pattern = entry
				.get("pattern")
				.and_then(Value::as_str)
				.ok_or_else(|| Error::Input(format!("{file}: {code} lacks a pattern")))?;
			let prefix = match entry.get("prefix") {
				None | Some(Value::Null) => None,
				Some(Value::String(p)) => Some(p.chars().collect()),
				Some(other) => return Err(Error::Input(format!("{file}: {code} prefix is not a string: {other}"))),
			};
			out.push((compile(pattern, true)?, prefix));
		}
		Ok(Self {
			countries: out,
			accepted: Mutex::new(HashMap::new()),
		})
	}

	/// How many countries' postcode syntax accepts `value`, after stripping it and any printed prefix.
	pub fn accepting(&self, value: &[char]) -> Result<usize, Error> {
		let key: String = value.iter().collect();
		if let Some(&count) = self
			.accepted
			.lock()
			.expect("the acceptance cache is not poisoned")
			.get(&key)
		{
			return Ok(count);
		}
		let trimmed = strip(value);
		let mut count = 0;
		for (regex, prefix) in &self.countries {
			let mut candidate = trimmed;
			if let Some(prefix) = prefix.as_deref().filter(|p| !p.is_empty()) {
				let upper_candidate: Vec<char> = upper(candidate).chars().collect();
				if upper_candidate.starts_with(prefix) {
					candidate = strip(candidate.get(prefix.len()..).unwrap_or(&[]));
				}
			}
			let text: String = candidate.iter().collect();
			let found = regex
				.is_match(&text)
				.map_err(|e| Error::Finder(format!("postcode syntax on {text:?}: {e}")))?;
			if found {
				count += 1;
			}
		}
		self.accepted
			.lock()
			.expect("the acceptance cache is not poisoned")
			.insert(key, count);
		Ok(count)
	}
}

/// The `Finders` the training encoder uses: the shape record for the shaped anchor and the postcode syntax for
/// code-unit acceptance counts.
pub struct RegexFinders {
	pub shapes: PostcodeShapes,
	pub syntax: PostcodeSyntax,
}

impl crate::encoder::Finders for RegexFinders {
	fn shaped_spans(&self, raw: &str) -> Result<Vec<(usize, usize)>, Error> {
		Ok(self
			.shapes
			.collect_matches(raw)?
			.into_iter()
			.map(|m| (m.start, m.end))
			.collect())
	}

	fn code_units(&self, raw: &[char]) -> Result<Vec<crate::code_units::CodeUnit>, Error> {
		crate::code_units::segment(raw)
			.into_iter()
			.map(|(start, end)| {
				Ok(crate::code_units::CodeUnit {
					start,
					end,
					accepting: self.syntax.accepting(&raw[start..end])?,
				})
			})
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn translate_rewrites_python_escapes_outside_and_inside_classes() {
		let t = translate(r"\b[A-Z\d]\s").unwrap();
		assert!(t.starts_with("(?:(?<=["));
		assert!(t.contains("\\x{30}-\\x{39}"));
		assert!(!t.contains("\\d") && !t.contains("\\s"));
		assert_eq!(translate(r"[\-]\(").unwrap(), r"[\-]\(");
		assert!(translate(r"[\b]").is_err());
	}

	#[test]
	fn a_python_word_boundary_ignores_combining_marks() {
		// U+0301 COMBINING ACUTE is not alphanumeric, so Python's \b falls between it and the digits.
		let regex = compile(r"\b\d{5}\b", false).unwrap();
		assert!(regex.is_match("e\u{301}12345").unwrap());
		assert!(!regex.is_match("_12345").unwrap());
	}
}
