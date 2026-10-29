// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Read the label schema that `@mailwoman/neural` writes from its TypeScript label constants.
//!
//! The schema is `packages/neural/data/label-schema.v1.json`. Each label set lists its tags in order and their BIO
//! expansion, and a label's index in that expansion is the model's output index for it.

use crate::error::Error;
use crate::labels::LabelTable;
use serde_json::Value;
use std::collections::HashMap;

/// The schema layout version this reader reads.
pub const LABEL_SCHEMA_VERSION: u64 = 1;

/// One label set: its tags in order and their BIO labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelSet {
	pub tags: Vec<String>,
	pub bio_labels: Vec<String>,
}

/// The label schema: every label set by name, the default set, the ignore index, the locale-head countries and the
/// tags each locale's address system forbids.
#[derive(Debug, Clone)]
pub struct LabelSchema {
	pub default_label_set: String,
	pub ignore_index: i64,
	pub locale_countries: Vec<String>,
	pub label_sets: HashMap<String, LabelSet>,
	/// `conventions_forbidden_tags`: the tags the conventions loss mask forbids, for each locale country that has any.
	pub conventions_forbidden_tags: HashMap<String, Vec<String>>,
}

fn strings(value: &Value, field: &str) -> Result<Vec<String>, Error> {
	value
		.as_array()
		.ok_or_else(|| Error::Input(format!("label schema: {field} is not an array")))?
		.iter()
		.map(|item| {
			item.as_str()
				.map(str::to_owned)
				.ok_or_else(|| Error::Input(format!("label schema: {field} holds a non-string")))
		})
		.collect()
}

impl LabelSchema {
	/// Parses the schema, refusing another layout version and a set whose BIO labels are not its tags' expansion.
	pub fn from_json(text: &str) -> Result<Self, Error> {
		let doc: Value = serde_json::from_str(text).map_err(|e| Error::Input(format!("label schema: {e}")))?;
		let version = doc.get("schema_version").and_then(Value::as_u64);
		if version != Some(LABEL_SCHEMA_VERSION) {
			return Err(Error::Input(format!(
				"label schema: schema_version {version:?}, this reader reads {LABEL_SCHEMA_VERSION}"
			)));
		}
		let field = |name: &str| {
			doc.get(name)
				.ok_or_else(|| Error::Input(format!("label schema: no {name}")))
		};
		let sets = field("label_sets")?
			.as_object()
			.ok_or_else(|| Error::Input("label schema: label_sets is not an object".to_owned()))?;
		let mut label_sets = HashMap::with_capacity(sets.len());
		for (name, set) in sets {
			let tags = strings(set.get("tags").unwrap_or(&Value::Null), &format!("{name}.tags"))?;
			let bio_labels = strings(
				set.get("bio_labels").unwrap_or(&Value::Null),
				&format!("{name}.bio_labels"),
			)?;
			let expected: Vec<String> = std::iter::once("O".to_owned())
				.chain(tags.iter().flat_map(|tag| [format!("B-{tag}"), format!("I-{tag}")]))
				.collect();
			if bio_labels != expected {
				return Err(Error::Input(format!(
					"label schema: {name}.bio_labels is not the BIO expansion of its tags"
				)));
			}
			label_sets.insert(name.clone(), LabelSet { tags, bio_labels });
		}
		let default_label_set = field("default_label_set")?
			.as_str()
			.ok_or_else(|| Error::Input("label schema: default_label_set is not a string".to_owned()))?
			.to_owned();
		if !label_sets.contains_key(&default_label_set) {
			return Err(Error::Input(format!(
				"label schema: default set {default_label_set:?} is not defined"
			)));
		}
		let locale_countries = strings(field("locale_countries")?, "locale_countries")?;
		let conventions = field("conventions_forbidden_tags")?
			.as_object()
			.ok_or_else(|| Error::Input("label schema: conventions_forbidden_tags is not an object".to_owned()))?;
		let mut conventions_forbidden_tags = HashMap::with_capacity(conventions.len());
		for (country, tags) in conventions {
			if !locale_countries.contains(country) {
				return Err(Error::Input(format!(
					"label schema: conventions_forbidden_tags names {country}, which is not a locale country"
				)));
			}
			let tags = strings(tags, &format!("conventions_forbidden_tags.{country}"))?;
			conventions_forbidden_tags.insert(country.clone(), tags);
		}
		Ok(Self {
			default_label_set,
			ignore_index: field("ignore_index")?
				.as_i64()
				.ok_or_else(|| Error::Input("label schema: ignore_index is not an integer".to_owned()))?,
			locale_countries,
			label_sets,
			conventions_forbidden_tags,
		})
	}

	/// The conventions table in locale-head order: each locale country's forbidden tags, empty for a country without
	/// a row.
	pub fn conventions_by_locale(&self) -> Vec<Vec<String>> {
		self.locale_countries
			.iter()
			.map(|c| self.conventions_forbidden_tags.get(c).cloned().unwrap_or_default())
			.collect()
	}

	/// The label set `name`, or an error naming the sets that exist.
	pub fn set(&self, name: &str) -> Result<&LabelSet, Error> {
		self.label_sets.get(name).ok_or_else(|| {
			let mut names: Vec<&str> = self.label_sets.keys().map(String::as_str).collect();
			names.sort_unstable();
			Error::Input(format!(
				"label schema: unknown label set {name:?} (defined: {})",
				names.join(", ")
			))
		})
	}

	/// The encoder's label table for the set `name`, with ids taken from the set's BIO order.
	pub fn label_table(&self, name: &str) -> Result<LabelTable, Error> {
		let set = self.set(name)?;
		let label_to_id: HashMap<String, i64> = set
			.bio_labels
			.iter()
			.enumerate()
			.map(|(i, label)| (label.clone(), i as i64))
			.collect();
		LabelTable::new(&label_to_id, &set.tags, self.ignore_index)
	}
}
