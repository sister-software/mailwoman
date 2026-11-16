// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The postal finders: the spans of a line, and the refusals that keep an encoder from reading an artifact it was not
//! built against.

#![cfg(feature = "finders")]

use mtf_channels::finders::{PostalFinders, POSTAL_DECLARATIONS_HASH};
use serde_json::Value;
use std::path::PathBuf;

const ARTIFACT: &str = "../../../postcode/data/artifacts/postal.rca1";
const DEFINITION: &str = "../../../postcode/data/definitions/postal.definition.json";
const MANIFEST: &str = "../../../postcode/data/manifests/postal.json";

fn path(relative: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn text(relative: &str) -> String {
	std::fs::read_to_string(path(relative)).unwrap_or_else(|e| panic!("cannot read {relative}: {e}"))
}

fn bytes() -> Vec<u8> {
	std::fs::read(path(ARTIFACT)).unwrap()
}

fn finders() -> PostalFinders {
	PostalFinders::load(&bytes(), ARTIFACT, &text(DEFINITION), DEFINITION).unwrap()
}

fn refusal(result: Result<PostalFinders, mtf_channels::Error>) -> String {
	match result {
		Ok(_) => panic!("the finder loaded"),
		Err(error) => error.to_string(),
	}
}

#[test]
fn the_pinned_declarations_hash_is_the_committed_artifacts() {
	let manifest: Value = serde_json::from_str(&text(MANIFEST)).unwrap();
	assert_eq!(
		manifest["families"]["postal"]["declarationsHash"], POSTAL_DECLARATIONS_HASH,
		"regenerating the postal family changed its declarations; pin the new hash in finders.rs after reading what changed"
	);
}

#[test]
fn candidates_are_the_codes_of_a_line_longest_first() {
	let finders = finders();
	let spans = |raw: &str| finders.postcode_spans(raw).unwrap();
	let slice = |raw: &str| -> Vec<String> {
		let chars: Vec<char> = raw.chars().collect();
		spans(raw)
			.into_iter()
			.map(|(a, b)| chars[a..b].iter().collect())
			.collect()
	};
	assert!(slice("10 Downing St, London sw1a 2aa").contains(&"sw1a 2aa".to_string()));
	assert!(slice("350 5th Ave, New York, NY 10118-0110").contains(&"10118-0110".to_string()));
	// A printed prefix is outside the span, and so is the white space after it.
	assert_eq!(slice("〒 100-0001 東京都"), vec!["100-0001"]);
	assert!(spans("").is_empty());
	let found = spans("D02 AF30 Dublin 12345");
	assert!(
		found
			.windows(2)
			.all(|pair| pair[0].1 - pair[0].0 >= pair[1].1 - pair[1].0),
		"candidates come longest first"
	);
	// A state abbreviation and its ZIP code form a longer candidate that overlaps the ZIP code, and both are listed.
	let both = slice("Burlington, VT 05401 USA");
	assert_eq!(both[0], "VT 05401");
	assert!(both.contains(&"05401".to_string()));
	// A piece a connector separates from a longer code is the longer code's, and a code after a connector alone stands.
	let cep = slice("RUA SEM DENOMINACAO 1, 270, Parintins, 69152-656");
	assert!(
		cep.contains(&"69152-656".to_string()) && !cep.contains(&"69152".to_string()),
		"{cep:?}"
	);
	assert!(slice("Model Town, Lahore-54000").contains(&"54000".to_string()));
}

#[test]
fn an_artifact_that_is_not_the_postal_family_is_refused_with_its_path() {
	let legacy = std::fs::read(path("../../../postcode/data/artifacts/postcode_legacy.rca1")).unwrap();
	let message = refusal(PostalFinders::load(
		&legacy,
		"legacy.rca1",
		&text(DEFINITION),
		DEFINITION,
	));
	assert!(message.contains("legacy.rca1"), "{message}");
}

#[test]
fn a_corrupt_artifact_is_refused_with_its_path() {
	let mut corrupt = bytes();
	corrupt.truncate(corrupt.len() / 2);
	let message = refusal(PostalFinders::load(&corrupt, ARTIFACT, &text(DEFINITION), DEFINITION));
	assert!(message.contains(ARTIFACT), "{message}");
}

#[test]
fn a_definition_that_lacks_a_shape_of_the_artifact_is_refused_with_its_path() {
	let mut definition: Value = serde_json::from_str(&text(DEFINITION)).unwrap();
	definition["shapes"].as_array_mut().unwrap().remove(0);
	let message = refusal(PostalFinders::load(
		&bytes(),
		ARTIFACT,
		&definition.to_string(),
		"definition.json",
	));
	assert!(message.contains("definition.json"), "{message}");
}

#[test]
fn a_definition_with_a_shape_the_artifact_lacks_is_refused_with_its_path() {
	let mut definition: Value = serde_json::from_str(&text(DEFINITION)).unwrap();
	let mut extra = definition["shapes"][0].clone();
	extra["id"] = "postal.zz".into();
	definition["shapes"].as_array_mut().unwrap().push(extra);
	let message = refusal(PostalFinders::load(
		&bytes(),
		ARTIFACT,
		&definition.to_string(),
		"definition.json",
	));
	assert!(
		message.contains("definition.json") && message.contains("postal.zz"),
		"{message}"
	);
}

#[test]
fn an_unreadable_definition_is_refused_with_its_path() {
	let message = refusal(PostalFinders::load(&bytes(), ARTIFACT, "{", "definition.json"));
	assert!(message.contains("definition.json"), "{message}");
}
