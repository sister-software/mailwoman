// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The affix-split relabel pass (#511): its split agrees with the affix recipe's `parseStreet`, it rewrites the BIO
//! labels and the span triple alike, it is idempotent, and the lexicon loader refuses a malformed file.
use mtf_sampler::relabel::{relabel_row, relabel_spans, split_street_span, AffixRelabelLexicon};
use mtf_sampler::{Row, SpanTriple};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
	pairs.iter().map(|&(k, v)| (k.to_owned(), v.to_owned())).collect()
}

fn lex() -> AffixRelabelLexicon {
	AffixRelabelLexicon {
		directionals: map(&[
			("n", "N"),
			("north", "N"),
			("s", "S"),
			("south", "S"),
			("e", "E"),
			("east", "E"),
			("w", "W"),
			("west", "W"),
			("ne", "NE"),
			("northeast", "NE"),
			("nw", "NW"),
			("northwest", "NW"),
			("se", "SE"),
			("southeast", "SE"),
			("sw", "SW"),
			("southwest", "SW"),
		]),
		suffixes: map(&[
			("st", "STREET"),
			("street", "STREET"),
			("ave", "AVENUE"),
			("avenue", "AVENUE"),
			("rd", "ROAD"),
			("road", "ROAD"),
			("dr", "DRIVE"),
			("drive", "DRIVE"),
			("park", "PARK"),
			("hill", "HILL"),
			("ln", "LANE"),
			("lane", "LANE"),
		]),
		version: "test".to_owned(),
		// AVENUE is suffix-shaped and deliberately absent: it is not name-prone.
		name_prone: ["PARK", "HILL"].iter().map(|s| (*s).to_owned()).collect(),
	}
}

fn split(text: &str) -> Option<(usize, usize)> {
	split_street_span(&text.split_whitespace().collect::<Vec<_>>(), &lex())
}

fn strings(items: &[&str]) -> Vec<String> {
	items.iter().map(|s| (*s).to_owned()).collect()
}

/// A token-label row; `raw` is its tokens joined by spaces.
fn token_row(tokens: &[&str], labels: &[&str]) -> Row {
	Row {
		raw: tokens.join(" "),
		tokens: strings(tokens),
		labels: strings(labels),
		country: Some("US".to_owned()),
		source: "test".to_owned(),
		spans: None,
	}
}

fn span_row(raw: &str, tokens: &[&str], labels: &[&str], starts: &[i64], ends: &[i64], tags: &[&str]) -> Row {
	Row {
		raw: raw.to_owned(),
		spans: Some(SpanTriple {
			starts: starts.to_vec(),
			ends: ends.to_vec(),
			tags: strings(tags),
		}),
		..token_row(tokens, labels)
	}
}

fn span_texts(row: &Row) -> Vec<(String, String)> {
	let triple = row.spans.as_ref().unwrap();
	triple
		.starts
		.iter()
		.zip(&triple.ends)
		.zip(&triple.tags)
		.map(|((&s, &e), t)| {
			(
				t.clone(),
				row.raw.chars().skip(s as usize).take((e - s) as usize).collect(),
			)
		})
		.collect()
}

fn texts(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
	pairs.iter().map(|&(t, s)| (t.to_owned(), s.to_owned())).collect()
}

#[test]
fn a_prefix_name_and_suffix_split() {
	assert_eq!(split("N Main St"), Some((1, 1)));
}

#[test]
fn a_suffix_alone_splits() {
	assert_eq!(split("Weaver Lane"), Some((0, 1)));
}

#[test]
fn the_split_ignores_case() {
	assert_eq!(split("SOUTH WEAVER LANE"), Some((1, 1)));
}

#[test]
fn a_single_word_never_splits() {
	assert_eq!(split("Broadway"), None);
}

#[test]
fn a_trailing_directional_is_not_a_suffix() {
	assert_eq!(split("South County Road 175 West"), None);
}

#[test]
fn a_directional_name_is_refused() {
	assert_eq!(split("North St"), None);
}

#[test]
fn an_affix_shaped_name_is_refused() {
	assert_eq!(split("W Park Ave"), None);
}

#[test]
fn a_multiword_name_prone_tail_is_licensed_by_the_true_suffix() {
	assert_eq!(split("W Cherry Hill Rd"), Some((1, 1)));
}

#[test]
fn a_period_is_not_stripped() {
	assert_eq!(split("Main St."), None);
}

#[test]
fn an_ordinal_name_splits() {
	assert_eq!(split("E 161st St"), Some((1, 1)));
}

#[test]
fn a_two_word_directional_lead_does_not_split() {
	assert_eq!(split("W St"), None);
}

#[test]
fn an_international_street_is_untouched() {
	assert_eq!(split("Hauptstraße"), None);
	assert_eq!(split("Avenue des Champs-Élysées"), None);
}

#[test]
fn the_bio_labels_split() {
	let mut row = token_row(
		&["1234", "SE", "Division", "St", "Portland", "OR", "97202"],
		&[
			"B-house_number",
			"B-street",
			"I-street",
			"I-street",
			"B-locality",
			"B-region",
			"B-postcode",
		],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		row.labels,
		strings(&[
			"B-house_number",
			"B-street_prefix",
			"B-street",
			"B-street_suffix",
			"B-locality",
			"B-region",
			"B-postcode",
		])
	);
}

#[test]
fn a_multiword_name_keeps_its_bio_chain() {
	let mut row = token_row(
		&["N", "Dixie", "Box", "Road"],
		&["B-street", "I-street", "I-street", "I-street"],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		row.labels,
		strings(&["B-street_prefix", "B-street", "I-street", "B-street_suffix"])
	);
}

#[test]
fn a_street_without_a_suffix_is_untouched() {
	let mut row = token_row(
		&["4550", "South", "County", "Trail", "175", "West"],
		&[
			"B-house_number",
			"B-street",
			"I-street",
			"I-street",
			"I-street",
			"I-street",
		],
	);
	assert!(!relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		row.labels[1..],
		strings(&["B-street", "I-street", "I-street", "I-street", "I-street"])
	);
}

#[test]
fn a_non_street_label_is_untouched() {
	let mut row = token_row(&["Main", "St", "Springfield"], &["B-street", "I-street", "B-locality"]);
	relabel_row(&mut row, &lex()).unwrap();
	assert_eq!(row.labels[2], "B-locality");
}

#[test]
fn both_streets_of_an_intersection_split() {
	let mut row = token_row(
		&["N", "Main", "St", "and", "W", "Oak", "Ave"],
		&[
			"B-street", "I-street", "I-street", "O", "B-street", "I-street", "I-street",
		],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		row.labels,
		strings(&[
			"B-street_prefix",
			"B-street",
			"B-street_suffix",
			"O",
			"B-street_prefix",
			"B-street",
			"B-street_suffix",
		])
	);
}

#[test]
fn an_already_decomposed_street_is_unchanged() {
	let mut row = token_row(&["Menlo", "Park", "Road"], &["B-street", "I-street", "B-street_suffix"]);
	assert!(!relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(row.labels, strings(&["B-street", "I-street", "B-street_suffix"]));
}

#[test]
fn a_second_pass_is_a_no_op() {
	let mut row = token_row(
		&["N", "Dixie", "Box", "Road"],
		&["B-street", "I-street", "I-street", "I-street"],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	let once = row.labels.clone();
	assert!(!relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(row.labels, once);
}

#[test]
fn an_existing_prefix_does_not_block_the_suffix_split() {
	let mut row = token_row(&["N", "Main", "St"], &["B-street_prefix", "B-street", "I-street"]);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(row.labels, strings(&["B-street_prefix", "B-street", "B-street_suffix"]));
}

#[test]
fn the_street_span_splits_by_char_arithmetic() {
	let mut row = span_row(
		"1234 SE Division St, Portland, OR 97202",
		&["1234", "SE", "Division", "St", "Portland", "OR", "97202"],
		&[
			"B-house_number",
			"B-street",
			"I-street",
			"I-street",
			"B-locality",
			"B-region",
			"B-postcode",
		],
		&[0, 5, 21, 31, 34],
		&[4, 19, 29, 33, 39],
		&["house_number", "street", "locality", "region", "postcode"],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		span_texts(&row),
		texts(&[
			("house_number", "1234"),
			("street_prefix", "SE"),
			("street", "Division"),
			("street_suffix", "St"),
			("locality", "Portland"),
			("region", "OR"),
			("postcode", "97202"),
		])
	);
	assert_eq!(
		row.labels[1..4],
		strings(&["B-street_prefix", "B-street", "B-street_suffix"])
	);
}

#[test]
fn a_multiword_name_span_splits() {
	let mut row = span_row(
		"N Dixie Box Road",
		&["N", "Dixie", "Box", "Road"],
		&["B-street", "I-street", "I-street", "I-street"],
		&[0],
		&[16],
		&["street"],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		span_texts(&row),
		texts(&[
			("street_prefix", "N"),
			("street", "Dixie Box"),
			("street_suffix", "Road")
		])
	);
}

#[test]
fn a_span_without_a_split_is_untouched() {
	let mut row = span_row(
		"South County Trail 175 West",
		&["South", "County", "Trail", "175", "West"],
		&["B-street", "I-street", "I-street", "I-street", "I-street"],
		&[0],
		&[27],
		&["street"],
	);
	assert!(!relabel_spans(&mut row, &lex()).unwrap());
	let triple = row.spans.unwrap();
	assert_eq!(
		(triple.starts, triple.ends, triple.tags),
		(vec![0], vec![27], strings(&["street"]))
	);
}

#[test]
fn a_dotted_suffix_stays_whole_on_the_span_path() {
	// The token path sees `St` and splits; the span path sees the word `St.`, which the lexicon lacks.
	let mut row = span_row(
		"Main St.",
		&["Main", "St"],
		&["B-street", "I-street"],
		&[0],
		&[8],
		&["street"],
	);
	relabel_row(&mut row, &lex()).unwrap();
	assert_eq!(row.spans.as_ref().unwrap().tags, strings(&["street"]));
	assert_eq!(row.labels, strings(&["B-street", "B-street_suffix"]));
}

#[test]
fn both_street_spans_of_an_intersection_split() {
	let mut row = span_row(
		"N Main St and W Oak Ave",
		&["N", "Main", "St", "and", "W", "Oak", "Ave"],
		&[
			"B-street", "I-street", "I-street", "O", "B-street", "I-street", "I-street",
		],
		&[0, 14],
		&[9, 23],
		&["street", "street"],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		span_texts(&row),
		texts(&[
			("street_prefix", "N"),
			("street", "Main"),
			("street_suffix", "St"),
			("street_prefix", "W"),
			("street", "Oak"),
			("street_suffix", "Ave"),
		])
	);
}

#[test]
fn a_suffix_span_split_writes_new_offsets() {
	let mut row = span_row(
		"Weaver Lane",
		&["Weaver", "Lane"],
		&["B-street", "I-street"],
		&[0],
		&[11],
		&["street"],
	);
	assert!(relabel_spans(&mut row, &lex()).unwrap());
	assert_eq!(row.spans.unwrap().starts, vec![0, 7]);
}

#[test]
fn a_row_without_spans_relabels_only_its_tokens() {
	let mut row = token_row(&["Weaver", "Lane"], &["B-street", "I-street"]);
	assert!(!relabel_spans(&mut row, &lex()).unwrap());
	assert!(relabel_row(&mut row, &lex()).unwrap(), "the token path still fires");
}

#[test]
fn an_already_decomposed_span_triple_is_unchanged() {
	let mut row = span_row(
		"Menlo Park Road",
		&["Menlo", "Park", "Road"],
		&["B-street", "I-street", "B-street_suffix"],
		&[0, 11],
		&[10, 15],
		&["street", "street_suffix"],
	);
	assert!(!relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		span_texts(&row),
		texts(&[("street", "Menlo Park"), ("street_suffix", "Road")])
	);
}

#[test]
fn a_second_span_pass_is_a_no_op() {
	let mut row = span_row(
		"N Dixie Box Road",
		&["N", "Dixie", "Box", "Road"],
		&["B-street", "I-street", "I-street", "I-street"],
		&[0],
		&[16],
		&["street"],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	let once = row.spans.clone();
	assert!(!relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(row.spans, once);
}

#[test]
fn an_existing_prefix_span_does_not_block_the_suffix_split() {
	let mut row = span_row(
		"N Main St",
		&["N", "Main", "St"],
		&["B-street_prefix", "B-street", "I-street"],
		&[0, 2],
		&[1, 9],
		&["street_prefix", "street"],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		span_texts(&row),
		texts(&[("street_prefix", "N"), ("street", "Main"), ("street_suffix", "St")])
	);
}

#[test]
fn a_missing_lexicon_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let error = AffixRelabelLexicon::load(&dir.path().join("nope.json")).expect_err("an error");
	assert!(error.to_string().contains("not found"), "{error}");
}

#[test]
fn a_lexicon_missing_a_key_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("bad.json");
	std::fs::write(&path, r#"{"directionals": {"n": "N"}}"#).unwrap();
	let error = AffixRelabelLexicon::load(&path).expect_err("an error");
	assert!(error.to_string().contains("missing key"), "{error}");
}

#[test]
fn a_lexicon_with_a_malformed_entry_is_refused_rather_than_shortened() {
	let cases = [
		(
			r#"{"directionals": {"n": 1}, "suffixes": {"st": "ST"}, "version": "x"}"#,
			"maps \"n\" to 1",
		),
		(
			r#"{"directionals": [], "suffixes": {"st": "ST"}, "version": "x"}"#,
			"is not an object",
		),
		(
			r#"{"directionals": {"n": "N"}, "suffixes": {"st": "ST"}, "version": 2}"#,
			"version is 2",
		),
		(
			r#"{"directionals": {"n": "N"}, "suffixes": {"st": "ST"}, "version": "x", "name_prone": ["a", 3]}"#,
			"name_prone holds 3",
		),
	];
	for (text, message) in cases {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("bad.json");
		std::fs::write(&path, text).unwrap();
		let error = AffixRelabelLexicon::load(&path).expect_err("an error");
		assert!(error.to_string().contains(message), "{error}");
	}
}

#[test]
fn a_lexicon_with_an_empty_vocabulary_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("empty.json");
	std::fs::write(&path, r#"{"directionals": {}, "suffixes": {}, "version": "x"}"#).unwrap();
	let error = AffixRelabelLexicon::load(&path).expect_err("an error");
	assert!(error.to_string().contains("empty vocab"), "{error}");
}

#[test]
fn a_name_prone_tail_with_a_true_suffix_splits() {
	assert_eq!(split("Menlo Park Road"), Some((0, 1)));
	assert_eq!(split("Industrial Park Rd"), Some((0, 1)));
	assert_eq!(split("W Cherry Hill Rd"), Some((1, 1)));
}

#[test]
fn a_single_word_name_prone_name_is_still_refused() {
	assert_eq!(split("Park Ave"), None);
	assert_eq!(split("W Park Ave"), None);
}

#[test]
fn a_suffix_shaped_tail_that_is_not_name_prone_is_refused() {
	assert_eq!(split("Old Avenue Road"), None);
}

#[test]
fn a_name_prone_tail_relabels_end_to_end() {
	let mut row = token_row(
		&["64", "Industrial", "Park", "Rd", "Alburgh", "VT"],
		&[
			"B-house_number",
			"B-street",
			"I-street",
			"I-street",
			"B-locality",
			"B-region",
		],
	);
	assert!(relabel_row(&mut row, &lex()).unwrap());
	assert_eq!(
		row.labels,
		strings(&[
			"B-house_number",
			"B-street",
			"I-street",
			"B-street_suffix",
			"B-locality",
			"B-region"
		])
	);
}

#[test]
fn a_v1_lexicon_without_name_prone_keeps_the_blanket_rejection() {
	let v1 = AffixRelabelLexicon {
		name_prone: Default::default(),
		..lex()
	};
	assert_eq!(split_street_span(&["Menlo", "Park", "Road"], &v1), None);
	assert_eq!(split_street_span(&["W", "Cherry", "Hill", "Rd"], &v1), None);
}

fn repo_root() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

#[test]
fn the_v2_lexicon_name_prone_set_matches_the_codex_source() {
	let codex_source = repo_root().join("packages/codex/lib/us/street-suffix.json");
	assert!(
		codex_source.is_file(),
		"the authored codex source is not at {}",
		codex_source.display()
	);
	let codex: Value = serde_json::from_str(&std::fs::read_to_string(&codex_source).unwrap()).unwrap();
	let canonicals: rustc_hash::FxHashSet<String> = codex["nameProneCanonicals"]
		.as_array()
		.unwrap()
		.iter()
		.map(|v| v.as_str().unwrap().to_owned())
		.collect();
	let loaded = AffixRelabelLexicon::load(&repo_root().join("data/gazetteer/affix-relabel-lexicon-v2.json")).unwrap();
	assert_eq!(loaded.version, "affix-relabel-v2");
	assert_eq!(loaded.name_prone, canonicals);
}
