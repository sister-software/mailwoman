// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Parity with `@mailwoman/postcode`'s prefix automaton, over every country the `postal` family holds.
//!
//! `data/fixtures/postcode-prefix-parity.json` holds, for each country, the strings `PrefixAutomaton.canComplete`
//! answers yes to, the strings the country's `RegExp` matches whole, and for a country whose layout prints a prefix the
//! answers of the printed branch of `canComplete`, over every string up to a length on a small alphabet, over the
//! prefixes of example postcodes, and over the prefixes of inputs built to probe non-ASCII text. The fixture is written by
//! `packages/mailwoman/tools/dev-tools/recognize/prefix-parity.run.ts`.
//!
//! This test loads the committed `postal` artifact, which `@mailwoman/postcode` compiles from the same syntax, and
//! compares: `PrefixAutomaton` says yes exactly when the bare shape's status is anything but `Dead`, and the `RegExp`
//! says yes exactly when the status is `Accepted` or `AcceptedAndExtendable`. The same holds for the printed shape and
//! the printed branch. The fixture holds the answer of each side, so a disagreement names the input and both answers.

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use recognize_core::{Engine, PrefixStatus};
use serde_json::Value;

use support::strings_up_to;

fn data_path(segments: &[&str]) -> PathBuf {
	let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../");

	path.extend(segments);

	path
}

fn fixture() -> Value {
	let path = data_path(&["data", "fixtures", "postcode-prefix-parity.json"]);

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

/// One disagreement: the country, the form, the input, what each side said.
struct Disagreement {
	country: String,
	form: &'static str,
	input: String,
	postcode_completable: bool,
	regexp_accepts: bool,
	recognize_status: PrefixStatus,
}

fn status_of(engine: &Engine, input: &str) -> BTreeMap<String, PrefixStatus> {
	let mut found = BTreeMap::new();

	// A whole-or-embedded shape is listed once for each automaton, and the whole-input automaton comes first.
	for shape in engine.prefix_status(input).expect("the prefix status runs") {
		found.entry(shape.shape.to_string()).or_insert(shape.status);
	}

	found
}

#[test]
fn the_prefix_answers_agree_with_the_postcode_package_for_every_country() {
	let fixture = fixture();
	let countries = fixture["countries"].as_array().expect("countries");
	let mut engine = Engine::new();

	engine
		.load(&std::fs::read(data_path(&["..", "postcode", "data", "artifacts", "postal.rca1"])).expect("the artifact"))
		.expect("the postal artifact loads");

	let mut compared = 0usize;
	let mut agreements = 0usize;
	let mut disagreements: Vec<Disagreement> = Vec::new();
	let mut printed_countries = 0usize;

	for entry in countries {
		let country = entry["country"].as_str().unwrap();
		let alphabet: Vec<char> = entry["alphabet"].as_str().unwrap().chars().collect();
		let mut inputs: BTreeSet<String> = strings_up_to(&alphabet, entry["maxLength"].as_u64().unwrap() as usize)
			.into_iter()
			.collect();

		inputs.extend(set_of(entry, "probes"));

		let forms: Vec<(&'static str, &str, BTreeSet<String>, BTreeSet<String>)> = {
			let mut forms = vec![(
				"bare",
				entry["shape"].as_str().unwrap(),
				set_of(entry, "completable"),
				set_of(entry, "accepted"),
			)];

			if let Some(printed) = entry["printedShape"].as_str() {
				printed_countries += 1;
				forms.push((
					"printed",
					printed,
					set_of(entry, "printedCompletable"),
					set_of(entry, "printedAccepted"),
				));
			}

			forms
		};

		for input in inputs {
			let statuses = status_of(&engine, &input);

			for (form, shape, completable, accepted) in &forms {
				let status = *statuses.get(*shape).unwrap_or_else(|| panic!("{shape} has no status"));

				assert_ne!(status, PrefixStatus::Unknown, "{country} {input:?}");

				let postcode_completable = completable.contains(&input);
				let regexp_accepts = accepted.contains(&input);
				let recognize_accepts = matches!(status, PrefixStatus::Accepted | PrefixStatus::AcceptedAndExtendable);

				compared += 1;

				if postcode_completable == status.can_complete() && regexp_accepts == recognize_accepts {
					agreements += 1;
				} else {
					disagreements.push(Disagreement {
						country: country.to_string(),
						form,
						input: input.clone(),
						postcode_completable,
						regexp_accepts,
						recognize_status: status,
					});
				}
			}
		}
	}

	// The one known class of disagreement. `PrefixAutomaton` folds case over ASCII only, so it refuses a text with the
	// Kelvin sign (U+212A) or the long s (U+017F), which JavaScript's `iu` flags treat as `k` and `s`, and it refuses
	// each prefix of a text the country's `RegExp` accepts whole. The engine agrees with the `RegExp`: it accepts the
	// whole text and holds each prefix of it viable. The disagreement is a defect of `PrefixAutomaton` and is not
	// fixed here, because the serving implementation stays as it is. The test holds the class to this exact shape: the
	// text holds one of the two characters, `PrefixAutomaton` says no, the engine says yes, and the text is an accepted
	// text of the country or a prefix of one.
	let accepted_by_country: BTreeMap<String, BTreeSet<String>> = countries
		.iter()
		.map(|entry| {
			(
				entry["country"].as_str().unwrap().to_string(),
				set_of(entry, "accepted"),
			)
		})
		.collect();
	let (known, disagreements): (Vec<Disagreement>, Vec<Disagreement>) = disagreements.into_iter().partition(|found| {
		found.input.contains(['\u{212A}', '\u{17F}'])
			&& !found.postcode_completable
			&& found.recognize_status.can_complete()
			&& found.form == "bare"
			&& accepted_by_country[&found.country]
				.iter()
				.any(|whole| whole.starts_with(&found.input))
	});
	let known_countries: BTreeSet<&str> = known.iter().map(|found| found.country.as_str()).collect();

	println!(
		"PrefixAutomaton defect, Kelvin sign and long s: {} inputs in {} countries: {:?}",
		known.len(),
		known_countries.len(),
		known_countries
	);

	let report: Vec<String> = disagreements
		.iter()
		.map(|found| {
			format!(
				"{} {} {:?}: postcode canComplete={}, RegExp accepts={}, recognize {}",
				found.country,
				found.form,
				found.input,
				found.postcode_completable,
				found.regexp_accepts,
				found.recognize_status.as_str()
			)
		})
		.collect();

	println!(
		"countries {}, printed countries {printed_countries}, compared {compared}, agreed {agreements}, disagreed in the known class {}, disagreed otherwise {}",
		countries.len(),
		known.len(),
		disagreements.len()
	);

	assert_eq!(
		countries.len(),
		181,
		"the fixture holds a country for each postcode syntax"
	);
	assert!(compared > 90_000, "the fixture holds only {compared} comparisons");
	assert!(
		report.is_empty(),
		"{} disagreements:\n{}",
		report.len(),
		report.join("\n")
	);
}
