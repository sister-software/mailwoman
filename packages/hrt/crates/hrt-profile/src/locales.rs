// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from the basemaps fork's locales package (BSD-3-Clause, Protomaps).

//! Country-specific cartographic rules, chosen by the country a feature lies in.
//!
//! The base locale normalizes nothing and ranks every route network equally. A country module overrides how its route
//! networks normalize and rank for shield ordering. Locales are found through [`LOCALES`], so a country's rule lives in
//! its own module.

pub mod nl;
pub mod us;

/// A route shield: its text and network.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Shield {
	pub text: Option<String>,
	pub network: Option<String>,
}

/// The most shields a road carries.
pub const MAX_SHIELDS: usize = 6;
/// The rank of a network a locale does not prioritize.
pub const DEFAULT_RANK: usize = 1000;

/// A country's cartographic rules.
pub trait Locale: Sync {
	/// Maps a raw route network to the network its shield uses.
	fn normalize_network(&self, network: &str) -> String {
		network.to_owned()
	}

	/// The priority of a network among a road's shields; lower comes first.
	fn network_rank(&self, _network: Option<&str>) -> usize {
		DEFAULT_RANK
	}
}

/// The base locale, for features outside every implemented country.
pub struct Base;

impl Locale for Base {}

/// The implemented locales by two-letter country code.
pub static LOCALES: [(&str, &dyn Locale); 2] = [("US", &us::Us), ("NL", &nl::Nl)];

/// Returns the locale for a country code, or the base locale.
pub fn locale_for(code: Option<&str>) -> &'static dyn Locale {
	code.and_then(|code| {
		LOCALES
			.iter()
			.find(|(candidate, _)| *candidate == code)
			.map(|(_, locale)| *locale)
	})
	.unwrap_or(&Base)
}

/// Java's `replaceAll("\\s", "")`: removes the six ASCII whitespace characters `\s` matches in Java.
fn strip(text: &str) -> String {
	text.chars()
		.filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r'))
		.collect()
}

/// The fork's `orderShields`: shields with text, whitespace stripped, de-duplicated in first-seen order, sorted by
/// network rank and then text, and capped at [`MAX_SHIELDS`].
pub fn order_shields(locale: &dyn Locale, shields: &[Shield]) -> Vec<Shield> {
	let mut deduped: Vec<Shield> = Vec::new();
	for shield in shields {
		let Some(text) = shield.text.as_deref() else {
			continue;
		};
		let normalized = Shield {
			text: Some(strip(text)),
			network: shield.network.clone(),
		};
		if !deduped.contains(&normalized) {
			deduped.push(normalized);
		}
	}
	deduped.sort_by(|a, b| {
		locale
			.network_rank(a.network.as_deref())
			.cmp(&locale.network_rank(b.network.as_deref()))
			.then_with(|| java_compare(a.text.as_deref().unwrap_or(""), b.text.as_deref().unwrap_or("")))
	});
	deduped.truncate(MAX_SHIELDS);
	deduped
}

/// Java's `String.compareTo`, which compares UTF-16 code units.
fn java_compare(a: &str, b: &str) -> std::cmp::Ordering {
	a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn us_shields_order_interstate_first_and_drop_duplicates() {
		let shields = [
			Shield {
				text: Some("CO 470".into()),
				network: Some("US:CO".into()),
			},
			Shield {
				text: Some("70".into()),
				network: Some("US:I".into()),
			},
			Shield {
				text: Some("70".into()),
				network: Some("US:I".into()),
			},
			Shield {
				text: None,
				network: Some("US:US".into()),
			},
		];
		let ordered = order_shields(locale_for(Some("US")), &shields);
		assert_eq!(ordered.len(), 2);
		assert_eq!(ordered[0].network.as_deref(), Some("US:I"));
		assert_eq!(ordered[1].text.as_deref(), Some("CO470"));
	}
}
