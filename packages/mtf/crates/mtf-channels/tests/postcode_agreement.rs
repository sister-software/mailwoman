// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The encoder's postcode finder finds, in every row of `test/fixtures/postcode-agreement.json`, the candidates serving's
//! `findPostcodeSpans` found.
//!
//! The fixture holds rows of the v8.7.0 config's train and validation draws with the spans serving returned, in the order
//! they compete. `packages/postcode/lib/postal-spans.test.ts` replays the same file against serving, so the two finders
//! agree through it. `packages/mailwoman/tools/training/sampler/postcode-agreement.run.ts` compares them over the
//! whole draw and regenerates the fixture.

#![cfg(feature = "finders")]

use mtf_channels::finders::PostalFinders;
use serde_json::Value;
use std::path::PathBuf;

fn read(relative: &str) -> String {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
	std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

#[test]
fn every_fixture_row_has_the_candidates_serving_found() {
	let artifact = "../../../postcode/data/artifacts/postal.rca1";
	let definition = "../../../postcode/data/definitions/postal.definition.json";
	let bytes = std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(artifact)).unwrap();
	let finders = PostalFinders::load(&bytes, artifact, &read(definition), definition).unwrap();
	let doc: Value = serde_json::from_str(&read("../../../../test/fixtures/postcode-agreement.json")).unwrap();
	let rows = doc["rows"].as_array().unwrap();
	assert!(rows.len() >= 1000, "the fixture holds {} rows", rows.len());
	let mut with_spans = 0;
	for row in rows {
		let raw = row["raw"].as_str().unwrap();
		let expected: Vec<(usize, usize)> = row["spans"]
			.as_array()
			.unwrap()
			.iter()
			.map(|s| (s[0].as_u64().unwrap() as usize, s[1].as_u64().unwrap() as usize))
			.collect();
		// The fixture's offsets are UTF-16 code units and the finder's are characters. The sampler skips astral rows, so
		// the two agree on every row the fixture holds.
		assert!(
			raw.chars().all(|c| c.len_utf16() == 1),
			"an astral row in the fixture: {raw:?}"
		);
		assert_eq!(finders.postcode_spans(raw).unwrap(), expected, "candidates of {raw:?}");
		if !expected.is_empty() {
			with_spans += 1;
		}
	}
	assert!(with_spans > 500, "only {with_spans} fixture rows hold a candidate");
}
