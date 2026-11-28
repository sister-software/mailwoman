// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Each training row's reading, the outcome head's target (`docs/engineering/reference/outcome-kinds.mdx`).
//!
//! `outcome_readings.json` maps a corpus source to the identity top level its recipe renders, and orders the head's
//! classes and the hint's classes. A corpus's mask file, which `tools/training/outcomes/masks.run.ts` writes from the
//! corpus, lists the `geonames-features` ids whose GeoNames class has no reading and the folded single-span surfaces
//! that rows of two readings or more share.
//!
//! A row's id is its reading's index in `head_classes`, or [`IGNORE_INDEX`] when the row is masked:
//!
//! - its one span is a postcode, an input the recognizer answers;
//! - its source's reading is `unknown`, or its GeoNames class maps to no reading;
//! - it is one span whose folded surface the mask file lists. The soft target such a row needs weighs each entity by
//!   its sitelinks, and the corpus holds no sitelink count, so the row gives the head zero signal.

use crate::{fail, Result};
use mtf_sampler::Row;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use trainer_model::encoder::IGNORE_INDEX;

/// The reading a source's entry names for a row the head's loss masks.
const UNKNOWN: &str = "unknown";

#[derive(Deserialize)]
struct Table {
	definitions: serde_json::Value,
	head_classes: Vec<String>,
	hint_classes: Vec<String>,
	family_prefixes: HashMap<String, String>,
	geonames_natural_classes: Vec<String>,
	sources: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Masks {
	geonames_unknown_class_ids: Vec<i64>,
	shared_surfaces: Vec<String>,
}

/// The reading table and one corpus's masks.
pub struct OutcomeReadings {
	/// `{"revision", "sha256"}` of the outcome definitions the class lists follow.
	pub definitions: serde_json::Value,
	pub head_classes: Vec<String>,
	pub hint_classes: Vec<String>,
	/// Each head class's index in `hint_classes`.
	pub head_hint_index: Vec<i64>,
	sources: HashMap<String, i64>,
	prefixes: Vec<(String, i64)>,
	geonames_unknown: HashSet<i64>,
	shared: HashSet<String>,
}

fn read(path: &Path) -> Result<String> {
	std::fs::read_to_string(path).map_err(|e| fail!("{}: {e}", path.display()))
}

/// The surface key the mask file holds: DuckDB's `lower(regexp_replace(trim(raw), '\s+', ' ', 'g'))`, which trims
/// spaces and collapses each run of RE2's `\s` (tab, newline, form feed, carriage return, space) to one space.
pub fn fold_surface(raw: &str) -> String {
	let trimmed = raw.trim_matches(' ');
	let mut out = String::with_capacity(trimmed.len());
	let mut in_space = false;
	for c in trimmed.chars() {
		if matches!(c, ' ' | '\t' | '\n' | '\x0C' | '\r') {
			if !in_space {
				out.push(' ');
			}
			in_space = true;
		} else {
			out.push(c);
			in_space = false;
		}
	}
	out.to_lowercase()
}

/// The GeoNames id of a `geonames-features` row, from its `geonames-features-<id>-<slot>` source id.
fn geonames_id(source_id: &str) -> Option<i64> {
	source_id
		.strip_prefix("geonames-features-")?
		.split('-')
		.next()?
		.parse()
		.ok()
}

impl OutcomeReadings {
	pub fn load(table: &Path, masks: &Path) -> Result<Self> {
		let t: Table = serde_json::from_str(&read(table)?).map_err(|e| fail!("{}: {e}", table.display()))?;
		let m: Masks = serde_json::from_str(&read(masks)?).map_err(|e| fail!("{}: {e}", masks.display()))?;
		let class = |reading: &str| -> Result<i64> {
			if reading == UNKNOWN {
				return Ok(IGNORE_INDEX);
			}
			t.head_classes
				.iter()
				.position(|c| c == reading)
				.map(|i| i as i64)
				.ok_or_else(|| fail!("{}: reading {reading:?} is not a head class", table.display()))
		};
		let head_hint_index = t
			.head_classes
			.iter()
			.map(|c| {
				t.hint_classes
					.iter()
					.position(|h| h == c)
					.map(|i| i as i64)
					.ok_or_else(|| fail!("{}: head class {c:?} is not a hint class", table.display()))
			})
			.collect::<Result<_>>()?;
		if t.geonames_natural_classes.is_empty() {
			return Err(fail!("{}: geonames_natural_classes is empty", table.display()));
		}
		let mut prefixes = t
			.family_prefixes
			.iter()
			.map(|(p, r)| Ok((p.clone(), class(r)?)))
			.collect::<Result<Vec<_>>>()?;
		prefixes.sort();
		Ok(Self {
			sources: t
				.sources
				.iter()
				.map(|(s, r)| Ok((s.clone(), class(r)?)))
				.collect::<Result<_>>()?,
			prefixes,
			head_hint_index,
			definitions: t.definitions,
			head_classes: t.head_classes,
			hint_classes: t.hint_classes,
			geonames_unknown: m.geonames_unknown_class_ids.into_iter().collect(),
			shared: m.shared_surfaces.into_iter().collect(),
		})
	}

	/// The source's reading, refusing a source the table doesn't map.
	fn source_class(&self, source: &str) -> Result<i64> {
		if let Some(&c) = self.sources.get(source) {
			return Ok(c);
		}
		self.prefixes
			.iter()
			.find(|(p, _)| source.starts_with(p.as_str()))
			.map(|(_, c)| *c)
			.ok_or_else(|| fail!("outcome_readings.json maps no reading for source {source:?}"))
	}

	/// The row's head class, or [`IGNORE_INDEX`] for a masked row.
	pub fn id(&self, row: &Row) -> Result<i64> {
		let class = self.source_class(&row.source)?;
		if class == IGNORE_INDEX {
			return Ok(IGNORE_INDEX);
		}
		let tags = row.span_triple()?.map(|s| s.tags.as_slice()).unwrap_or_default();
		if tags.len() == 1 && tags[0] == "postcode" {
			return Ok(IGNORE_INDEX);
		}
		if row.source == "geonames-features" {
			let id = row
				.source_id
				.as_deref()
				.and_then(geonames_id)
				.ok_or_else(|| fail!("a geonames-features row has no GeoNames id: {:?}", row.source_id))?;
			if self.geonames_unknown.contains(&id) {
				return Ok(IGNORE_INDEX);
			}
		}
		if tags.len() == 1 && self.shared.contains(&fold_surface(&row.raw)) {
			return Ok(IGNORE_INDEX);
		}
		Ok(class)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn folds_as_the_mask_writer_does() {
		assert_eq!(fold_surface("  Mt.\t\tTabor  "), "mt. tabor");
		assert_eq!(fold_surface("MOUNT  TABOR"), "mount tabor");
	}

	#[test]
	fn reads_the_geonames_id() {
		assert_eq!(geonames_id("geonames-features-6776906-v+case-upper"), Some(6776906));
		assert_eq!(geonames_id("wof-admin-1"), None);
	}
}
