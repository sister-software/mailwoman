// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's Script, ScriptSegmenter and OsmNames (BSD-3-Clause, Protomaps).

//! Name attributes from OpenStreetMap tags, with the fork's script detection and splitting of mixed-script names.
//!
//! Java reads scripts one UTF-16 code unit at a time, so a character outside the Basic Multilingual Plane counts as
//! two units of no script. This module does the same. Script names follow Java's `Character.UnicodeScript` enum: the
//! Unicode long name in capitals, shown with only its first letter capitalized, such as "Latin" or "Old_italic".
//!
//! The fork also writes `pgf:` attributes for scripts whose fonts are registered from `pgf-encoding.zip`. This port
//! registers no fonts yet, which matches a Java build without that archive.

use unicode_script::{Script, UnicodeScript};

use crate::builder::Builder;
use crate::input::Input;

/// The `name:<language>` keys the fork copies to the output.
const ALLOWED_LANGUAGES: [&str; 41] = [
	"ar", "cs", "bg", "da", "de", "el", "en", "es", "et", "fa", "fi", "fr", "ga", "he", "hi", "hr", "hu", "id", "it",
	"ja", "ko", "lt", "lv", "ne", "nl", "no", "mr", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "ur",
	"vi", "zh-Hans", "zh-Hant",
];

/// Returns whether `key` is a `name:<language>` key the fork keeps.
pub fn is_allowed(key: &str) -> bool {
	key.strip_prefix("name:")
		.is_some_and(|language| ALLOWED_LANGUAGES.contains(&language))
}

/// The script of one UTF-16 code unit, or `None` for Common, Inherited, Unknown and surrogate halves.
fn unit_script(unit: u16) -> Option<Script> {
	let script = char::from_u32(u32::from(unit))?.script();
	match script {
		Script::Common | Script::Inherited | Script::Unknown => None,
		other => Some(other),
	}
}

fn java_name(script: Script) -> String {
	let upper = script.full_name().to_uppercase().replace(' ', "_");
	let mut chars = upper.chars();
	match chars.next() {
		Some(first) => first.to_string() + &chars.as_str().to_lowercase(),
		None => String::new(),
	}
}

/// The fork's `Script.getScript`: "Generic" when no character has a script, the single script's name, "Mixed-Japanese"
/// for mixed text with kana, or "Mixed".
pub fn get_script(text: &str) -> String {
	let mut overall: Option<Script> = None;
	for unit in text.encode_utf16() {
		let Some(script) = unit_script(unit) else {
			continue;
		};
		match overall {
			None => overall = Some(script),
			Some(existing) if existing != script => {
				let kana = text
					.encode_utf16()
					.any(|unit| matches!(unit_script(unit), Some(Script::Katakana | Script::Hiragana)));
				return if kana {
					"Mixed-Japanese".to_owned()
				} else {
					"Mixed".to_owned()
				};
			}
			Some(_) => {}
		}
	}
	overall.map_or_else(|| "Generic".to_owned(), java_name)
}

/// Java's `Character.isWhitespace`.
fn java_whitespace(c: char) -> bool {
	(c.is_whitespace() && !matches!(c, '\u{a0}' | '\u{2007}' | '\u{202f}' | '\u{85}'))
		|| ('\u{1c}'..='\u{1f}').contains(&c)
}

fn java_strip(text: &str) -> &str {
	text.trim_matches(java_whitespace)
}

fn utf16_len(text: &str) -> usize {
	text.encode_utf16().count()
}

/// The fork's `cleanEndsAndZWSP`: trims, drops one trailing separator and an unmatched closing parenthesis, and removes
/// zero-width spaces.
fn clean_ends(input: &str) -> String {
	let mut result = java_strip(input).to_owned();
	if result.ends_with(['/', '-', ';', '(', ',']) {
		result.pop();
		result = java_strip(&result).to_owned();
	}
	if result.ends_with(')') && !result.contains('(') {
		result.pop();
		result = java_strip(&result).to_owned();
	}
	result.replace('\u{200b}', "")
}

fn should_segment(line: &str) -> bool {
	let mut line = line;
	for suffix in [" I", "-I", " V", "-V"] {
		if line.ends_with(suffix) {
			line = &line[..line.len() - 2];
			break;
		}
	}
	for suffix in [" II", "-II", " IV", "-IV", " VI", "-VI"] {
		if line.ends_with(suffix) {
			line = &line[..line.len() - 3];
			break;
		}
	}
	for suffix in [" III", "-III"] {
		if line.ends_with(suffix) {
			line = &line[..line.len() - 4];
			break;
		}
	}
	let mut scripts: Vec<Script> = Vec::new();
	for unit in line.encode_utf16() {
		if let Some(script) = unit_script(unit) {
			if !scripts.contains(&script) {
				scripts.push(script);
			}
		}
	}
	let has = |script| scripts.contains(&script);
	if scripts.len() == 2 && has(Script::Han) && (has(Script::Hiragana) || has(Script::Katakana)) {
		return false;
	}
	if scripts.len() == 3 && has(Script::Han) && has(Script::Hiragana) && has(Script::Katakana) {
		return false;
	}
	scripts.len() > 1
}

/// The fork's `segmentByScript`: splits a name written in several scripts into one segment per script.
///
/// The name stays whole when it is in one script, when it mixes Han with kana, or when splitting would repeat a script
/// or leave a one-character segment.
pub fn segment_by_script(input: &str) -> Vec<String> {
	if input.is_empty() {
		return Vec::new();
	}
	if !should_segment(input) {
		return vec![input.to_owned()];
	}
	let units: Vec<u16> = input.encode_utf16().collect();
	let mut segments = Vec::new();
	let mut current: Vec<u16> = Vec::new();
	let mut current_script = unit_script(units[0]);
	let flush = |current: &mut Vec<u16>, segments: &mut Vec<String>| {
		if !current.is_empty() {
			let segment = clean_ends(&String::from_utf16_lossy(current));
			if !segment.is_empty() {
				segments.push(segment);
			}
		}
		current.clear();
	};
	for &unit in &units {
		let script = unit_script(unit);
		match current_script {
			None => {
				current_script = script;
				current.push(unit);
			}
			Some(existing) => {
				if script.is_none() || script == Some(existing) {
					current.push(unit);
				} else {
					flush(&mut current, &mut segments);
					current.push(unit);
					current_script = script;
				}
			}
		}
	}
	flush(&mut current, &mut segments);

	let mut seen = Vec::new();
	let repeated = segments.iter().any(|segment| {
		let script = get_script(segment);
		if seen.contains(&script) {
			true
		} else {
			seen.push(script);
			false
		}
	});
	let one_character = segments.iter().any(|segment| utf16_len(segment) == 1);
	if repeated || one_character {
		return vec![input.to_owned()];
	}
	segments
}

/// The fork's `TextEngine.encodeRegisteredScripts` with no fonts registered: the text unchanged.
fn encode_registered_scripts(text: &str) -> String {
	text.to_owned()
}

/// The fork's `OsmNames.setOsmNames`: `name`, `name2` and `name3` from the script segments of `name` with their
/// non-Latin scripts, the allowed `name:<language>` tags, and `name:zh` copied to the Han variants when they are
/// missing, each present from `min_zoom`.
pub fn set_osm_names(feature: &mut Builder, input: &Input<'_>, min_zoom: i32) {
	for (key, value) in input.tags() {
		if key == "name" {
			let segments = segment_by_script(value);
			for (index, (name_key, script_key, pgf_key)) in [
				("name", "script", "pgf:name"),
				("name2", "script2", "pgf:name2"),
				("name3", "script3", "pgf:name3"),
			]
			.into_iter()
			.enumerate()
			{
				let Some(segment) = segments.get(index) else {
					break;
				};
				feature.set_attr_with_min_zoom(name_key, segment.as_str(), min_zoom);
				let script = get_script(segment);
				if script != "Latin" && script != "Generic" {
					feature.set_attr_with_min_zoom(script_key, script, min_zoom);
				}
				let encoded = encode_registered_scripts(segment);
				if encoded != *segment {
					feature.set_attr_with_min_zoom(pgf_key, encoded, min_zoom);
				}
			}
		}
		if is_allowed(key) {
			feature.set_attr_with_min_zoom(key, value, min_zoom);
		}
	}
	if let Some(chinese) = input.tag("name:zh") {
		if !input.has_tag("name:zh-Hant") {
			feature.set_attr_with_min_zoom("name:zh-Hant", chinese, min_zoom);
		}
		if !input.has_tag("name:zh-Hans") {
			feature.set_attr_with_min_zoom("name:zh-Hans", chinese, min_zoom);
		}
	}
}

/// The fork's `OsmNames.setOsmRefs`: each `ref` and `ref:*` tag shorter than five UTF-16 units that is not wholly a
/// number, such as a state's `CA`, present from `min_zoom`.
pub fn set_osm_refs(feature: &mut Builder, input: &Input<'_>, min_zoom: i32) {
	for (key, value) in input.tags() {
		if key != "ref" && !key.starts_with("ref:") {
			continue;
		}
		let length = value.encode_utf16().count();
		if length < 5 && crate::parse::number_format_parse_length(value) != length {
			feature.set_attr_with_min_zoom(key, value, min_zoom);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn scripts_are_named_as_java_names_them() {
		assert_eq!(get_script("Monaco"), "Latin");
		assert_eq!(get_script("123"), "Generic");
		assert_eq!(get_script("Москва"), "Cyrillic");
		assert_eq!(get_script("東京 Tokyo"), "Mixed");
		assert_eq!(get_script("東京タワー Tower"), "Mixed-Japanese");
	}

	#[test]
	fn mixed_script_names_split_once_per_script() {
		assert_eq!(segment_by_script("Athens Αθήνα"), vec!["Athens", "Αθήνα"]);
		assert_eq!(segment_by_script("東京タワー"), vec!["東京タワー"]);
		assert_eq!(segment_by_script("Rocky III"), vec!["Rocky III"]);
		assert_eq!(segment_by_script("Genève / Genf"), vec!["Genève / Genf"]);
	}
}
