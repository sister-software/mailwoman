// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The postcode finders of the training encoder: the postcode spans of a line and the number of countries whose syntax
//! accepts a code unit.
//!
//! Both read the `postal` family of `@mailwoman/postcode` through `recognizer-core`: its compiled artifact
//! (`packages/postcode/data/artifacts/postal.rca1`) and the family definition that states each shape's countries,
//! form and printed prefix (`packages/postcode/data/definitions/postal.definition.json`). Serving reads the same
//! family in `packages/postcode/lib/postal-spans.ts` and reduces its candidates by the same rule, so the two sides
//! hold one finder. `postalSpans` in `packages/postcode/lib/recognizer/postal/readers.ts` states the rule:
//!
//! - every embedded candidate is reduced to its code, which leaves out a printed prefix and the white space after it;
//! - candidates are ordered longest first, then by earliest start, then by form (designated, alphanumeric, numeric) and
//!   then by the shape's ID, and a range that several shapes match appears once;
//! - a candidate that a connector separates from the rest of a longer candidate is dropped (`69152` in `69152-656`);
//! - the candidates overlap, and the anchor painter keeps the first candidate the anchor table resolves among those
//!   that overlap. A candidate the table lacks hides nothing.
//!
//! The family matches either case, so a lower-case `sw1a 1aa` is a postcode on both sides.

use crate::anchor::PostcodeCandidate;
use crate::error::Error;
use recognizer_core::artifact::ARTIFACT_SCHEMA_VERSION;
use recognizer_core::{Engine, Expected};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// The family the finders read.
pub const POSTAL_FAMILY: &str = "postal";

/// The declarations hash of the artifact this crate was written against.
///
/// `packages/postcode/data/manifests/postal.json` records the hash of the committed artifact, and a test compares the
/// two, so regenerating the family under other declarations fails the crate's tests and not a training run.
pub const POSTAL_DECLARATIONS_HASH: &str = "0d69452b0205fd7cd7115a132d1eb73d7b96e76c34e622ed35c785e071dfb8ac";

/// What a span of a shape may do, in the order candidates of equal extent compete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Form {
	Designated,
	Alnum,
	Numeric,
}

/// What the definition states about one shape.
struct ShapeInfo {
	form: Form,
	/// The characters of the printed prefix, for a printed shape.
	prefix_chars: Option<usize>,
	/// The shape's countries, as indexes into the finder's country table.
	countries: Vec<u32>,
}

/// JavaScript's `\s` and `trim`: the white space `String.prototype.trim` removes.
///
/// The family's printed shapes write the white space after a prefix as this class, so the code of a printed span starts
/// after the same characters. Serving reads it with `trimStart`.
fn is_js_space(c: char) -> bool {
	matches!(
		c,
		'\u{9}'..='\u{d}'
			| '\u{20}'
			| '\u{a0}'
			| '\u{1680}'
			| '\u{2000}'..='\u{200a}'
			| '\u{2028}'
			| '\u{2029}'
			| '\u{202f}'
			| '\u{205f}'
			| '\u{3000}'
			| '\u{feff}'
	)
}

/// The characters a code may be joined to its neighbors by: the hyphen-minus, the apostrophe, the low line and the two
/// curly single quotation marks, the connectors of the engine's `token` boundary.
const CONNECTORS: [char; 5] = ['-', '\'', '_', '\u{2018}', '\u{2019}'];

/// Whether `candidate` is a piece of `container` that a connector separates from the rest.
///
/// `69152` in `69152-656` and `0001` in `100-0001` are pieces of a longer code, and the longer code claims them: a piece
/// that resolves in the anchor table would anchor the code to another country's key. A piece that white space separates, as
/// `05401` in `VT 05401`, is no fragment, because the longer candidate may be no postcode at all. `isConnectorFragment`
/// in `readers.ts` of `@mailwoman/postcode` is the same rule.
fn is_connector_fragment(candidate: (usize, usize), container: (usize, usize), chars: &[char]) -> bool {
	if container.0 > candidate.0 || container.1 < candidate.1 {
		return false;
	}
	let apart_at_start = candidate.0 > container.0;
	let apart_at_end = candidate.1 < container.1;
	if !apart_at_start && !apart_at_end {
		return false;
	}
	(!apart_at_start || CONNECTORS.contains(&chars[candidate.0 - 1]))
		&& (!apart_at_end || CONNECTORS.contains(&chars[candidate.1]))
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

/// The `Finders` the training encoder uses.
pub struct PostalFinders {
	engine: Engine,
	family: usize,
	/// Parallel to the family's shapes in the engine's order, which is the byte order of their IDs.
	shapes: Vec<ShapeInfo>,
	/// The country codes of every shape, which a shape's `countries` and a candidate's index into.
	country_codes: Vec<String>,
	accepted: Mutex<HashMap<String, usize>>,
}

impl PostalFinders {
	/// Loads the artifact and reads the definition. `artifact_file` and `definition_file` name each in errors.
	///
	/// The artifact is refused when it is not the `postal` family, when its schema version or declarations hash is not
	/// the one this crate was built against, or when the definition and the artifact hold different shapes.
	pub fn load(artifact: &[u8], artifact_file: &str, definition: &str, definition_file: &str) -> Result<Self, Error> {
		let mut engine = Engine::new();
		engine
			.load_checked(
				artifact,
				&Expected {
					ir_hash: None,
					declarations_hash: Some(POSTAL_DECLARATIONS_HASH),
				},
			)
			.map_err(|e| Error::Input(format!("{artifact_file}: {e}")))?;
		let not_postal = || {
			Error::Input(format!(
				"{artifact_file}: the artifact is not the {POSTAL_FAMILY:?} family"
			))
		};
		let header = engine.header(POSTAL_FAMILY).ok_or_else(not_postal)?;
		if header.schema_version != ARTIFACT_SCHEMA_VERSION {
			return Err(Error::Input(format!(
				"{artifact_file}: artifact schema version {} is not the {ARTIFACT_SCHEMA_VERSION} this encoder reads",
				header.schema_version
			)));
		}
		let family = engine
			.family_ids()
			.iter()
			.position(|id| *id == POSTAL_FAMILY)
			.ok_or_else(not_postal)?;

		let doc: Value =
			serde_json::from_str(definition).map_err(|e| Error::Input(format!("{definition_file}: {e}")))?;
		let rows = doc
			.get("shapes")
			.and_then(Value::as_array)
			.ok_or_else(|| Error::Input(format!("{definition_file}: \"shapes\" is not an array")))?;
		let mut by_id: HashMap<&str, &Value> = HashMap::new();
		for row in rows {
			let id = row
				.get("id")
				.and_then(Value::as_str)
				.ok_or_else(|| Error::Input(format!("{definition_file}: a shape lacks an id: {row}")))?;
			by_id.insert(id, row);
		}

		let mut countries: HashMap<String, u32> = HashMap::new();
		let mut shapes = Vec::new();
		for id in engine.shapes(family) {
			let row = by_id.get(id.as_str()).ok_or_else(|| {
				Error::Input(format!(
					"{definition_file}: no shape {id:?}, which {artifact_file} holds"
				))
			})?;
			let metadata = row
				.get("metadata")
				.ok_or_else(|| Error::Input(format!("{definition_file}: shape {id:?} states no metadata")))?;
			let form = match metadata.get("form").and_then(Value::as_str) {
				Some("designated") => Form::Designated,
				Some("alnum") => Form::Alnum,
				Some("numeric") => Form::Numeric,
				other => {
					return Err(Error::Input(format!(
						"{definition_file}: shape {id:?} has the form {other:?}, which is not designated, alnum or numeric"
					)))
				}
			};
			let prefix_chars = match metadata.get("prefix") {
				None | Some(Value::Null) => None,
				Some(Value::String(prefix)) => Some(prefix.chars().count()),
				Some(other) => {
					return Err(Error::Input(format!(
						"{definition_file}: shape {id:?} has a prefix that is not a string: {other}"
					)))
				}
			};
			if (form == Form::Designated) != prefix_chars.is_some() {
				return Err(Error::Input(format!(
					"{definition_file}: shape {id:?} is designated exactly when it states a prefix"
				)));
			}
			let listed = metadata
				.get("countries")
				.and_then(Value::as_array)
				.ok_or_else(|| Error::Input(format!("{definition_file}: shape {id:?} lists no countries")))?;
			let mut ids = Vec::with_capacity(listed.len());
			for country in listed {
				let code = country.as_str().ok_or_else(|| {
					Error::Input(format!(
						"{definition_file}: shape {id:?} lists a country that is not text"
					))
				})?;
				let next = countries.len() as u32;
				ids.push(*countries.entry(code.to_string()).or_insert(next));
			}
			shapes.push(ShapeInfo {
				form,
				prefix_chars,
				countries: ids,
			});
		}
		let held: HashSet<&str> = engine.shapes(family).iter().map(String::as_str).collect();
		if let Some(extra) = by_id.keys().find(|id| !held.contains(**id)) {
			return Err(Error::Input(format!(
				"{definition_file}: shape {extra:?} is not in {artifact_file}"
			)));
		}

		let mut by_index: Vec<(u32, String)> = countries.into_iter().map(|(code, index)| (index, code)).collect();
		by_index.sort_unstable();

		Ok(Self {
			engine,
			family,
			shapes,
			country_codes: by_index.into_iter().map(|(_, code)| code).collect(),
			accepted: Mutex::new(HashMap::new()),
		})
	}

	/// The postcode candidates of `raw` as character ranges, in the order they compete: longest first, then earliest
	/// start, then form and shape ID. A range appears once however many shapes match it.
	///
	/// The candidates overlap. The anchor painter walks them in this order and keeps the first that the anchor table
	/// resolves among those that overlap, so `VT 05401`, which a Somali shape matches, does not hide the ZIP code inside
	/// it.
	pub fn postcode_spans(&self, raw: &str) -> Result<Vec<PostcodeCandidate>, Error> {
		let located = self
			.engine
			.locate(raw, |family| family == self.family)
			.map_err(|e| Error::Finder(format!("postal family on {raw:?}: {e}")))?;
		if located.is_empty() {
			return Ok(Vec::new());
		}
		let map = byte_to_char(raw);
		let chars: Vec<char> = raw.chars().collect();
		let mut candidates: Vec<(usize, usize, Form, usize)> = Vec::with_capacity(located.len());
		for found in located {
			let info = &self.shapes[found.shape];
			let (mut start, end) = (map[found.start], map[found.end]);
			if let Some(prefix) = info.prefix_chars {
				start = (start + prefix).min(end);
				while start < end && is_js_space(chars[start]) {
					start += 1;
				}
			}
			candidates.push((start, end, info.form, found.shape));
		}
		candidates.sort_by_key(|&(start, end, form, shape)| (std::cmp::Reverse(end - start), start, form, shape));
		// One candidate for each range, in competing order, holding the countries of every shape that matches it.
		let mut ordered: Vec<PostcodeCandidate> = Vec::with_capacity(candidates.len());
		for (start, end, _, shape) in candidates {
			let countries = &self.shapes[shape].countries;
			match ordered.iter_mut().find(|c| c.start == start && c.end == end) {
				Some(existing) => existing
					.countries
					.get_or_insert_with(Vec::new)
					.extend(countries.iter().copied()),
				None => ordered.push(PostcodeCandidate {
					start,
					end,
					countries: Some(countries.clone()),
				}),
			}
		}
		let all: Vec<(usize, usize)> = ordered.iter().map(|c| (c.start, c.end)).collect();
		ordered.retain(|c| {
			!all.iter()
				.any(|&container| is_connector_fragment((c.start, c.end), container, &chars))
		});
		for candidate in &mut ordered {
			if let Some(countries) = &mut candidate.countries {
				countries.sort_unstable();
				countries.dedup();
			}
		}
		Ok(ordered)
	}

	/// How many countries' postcode syntax accepts the whole of `value`, after it is trimmed as `trim` trims.
	///
	/// This is the length of `countriesAcceptingPostcode` in `@mailwoman/postcode`, which the postal family's
	/// whole-input automaton answers. The answers are cached by `value`.
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
		let trimmed = key.trim_matches(is_js_space);
		let found = self
			.engine
			.whole_shapes(self.family, trimmed)
			.map_err(|e| Error::Finder(format!("postal family on {trimmed:?}: {e}")))?;
		let mut countries: HashSet<u32> = HashSet::new();
		for shape in found {
			countries.extend(self.shapes[shape].countries.iter().copied());
		}
		let count = countries.len();
		self.accepted
			.lock()
			.expect("the acceptance cache is not poisoned")
			.insert(key, count);
		Ok(count)
	}
}

impl crate::encoder::Finders for PostalFinders {
	fn postcode_spans(&self, raw: &str) -> Result<Vec<PostcodeCandidate>, Error> {
		PostalFinders::postcode_spans(self, raw)
	}

	fn country_codes(&self) -> &[String] {
		&self.country_codes
	}

	fn code_units(&self, raw: &[char]) -> Result<Vec<crate::code_units::CodeUnit>, Error> {
		crate::code_units::segment(raw)
			.into_iter()
			.map(|(start, end)| {
				Ok(crate::code_units::CodeUnit {
					start,
					end,
					accepting: self.accepting(&raw[start..end])?,
				})
			})
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn js_white_space_is_the_set_trim_removes() {
		for c in ['\t', '\n', ' ', '\u{a0}', '\u{2003}', '\u{3000}', '\u{feff}'] {
			assert!(is_js_space(c), "U+{:04X}", c as u32);
		}
		// U+001C..U+001F are Python white space and not JavaScript's.
		for c in ['\u{1c}', '\u{85}', 'a', '0', '\u{200b}'] {
			assert!(!is_js_space(c), "U+{:04X}", c as u32);
		}
	}
}
