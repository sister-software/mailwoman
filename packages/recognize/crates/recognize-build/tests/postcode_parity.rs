// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Parity with `@mailwoman/postcode`'s prefix automaton.
//!
//! `data/fixtures/postcode-prefix-parity.json` holds, for several countries, the strings `PrefixAutomaton.canComplete`
//! answers yes to and the strings the country's `RegExp` matches whole, over every string up to a length on a small
//! alphabet and over the prefixes of example postcodes. The fixture is written by
//! `packages/mailwoman/tools/dev-tools/recognize/prefix-parity.run.ts`.
//!
//! This test compiles each country's pattern as a regular-expression string grammar, the anchors stripped and the scope
//! `Whole`, and compares: `PrefixAutomaton` says yes exactly when the status is anything but `Dead`, and the `RegExp`
//! says yes exactly when the status is `Accepted` or `AcceptedAndExtendable`. The compiler refuses a case-insensitive
//! Unicode class that the JavaScript pattern's `iu` flags would build, so the grammar is `(?i-u:...)`: ASCII case folding,
//! ASCII `\d`, `\s` and `\w`. Every probe is ASCII, where the two agree on what those classes hold.

mod support;

use std::collections::BTreeSet;
use std::path::PathBuf;

use recognize_core::{Family, PrefixStatus, Scope};
use serde_json::Value;

use support::{engine_for, strings_up_to};

fn fixture() -> Value {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/fixtures/postcode-prefix-parity.json");

	serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
		.expect("the fixture is JSON")
}

fn set_of(entry: &Value, key: &str) -> BTreeSet<String> {
	entry[key]
		.as_array()
		.unwrap_or_else(|| panic!("`{key}` is an array"))
		.iter()
		.map(|text| text.as_str().expect("a string").to_string())
		.collect()
}

/// One disagreement: the country, the input, what each side said, and which side the regular expression supports.
struct Disagreement {
	country: String,
	input: String,
	postcode_completable: bool,
	recognize_status: PrefixStatus,
	regexp_accepts: bool,
}

#[test]
fn the_prefix_answers_agree_with_the_postcode_package() {
	let fixture = fixture();
	let countries = fixture["countries"].as_array().expect("countries");
	let mut family = Family::new("parity");

	for entry in countries {
		let country = entry["country"].as_str().unwrap().to_lowercase();
		let grammar = format!("(?i-u:{})", entry["pattern"].as_str().unwrap());

		family = family.shape(
			recognize_core::shape(&format!("parity.{country}"))
				.regex(&grammar)
				.scope(Scope::Whole),
		);
	}

	let engine = engine_for(vec![family]);
	let mut compared = 0usize;
	let mut agreements = 0usize;
	let mut disagreements: Vec<Disagreement> = Vec::new();

	for entry in countries {
		let country = entry["country"].as_str().unwrap();
		let shape = format!("parity.{}", country.to_lowercase());
		let alphabet: Vec<char> = entry["alphabet"].as_str().unwrap().chars().collect();
		let completable = set_of(entry, "completable");
		let accepted = set_of(entry, "accepted");
		let mut inputs: BTreeSet<String> = strings_up_to(&alphabet, entry["maxLength"].as_u64().unwrap() as usize)
			.into_iter()
			.collect();

		inputs.extend(set_of(entry, "probes"));

		for input in inputs {
			let status = engine
				.prefix_status(&input)
				.expect("the prefix status runs")
				.into_iter()
				.find(|found| found.shape == shape)
				.expect("the shape has a status")
				.status;

			assert_ne!(status, PrefixStatus::Unknown, "{country} {input:?}");

			let postcode_completable = completable.contains(&input);
			let regexp_accepts = accepted.contains(&input);
			let recognize_completable = status.can_complete();
			let recognize_accepts = matches!(status, PrefixStatus::Accepted | PrefixStatus::AcceptedAndExtendable);

			compared += 1;

			if postcode_completable == recognize_completable && regexp_accepts == recognize_accepts {
				agreements += 1;
			} else {
				disagreements.push(Disagreement {
					country: country.to_string(),
					input,
					postcode_completable,
					recognize_status: status,
					regexp_accepts,
				});
			}
		}
	}

	let report: Vec<String> = disagreements
		.iter()
		.map(|found| {
			format!(
				"{} {:?}: PrefixAutomaton canComplete={}, RegExp accepts={}, recognize {}",
				found.country,
				found.input,
				found.postcode_completable,
				found.regexp_accepts,
				found.recognize_status.as_str()
			)
		})
		.collect();

	println!(
		"compared {compared}, agreed {agreements}, disagreed {}",
		disagreements.len()
	);

	assert!(compared > 20_000, "the fixture holds only {compared} inputs");
	assert!(
		report.is_empty(),
		"{} disagreements:\n{}",
		report.len(),
		report.join("\n")
	);
}
