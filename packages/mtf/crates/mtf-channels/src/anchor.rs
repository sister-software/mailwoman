// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The postcode-anchor channel.
//!
//! A postcode span's surface, space-stripped and uppercased, is looked up in the anchor table. A hit paints
//! every character of the span with the entry's feature vector and confidence 1, and each piece takes the
//! values of the first non-space character it covers. A GB unit postcode that misses retries its outward
//! district (`SW1A 2AA` to `SW1A`) and paints the whole unit span from that entry.

use crate::channel::{Channel, Piece};
use crate::error::Error;
use crate::python_text::{is_decimal, is_space, strip, upper};
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::collections::HashMap;
use std::fmt;

/// The inward half of a GB unit postcode is always its last three characters.
const GB_INWARD_LENGTH: usize = 3;

/// One postcode's entry: its country posterior in file order, and its centroid.
#[derive(Debug, Clone)]
struct Entry {
	/// `(country index, weight)` in the order the file lists the posterior's keys.
	posterior: Box<[(u16, f64)]>,
	lat: f64,
	lon: f64,
}

/// The postcode-to-anchor table, `{postcode: [{country: weight}, lat, lon, provenance?]}`.
#[derive(Debug, Clone, Default)]
pub struct AnchorLookup {
	entries: HashMap<String, Entry>,
	/// Every distinct posterior key, indexed by `Entry::posterior`.
	countries: Vec<String>,
}

struct Interner<'a> {
	countries: &'a mut Vec<String>,
	index: &'a mut HashMap<String, u16>,
}

impl Interner<'_> {
	fn intern(&mut self, country: String) -> Result<u16, String> {
		if let Some(&i) = self.index.get(&country) {
			return Ok(i);
		}
		let i =
			u16::try_from(self.countries.len()).map_err(|_| "more than 65,535 distinct posterior keys".to_string())?;
		self.countries.push(country.clone());
		self.index.insert(country, i);
		Ok(i)
	}
}

/// A JSON number as Python's `float()` of the value `json.load` returns.
struct Number;

impl<'de> Visitor<'de> for Number {
	type Value = f64;
	fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
		f.write_str("a number")
	}
	fn visit_f64<E>(self, v: f64) -> Result<f64, E> {
		Ok(v)
	}
	fn visit_i64<E>(self, v: i64) -> Result<f64, E> {
		Ok(v as f64)
	}
	fn visit_u64<E>(self, v: u64) -> Result<f64, E> {
		Ok(v as f64)
	}
}

impl<'de> DeserializeSeed<'de> for Number {
	type Value = f64;
	fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<f64, D::Error> {
		d.deserialize_any(self)
	}
}

struct Posterior<'a, 'b>(&'a mut Interner<'b>);

impl<'de> Visitor<'de> for Posterior<'_, '_> {
	type Value = Vec<(u16, f64)>;
	fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
		f.write_str("a {country: weight} object")
	}
	fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
		let mut out: Vec<(u16, f64)> = Vec::with_capacity(1);
		while let Some(country) = map.next_key::<String>()? {
			let weight = map.next_value_seed(Number)?;
			let index = self.0.intern(country).map_err(serde::de::Error::custom)?;
			// A repeated key keeps its first position and takes the last value, as a Python dict does.
			match out.iter_mut().find(|(i, _)| *i == index) {
				Some(slot) => slot.1 = weight,
				None => out.push((index, weight)),
			}
		}
		Ok(out)
	}
}

impl<'de> DeserializeSeed<'de> for Posterior<'_, '_> {
	type Value = Vec<(u16, f64)>;
	fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
		d.deserialize_map(self)
	}
}

struct EntrySeed<'a, 'b>(&'a mut Interner<'b>);

impl<'de> Visitor<'de> for EntrySeed<'_, '_> {
	type Value = Entry;
	fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
		f.write_str("a [posterior, lat, lon, provenance?] array")
	}
	fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Entry, A::Error> {
		let missing = |what: &str| serde::de::Error::custom(format!("anchor entry lacks its {what}"));
		let posterior = seq
			.next_element_seed(Posterior(self.0))?
			.ok_or_else(|| missing("posterior"))?;
		let lat = seq.next_element_seed(Number)?.ok_or_else(|| missing("latitude"))?;
		let lon = seq.next_element_seed(Number)?.ok_or_else(|| missing("longitude"))?;
		while seq.next_element::<IgnoredAny>()?.is_some() {}
		Ok(Entry {
			posterior: posterior.into_boxed_slice(),
			lat,
			lon,
		})
	}
}

impl<'de> DeserializeSeed<'de> for EntrySeed<'_, '_> {
	type Value = Entry;
	fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Entry, D::Error> {
		d.deserialize_seq(self)
	}
}

struct LookupVisitor;

impl<'de> Visitor<'de> for LookupVisitor {
	type Value = AnchorLookup;
	fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
		f.write_str("a {postcode: entry} object")
	}
	fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<AnchorLookup, A::Error> {
		let mut countries = Vec::new();
		let mut index = HashMap::new();
		let mut entries = HashMap::with_capacity(map.size_hint().unwrap_or(0));
		let mut interner = Interner {
			countries: &mut countries,
			index: &mut index,
		};
		while let Some(postcode) = map.next_key::<String>()? {
			let entry = map.next_value_seed(EntrySeed(&mut interner))?;
			entries.insert(postcode, entry);
		}
		Ok(AnchorLookup { entries, countries })
	}
}

/// `max(-1.0, min(1.0, x))` with Python's argument-order rule, under which a NaN clamps to 1.0.
fn clamp_unit(x: f64) -> f64 {
	let upper = if x < 1.0 { x } else { 1.0 };
	if upper > -1.0 {
		upper
	} else {
		-1.0
	}
}

impl AnchorLookup {
	/// Parses the table's JSON. `file` names it in errors.
	pub fn from_json(text: &str, file: &str) -> Result<Self, Error> {
		let mut de = serde_json::Deserializer::from_str(text);
		let lookup = de
			.deserialize_map(LookupVisitor)
			.and_then(|lookup| de.end().map(|()| lookup))
			.map_err(|e| Error::Input(format!("{file}: {e}")))?;
		Ok(lookup)
	}

	/// The number of postcodes in the table.
	pub fn len(&self) -> usize {
		self.entries.len()
	}

	/// Whether the table holds no postcode.
	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}

	/// Each posterior key's locale slot, for a locale table: the key stripped, uppercased and looked up.
	pub fn locale_slots(&self, locales: &[String]) -> Vec<Option<usize>> {
		self.countries
			.iter()
			.map(|country| {
				let chars: Vec<char> = country.chars().collect();
				let key = upper(strip(&chars));
				locales.iter().position(|l| *l == key)
			})
			.collect()
	}

	/// The fixed-width anchor feature vector: the posterior renormalized over the locale set, then the centroid.
	///
	/// The arithmetic is the Python loader's, in `f64` and in the same order: each in-set weight is assigned to
	/// its locale's slot and added to the total as the posterior lists it, each slot is divided by the total once
	/// the sum is complete, and latitude and longitude are divided by 90 and 180 and clamped to [-1, 1].
	fn feature_vector(entry: &Entry, slots: &[Option<usize>], locales: usize) -> Vec<f64> {
		let mut vec = vec![0.0f64; locales + 2];
		let mut total = 0.0f64;
		for &(country, weight) in entry.posterior.iter() {
			if let Some(slot) = slots[country as usize] {
				vec[slot] = weight;
				total += weight;
			}
		}
		if total > 0.0 {
			for v in &mut vec[..locales] {
				*v /= total;
			}
		}
		vec[locales] = clamp_unit(entry.lat / 90.0);
		vec[locales + 1] = clamp_unit(entry.lon / 180.0);
		vec
	}

	/// The feature vector of a postcode key's entry, or `None` on a miss.
	pub fn features(&self, key: &str, slots: &[Option<usize>], locales: usize) -> Option<Vec<f64>> {
		self.entries
			.get(key)
			.map(|entry| Self::feature_vector(entry, slots, locales))
	}
}

/// `^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$` under Python's `re.match`, where `\d` is any decimal digit and `$` also
/// matches before one trailing newline.
fn is_gb_unit_key(key: &[char]) -> bool {
	let body = |s: &[char]| -> bool {
		let upper = |c: char| c.is_ascii_uppercase();
		for area in 1..=2usize {
			for optional in 0..=1usize {
				let n = area + 1 + optional + 1 + 2;
				if s.len() != n {
					continue;
				}
				let (a, rest) = s.split_at(area);
				if !a.iter().all(|&c| upper(c)) || !is_decimal(rest[0]) {
					continue;
				}
				let rest = &rest[1..];
				let (opt, rest) = rest.split_at(optional);
				if !opt.iter().all(|&c| upper(c) || is_decimal(c)) {
					continue;
				}
				if is_decimal(rest[0]) && upper(rest[1]) && upper(rest[2]) {
					return true;
				}
			}
		}
		false
	};
	body(key) || (key.last() == Some(&'\n') && body(&key[..key.len() - 1]))
}

/// The anchor channel's character painting and its projection onto pieces.
pub struct AnchorPainter<'a> {
	pub lookup: &'a AnchorLookup,
	pub slots: &'a [Option<usize>],
	pub locales: usize,
}

impl AnchorPainter<'_> {
	/// The channel's width: one slot per locale, then latitude and longitude.
	pub fn dim(&self) -> usize {
		self.locales + 2
	}

	/// Paints each postcode range that hits the table, then projects the characters onto the pieces.
	pub fn paint(&self, raw: &[char], ranges: &[(usize, usize)], pieces: &[Piece]) -> Channel {
		let mut char_feat: Vec<Option<std::rc::Rc<Vec<f64>>>> = vec![None; raw.len()];
		for &(begin, end) in ranges {
			let begin = begin.min(raw.len());
			let end = end.min(raw.len()).max(begin);
			let key_chars: Vec<char> = raw[begin..end].iter().copied().filter(|&c| c != ' ').collect();
			let key_upper: Vec<char> = upper(&key_chars).chars().collect();
			let key: String = key_upper.iter().collect();
			let mut hit = self.lookup.features(&key, self.slots, self.locales);
			if hit.is_none() && is_gb_unit_key(&key_upper) {
				let outward: String = key_upper[..key_upper.len() - GB_INWARD_LENGTH].iter().collect();
				hit = self.lookup.features(&outward, self.slots, self.locales);
			}
			if let Some(features) = hit {
				let shared = std::rc::Rc::new(features);
				for slot in &mut char_feat[begin..end] {
					*slot = Some(shared.clone());
				}
			}
		}
		let mut channel = Channel::zeros(self.dim(), pieces.len());
		for (i, piece) in pieces.iter().enumerate() {
			let first = (piece.begin..piece.end).find(|&c| c < raw.len() && !is_space(raw[c]));
			if let Some(features) = first.and_then(|c| char_feat[c].as_ref()) {
				channel.set(i, features, 1.0);
			}
		}
		channel
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_vector_renormalizes_over_in_set_mass_in_f64() {
		let lookup = AnchorLookup::from_json(
			r#"{"05401": [{"US": 1.0, "CA": 1, "XX": 0.5}, 44.4759, -73.2121, "wof"]}"#,
			"test",
		)
		.unwrap();
		let locales: Vec<String> = ["US", "FR", "DE", "CA"].iter().map(|s| s.to_string()).collect();
		let slots = lookup.locale_slots(&locales);
		let v = lookup.features("05401", &slots, locales.len()).unwrap();
		assert_eq!(v[..4], [0.5, 0.0, 0.0, 0.5]);
		assert_eq!(v[4], 44.4759 / 90.0);
		assert_eq!(v[5], -73.2121 / 180.0);
	}

	#[test]
	fn a_repeated_posterior_key_keeps_its_first_position_and_last_value() {
		let lookup = AnchorLookup::from_json(r#"{"1": [{"US": 1, "FR": 1, "US": 3}, 0, 0]}"#, "test").unwrap();
		let entry = &lookup.entries["1"];
		assert_eq!(entry.posterior.len(), 2);
		assert_eq!(entry.posterior[0].1, 3.0);
	}

	#[test]
	fn a_nan_clamps_to_one_as_python_min_and_max_do() {
		assert_eq!(clamp_unit(f64::NAN), 1.0);
		assert_eq!(clamp_unit(-3.0), -1.0);
		assert_eq!(clamp_unit(0.25), 0.25);
	}

	#[test]
	fn the_gb_unit_key_shape_follows_python_re() {
		let k = |s: &str| s.chars().collect::<Vec<_>>();
		assert!(is_gb_unit_key(&k("SW1A2AA")));
		assert!(is_gb_unit_key(&k("M11AA")));
		assert!(is_gb_unit_key(&k("SW1A2AA\n")));
		assert!(!is_gb_unit_key(&k("SW1A2A")));
		assert!(is_gb_unit_key(&k("M1١AA")));
	}

	#[test]
	fn a_truncated_table_is_an_error() {
		assert!(AnchorLookup::from_json(r#"{"1": [{"US": 1}, 0]}"#, "t").is_err());
		assert!(AnchorLookup::from_json(r#"{"1": [{"US": 1}, 0, 0]} x"#, "t").is_err());
	}
}
