//! The row targets `data/loader/batch.py` adds to every batch: the locale id and the address-system id.
//!
//! The address-system registry is `address_systems.json`, which `mailwoman dev generate address-systems` writes from
//! @mailwoman/codex's layouts. A row written in Latin script reads its country's `latin` system when the country has
//! one, and every other row its `local` system. A row is Latin when it holds a letter and every letter's Unicode name
//! starts with `LATIN` or `FULLWIDTH LATIN`, which `latin_letters.rs` lists. That table was written by running
//! `unicodedata` over every code point under CPython 3.12.3 (Unicode 15.0.0), the interpreter whose
//! `address_systems.is_latin_text` the trainer reproduces: keep each code point whose `unicodedata.category` starts
//! with `L` and whose `unicodedata.name(ch, "")` starts with one of the two prefixes, and merge consecutive ones into
//! inclusive ranges.

use crate::latin_letters::LATIN_LETTERS;
use crate::{fail, Result};
use mtf_channels::python_text;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use trainer_model::encoder::IGNORE_INDEX;

#[derive(Deserialize)]
struct SystemEntry {
	#[allow(dead_code)]
	id: i64,
}

#[derive(Deserialize)]
struct MemberEntry {
	country: String,
	script: String,
	system: i64,
}

#[derive(Deserialize)]
struct Registry {
	systems: Vec<SystemEntry>,
	members: Vec<MemberEntry>,
}

/// The registry's systems and members.
pub struct AddressSystems {
	count: i64,
	members: HashMap<(String, String), i64>,
}

fn is_latin_letter(c: char) -> bool {
	let cp = c as u32;
	LATIN_LETTERS
		.binary_search_by(|&(lo, hi)| {
			if hi < cp {
				std::cmp::Ordering::Less
			} else if lo > cp {
				std::cmp::Ordering::Greater
			} else {
				std::cmp::Ordering::Equal
			}
		})
		.is_ok()
}

/// `is_latin_text`: a letter is present and every letter is Latin.
pub fn is_latin_text(text: &str) -> bool {
	let mut any = false;
	for c in text.chars().filter(|&c| python_text::is_alpha(c)) {
		if !is_latin_letter(c) {
			return false;
		}
		any = true;
	}
	any
}

/// `country.strip().upper()`.
fn normalized(country: &str) -> String {
	let chars: Vec<char> = country.chars().collect();
	python_text::upper(python_text::strip(&chars))
}

impl AddressSystems {
	pub fn load(path: &Path) -> Result<Self> {
		let text = std::fs::read_to_string(path).map_err(|e| fail!("{}: {e}", path.display()))?;
		let registry: Registry = serde_json::from_str(&text)?;
		Ok(Self {
			count: registry.systems.len() as i64,
			members: registry
				.members
				.into_iter()
				.map(|m| ((m.country, m.script), m.system))
				.collect(),
		})
	}

	/// `num_address_systems`: every id the registry has assigned.
	pub fn count(&self) -> i64 {
		self.count
	}

	/// `address_system_id(country, text)`.
	pub fn id(&self, country: Option<&str>, text: &str) -> i64 {
		let Some(country) = country.filter(|c| !c.is_empty()) else {
			return IGNORE_INDEX;
		};
		let code = normalized(country);
		if is_latin_text(text) {
			if let Some(&id) = self.members.get(&(code.clone(), "latin".to_owned())) {
				return id;
			}
		}
		self.members
			.get(&(code, "local".to_owned()))
			.copied()
			.unwrap_or(IGNORE_INDEX)
	}
}

/// `locale_id(country)`: the country's slot in the locale head, or `IGNORE_INDEX`.
pub fn locale_id(locales: &[String], country: Option<&str>) -> i64 {
	let Some(country) = country.filter(|c| !c.is_empty()) else {
		return IGNORE_INDEX;
	};
	let code = normalized(country);
	locales
		.iter()
		.position(|l| *l == code)
		.map(|i| i as i64)
		.unwrap_or(IGNORE_INDEX)
}
