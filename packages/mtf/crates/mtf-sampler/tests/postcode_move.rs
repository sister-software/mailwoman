// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The postcode move (#2750): where the postcode and its separator land, the reason each skipped row names, the
//! sources it never moves, and its draw guard at 0.
mod address_rows;
mod common;

use address_rows::{labels_from_spans, layouts, layouts_path, make_row, rng, sorted_span_texts};
use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::augment::postcode_move::{move_postcode, PostcodeLayouts, SkipReason};
use mtf_sampler::augment::{augment_row, PostcodeMoveOutcomes};
use mtf_sampler::emit::{postcode_move_excluded, EmitPolicy};
use mtf_sampler::{AugmentProbabilities, Row, Sampler, SpanTriple};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

fn strings(items: &[&str]) -> Vec<String> {
	items.iter().map(|s| (*s).to_owned()).collect()
}

fn counts(labels: &[String]) -> HashMap<&str, usize> {
	let mut out = HashMap::new();
	for label in labels {
		*out.entry(label.as_str()).or_default() += 1;
	}
	out
}

/// Every span still covers its component's text, the triple is sorted, and the labels agree with the spans.
fn assert_aligned(original: &Row, moved: &Row) {
	assert_eq!(sorted_span_texts(moved), sorted_span_texts(original));
	let triple = moved.spans.as_ref().unwrap();
	let mut sorted = triple.starts.clone();
	sorted.sort();
	assert_eq!(triple.starts, sorted);
	assert_eq!(moved.tokens.len(), moved.labels.len());
	assert_eq!(
		moved.labels,
		labels_from_spans(&moved.raw, &moved.tokens, &triple.starts, &triple.ends, &triple.tags)
	);
	assert_eq!(counts(&moved.labels), counts(&original.labels));
}

/// The moved row, or the skip reason, against the committed layout table.
fn moved(row: &Row) -> Result<Row, SkipReason> {
	move_postcode(row, &layouts()).expect("no row error")
}

fn moved_with(row: &Row, layouts: &PostcodeLayouts) -> Result<Row, SkipReason> {
	move_postcode(row, layouts).expect("no row error")
}

fn madrid_comma(tokens: Option<&[&str]>) -> Row {
	make_row(
		"Calle Mayor 12, Madrid, 28013",
		&[
			("street", "Calle Mayor"),
			("house_number", "12"),
			("locality", "Madrid"),
			("postcode", "28013"),
		],
		"ES",
		tokens,
	)
}

fn brooklyn() -> Row {
	make_row(
		"123 Main St, Brooklyn, NY 11226",
		&[
			("house_number", "123"),
			("street", "Main St"),
			("locality", "Brooklyn"),
			("region", "NY"),
			("postcode", "11226"),
		],
		"US",
		None,
	)
}

#[test]
fn the_madrid_comma_stays_at_the_boundary() {
	// Spain prints `28013 Madrid`; the layout table is overridden so the comma form is the native one here.
	let row = madrid_comma(None);
	let moved = moved_with(&row, &PostcodeLayouts::from_pairs(&[("ES", Some("after"))])).expect("moved");
	assert_eq!(moved.raw, "Calle Mayor 12, 28013, Madrid");
	assert_aligned(&row, &moved);
}

#[test]
fn a_madrid_token_drops_its_comma_rather_than_carrying_it() {
	let row = madrid_comma(Some(&["Calle", "Mayor", "12,", "Madrid,", "28013"]));
	let moved = moved_with(&row, &PostcodeLayouts::from_pairs(&[("ES", Some("after"))])).expect("moved");
	assert_eq!(moved.raw, "Calle Mayor 12, 28013, Madrid");
	assert_eq!(moved.tokens, strings(&["Calle", "Mayor", "12,", "28013", "Madrid"]));
	assert_eq!(
		moved.labels,
		strings(&["B-street", "I-street", "B-house_number", "B-postcode", "B-locality"])
	);
}

#[test]
fn the_madrid_native_space_form_moves() {
	let row = make_row(
		"Calle Mayor 12, 28013 Madrid",
		&[
			("street", "Calle Mayor"),
			("house_number", "12"),
			("postcode", "28013"),
			("locality", "Madrid"),
		],
		"ES",
		None,
	);
	let moved = moved(&row).expect("moved");
	assert_eq!(moved.raw, "Calle Mayor 12, Madrid 28013");
	assert_aligned(&row, &moved);
}

#[test]
fn the_sao_paulo_block_keeps_its_inner_separator() {
	let row = make_row(
		"Av. Paulista 1000, São Paulo - SP, 01310-100",
		&[
			("street", "Av. Paulista"),
			("house_number", "1000"),
			("locality", "São Paulo"),
			("region", "SP"),
			("postcode", "01310-100"),
		],
		"BR",
		None,
	);
	let moved = moved(&row).expect("moved");
	assert_eq!(moved.raw, "Av. Paulista 1000, 01310-100, São Paulo - SP");
	assert_aligned(&row, &moved);
	assert_eq!(
		moved.tokens[moved.tokens.len() - 4..],
		strings(&["São", "Paulo", "-", "SP"])
	);
}

#[test]
fn the_brooklyn_postcode_moves_ahead_of_its_locality_and_region() {
	let row = brooklyn();
	let moved = moved(&row).expect("moved");
	assert_eq!(moved.raw, "123 Main St, 11226 Brooklyn, NY");
	assert_aligned(&row, &moved);
}

#[test]
fn a_trailing_country_stays_in_place() {
	let row = make_row(
		"123 Main St, Brooklyn, NY 11226, USA",
		&[
			("house_number", "123"),
			("street", "Main St"),
			("locality", "Brooklyn"),
			("region", "NY"),
			("postcode", "11226"),
			("country", "USA"),
		],
		"US",
		None,
	);
	let moved = moved(&row).expect("moved");
	assert_eq!(moved.raw, "123 Main St, 11226 Brooklyn, NY, USA");
	assert_aligned(&row, &moved);
}

fn rome() -> Row {
	make_row(
		"Via del Corso 12, 00186 Roma",
		&[
			("street", "Via del Corso"),
			("house_number", "12"),
			("postcode", "00186"),
			("locality", "Roma"),
		],
		"IT",
		None,
	)
}

fn rome_in(country: &str) -> Row {
	Row {
		country: Some(country.to_owned()),
		..rome()
	}
}

#[test]
fn the_reference_row_moves() {
	assert_eq!(moved(&rome()).expect("moved").raw, "Via del Corso 12, Roma 00186");
}

#[test]
fn a_row_without_spans_is_skipped() {
	let row = Row { spans: None, ..rome() };
	assert_eq!(moved(&row), Err(SkipReason::NoSpans));
}

#[test]
fn a_row_without_a_street_is_skipped() {
	let row = make_row("00186 Roma", &[("postcode", "00186"), ("locality", "Roma")], "IT", None);
	assert_eq!(moved(&row), Err(SkipReason::NoStreet));
}

#[test]
fn a_row_without_a_postcode_is_skipped() {
	let row = make_row(
		"Via del Corso 12, Roma",
		&[
			("street", "Via del Corso"),
			("house_number", "12"),
			("locality", "Roma"),
		],
		"IT",
		None,
	);
	assert_eq!(moved(&row), Err(SkipReason::NoPostcode));
}

#[test]
fn a_country_whose_layout_prints_no_postcode_is_skipped() {
	// The UAE's layout prints no postcode.
	assert_eq!(moved(&rome_in("AE")), Err(SkipReason::NoLayout));
}

#[test]
fn a_layout_without_a_locality_is_skipped() {
	for country in ["JP", "SG", "GI", "KY"] {
		assert_eq!(moved(&rome_in(country)), Err(SkipReason::NoLocalityField), "{country}");
	}
}

#[test]
fn a_layout_printing_the_postcode_between_is_skipped() {
	assert_eq!(moved(&rome_in("IN")), Err(SkipReason::LayoutBetween));
}

#[test]
fn a_span_splitting_the_tail_is_not_a_block() {
	let row = make_row(
		"Via del Corso 12, 00186 Centro Roma",
		&[
			("street", "Via del Corso"),
			("house_number", "12"),
			("postcode", "00186"),
			("dependent_locality", "Centro"),
			("locality", "Roma"),
		],
		"IT",
		None,
	);
	assert_eq!(moved(&row), Err(SkipReason::NotBlock));
}

#[test]
fn an_unlabeled_word_between_them_is_not_a_block() {
	let row = make_row(
		"Via del Corso 12, 00186 presso Roma",
		&[
			("street", "Via del Corso"),
			("house_number", "12"),
			("postcode", "00186"),
			("locality", "Roma"),
		],
		"IT",
		None,
	);
	assert_eq!(moved(&row), Err(SkipReason::NotBlock));
}

#[test]
fn a_glued_postcode_is_not_a_block() {
	let row = make_row(
		"123 Main St, Brooklyn, NY11226",
		&[
			("house_number", "123"),
			("street", "Main St"),
			("locality", "Brooklyn"),
			("region", "NY"),
			("postcode", "11226"),
		],
		"US",
		Some(&["123", "Main", "St", "Brooklyn", "NY11226"]),
	);
	assert_eq!(moved(&row), Err(SkipReason::NotBlock));
}

#[test]
fn a_postcode_already_on_the_other_side_is_non_native() {
	let row = make_row(
		"Via del Corso 12, Roma 00186",
		&[
			("street", "Via del Corso"),
			("house_number", "12"),
			("locality", "Roma"),
			("postcode", "00186"),
		],
		"IT",
		None,
	);
	assert_eq!(moved(&row), Err(SkipReason::NonNative));
}

#[test]
fn a_token_across_the_boundary_is_skipped() {
	// The token `NY,11226` holds the region and the postcode, one on each side of the boundary.
	let row = make_row(
		"123 Main St, Brooklyn, NY,11226",
		&[
			("house_number", "123"),
			("street", "Main St"),
			("locality", "Brooklyn"),
			("region", "NY"),
			("postcode", "11226"),
		],
		"US",
		Some(&["123", "Main", "St,", "Brooklyn,", "NY,11226"]),
	);
	assert_eq!(moved(&row), Err(SkipReason::WordAcrossBoundary));
}

/// A state-ny-notaries row whose locality span starts on the space after the street.
fn notary_row(starts: &[i64], ends: &[i64]) -> Row {
	let raw = "THERESA TEBBETT 99 MAIN ST HEPSTEAD NY 11550";
	let tags = strings(&["venue", "house_number", "street", "locality", "region", "postcode"]);
	let tokens: Vec<String> = raw.split_whitespace().map(str::to_owned).collect();
	Row {
		raw: raw.to_owned(),
		labels: labels_from_spans(raw, &tokens, starts, ends, &tags),
		tokens,
		country: Some("US".to_owned()),
		source: "state-ny-notaries".to_owned(),
		spans: Some(SpanTriple {
			starts: starts.to_vec(),
			ends: ends.to_vec(),
			tags,
		}),
	}
}

#[test]
fn a_locality_span_holding_the_leading_space_is_skipped() {
	let row = notary_row(&[0, 16, 19, 26, 36, 39], &[15, 18, 26, 35, 38, 44]);
	assert_eq!(moved(&row), Err(SkipReason::SpanEdgeWhitespace));
}

#[test]
fn overlapping_input_spans_are_skipped() {
	// The observed crash: postcode@[34, 39) inside a span at [23, 40).
	let mut row = notary_row(&[0, 16, 19, 26, 36, 39], &[15, 18, 26, 35, 38, 44]);
	row.spans = Some(SpanTriple {
		starts: vec![0, 16, 19, 23, 36, 34],
		ends: vec![15, 18, 22, 40, 38, 39],
		tags: row.spans.unwrap().tags,
	});
	assert_eq!(moved(&row), Err(SkipReason::SpansOverlap));
}

#[test]
fn a_span_ending_at_the_block_start_stays_put() {
	// A comma with no space between the street and a trimmed block: the street keeps its end.
	let raw = "1 Main St,Brooklyn NY 11214";
	let (starts, ends) = (vec![0, 2, 10, 19, 22], vec![1, 9, 18, 21, 27]);
	let tags = strings(&["house_number", "street", "locality", "region", "postcode"]);
	let tokens = strings(&["1", "Main", "St", "Brooklyn", "NY", "11214"]);
	let row = Row {
		raw: raw.to_owned(),
		labels: labels_from_spans(raw, &tokens, &starts, &ends, &tags),
		tokens,
		country: Some("US".to_owned()),
		source: "openaddresses".to_owned(),
		spans: Some(SpanTriple { starts, ends, tags }),
	};
	let moved = moved(&row).expect("moved");
	assert_eq!(moved.raw, "1 Main St,11214 Brooklyn NY");
	assert_eq!(sorted_span_texts(&moved), sorted_span_texts(&row));
	let triple = moved.spans.unwrap();
	assert_eq!(
		(triple.starts, triple.ends),
		(vec![0, 2, 10, 16, 25], vec![1, 9, 15, 24, 27])
	);
}

fn knobs(directional: f64, region: f64) -> AugmentProbabilities {
	AugmentProbabilities {
		directional,
		region,
		..Default::default()
	}
}

/// The rows `augment_row` yields with the committed layout table.
fn augment(row: &Row, seed: i128, p: AugmentProbabilities, move_prob: f64) -> Vec<Row> {
	let layouts = layouts();
	augment_row(
		row,
		&mut rng(seed),
		&p,
		move_prob,
		Some(&layouts),
		&mut PostcodeMoveOutcomes::default(),
	)
	.into_iter()
	.map(|r| r.unwrap())
	.collect()
}

#[test]
fn the_knob_at_zero_leaves_the_stream_bit_identical() {
	let layouts = layouts();
	let p = AugmentProbabilities {
		glue: 0.2,
		case: 0.2,
		ordinal: 0.2,
		..knobs(0.3, 0.3)
	};
	for seed in 0..20 {
		let (mut before, mut after) = (rng(seed), rng(seed));
		let a = augment_row(
			&rome(),
			&mut before,
			&p,
			0.0,
			None,
			&mut PostcodeMoveOutcomes::default(),
		);
		let b = augment_row(
			&rome(),
			&mut after,
			&p,
			0.0,
			Some(&layouts),
			&mut PostcodeMoveOutcomes::default(),
		);
		assert_eq!(a, b);
		assert_eq!(
			(0..4).map(|_| before.next_u32()).collect::<Vec<_>>(),
			(0..4).map(|_| after.next_u32()).collect::<Vec<_>>(),
			"seed {seed}: the generators stand at the same state"
		);
	}
}

#[test]
fn the_move_draws_last_so_earlier_copies_are_unchanged() {
	let p = AugmentProbabilities {
		case: 1.0,
		..knobs(1.0, 1.0)
	};
	let without = augment(&rome(), 5, p, 0.0);
	let with = augment(&rome(), 5, p, 1.0);
	assert_eq!(with[..without.len()], without[..]);
	assert_eq!(with.last().unwrap().raw, "Via del Corso 12, Roma 00186");
}

#[test]
fn the_move_is_an_additive_copy_and_counts_each_outcome() {
	let layouts = layouts();
	let mut outcomes = PostcodeMoveOutcomes::default();
	let row = rome();
	let rows = augment_row(&row, &mut rng(1), &knobs(0.0, 0.0), 1.0, Some(&layouts), &mut outcomes);
	assert_eq!(rows.len(), 2);
	assert_eq!(rows[0].as_ref().unwrap(), &row);
	augment_row(
		&rome_in("JP"),
		&mut rng(1),
		&knobs(0.0, 0.0),
		1.0,
		Some(&layouts),
		&mut outcomes,
	);
	assert_eq!(outcomes.0, HashMap::from([("moved", 1), ("no_locality_field", 1)]));
}

/// The sources whose producers already write the postcode off its native side.
const EXCLUDED_SOURCES: [&str; 10] = [
	"gnaf",
	"geonames-postal",
	"juso-kr",
	"localdata-kr",
	"rendered-cz-pcfirst-preposition",
	"rendered-cz-pcfirst-preposition-v20",
	"rendered-cz-pcfirst-preposition-v21",
	"synth-cz-pcfirst-preposition",
	"synth-cz-pcfirst-preposition-v20",
	"synth-cz-pcfirst-preposition-v21",
];

#[test]
fn sources_that_write_a_reordered_postcode_are_excluded() {
	let mut policy = EmitPolicy {
		augment: AugmentProbabilities {
			postcode_move: 1.0,
			..Default::default()
		},
		excluded_sources: Vec::new(),
		relabel: None,
		layouts: Some(Arc::new(layouts())),
		postcode_move_outcomes: Default::default(),
	};
	for source in EXCLUDED_SOURCES {
		assert!(postcode_move_excluded(source), "{source}");
		let row = Row {
			source: source.to_owned(),
			..rome()
		};
		let raws: Vec<String> = policy
			.emit(row, &mut rng(1))
			.into_iter()
			.map(|r| r.unwrap().raw)
			.collect();
		assert_eq!(raws, ["Via del Corso 12, 00186 Roma"], "{source}");
	}
	assert_eq!(policy.emit(rome(), &mut rng(1)).len(), 2);
}

#[test]
fn a_validation_split_never_moves_a_postcode() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let options = WriteOptions::default();
	write_corpus_parquet(&[rome()], &corpus.join("val/part.parquet"), 8, &options);
	write_corpus_parquet(&[rome()], &corpus.join("train/part.parquet"), 8, &options);
	let config = config(
		&corpus,
		json!({
			"country_weights": {"IT": 1.0},
			"coarse_filter": false,
			"augment": {"postcode_move": 1.0},
			"postcode_layouts_path": layouts_path(),
			"shuffle_buffer": 1,
		}),
	);
	let raws = |split: &str| -> Vec<String> {
		Sampler::open(&config, split, 1, None)
			.unwrap()
			.rows()
			.map(|r| r.unwrap().raw)
			.collect()
	};
	assert_eq!(raws("val"), ["Via del Corso 12, 00186 Roma"]);
	assert_eq!(
		raws("train"),
		["Via del Corso 12, 00186 Roma", "Via del Corso 12, Roma 00186"]
	);
}

#[test]
fn a_layout_table_entry_that_is_neither_a_string_nor_null_is_refused() {
	let path = std::path::Path::new("layouts.json");
	assert!(PostcodeLayouts::from_json(r#"{"countries": {"US": "postcode-last", "AQ": null}}"#, path).is_ok());
	let Err(refusal) = PostcodeLayouts::from_json(r#"{"countries": {"US": 5}}"#, path) else {
		panic!("a numeric layout was accepted");
	};
	let refusal = refusal.to_string();
	assert!(refusal.contains("country \"US\" has layout 5"), "{refusal}");
}
