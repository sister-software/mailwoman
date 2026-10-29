// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The expansion, glue, punctuation-drop, case and ordinal augmentations: the text each copy holds, the spans and
//! labels it keeps, and the draws a knob at 0 leaves untouched.
mod address_rows;

use address_rows::{assert_span_invariants, from, rng, row, span_texts, texts, with_spans};
use mtf_channels::labels::{char_labels_from_tokens, LabelTable};
use mtf_channels::Piece;
use mtf_sampler::augment::splice::{
	drop_separator_punct, expand_token, glue_region_postcode, lowercase_row, splice_expansion, token_spans,
	upper_case_row,
};
use mtf_sampler::augment::{augment_row, PostcodeMoveOutcomes};
use mtf_sampler::pyrandom::PyRandom;
use mtf_sampler::{AugmentProbabilities, Row, SpanTriple};
use std::collections::HashMap;

fn strings(items: &[&str]) -> Vec<String> {
	items.iter().map(|s| (*s).to_owned()).collect()
}

/// The rows `augment_row` yields with no postcode move, each unwrapped.
fn augment(row: &Row, rng: &mut PyRandom, p: AugmentProbabilities) -> Vec<Row> {
	augment_row(row, rng, &p, 0.0, None, &mut PostcodeMoveOutcomes::default())
		.into_iter()
		.map(|r| r.expect("an augmented row"))
		.collect()
}

fn probs(directional: f64, region: f64) -> AugmentProbabilities {
	AugmentProbabilities {
		directional,
		region,
		..Default::default()
	}
}

fn directional_row() -> Row {
	from(
		row(
			"350 5th Ave NW",
			&["350", "5th", "Ave", "NW"],
			&["B-house_number", "B-street", "I-street", "I-street"],
		),
		"US",
		"tiger",
	)
}

fn spanned_directional_row() -> Row {
	with_spans(directional_row(), &[0, 4], &[3, 14], &["house_number", "street"])
}

fn glue_row() -> Row {
	from(
		row(
			"123 Main St Buffalo NY 14201",
			&["123", "Main", "St", "Buffalo", "NY", "14201"],
			&[
				"B-house_number",
				"B-street",
				"I-street",
				"B-locality",
				"B-region",
				"B-postcode",
			],
		),
		"US",
		"tiger",
	)
}

fn punct_row() -> Row {
	with_spans(
		from(
			row(
				"123 Main St, Portland, OR 97214",
				&["123", "Main", "St,", "Portland,", "OR", "97214"],
				&[
					"B-house_number",
					"B-street",
					"I-street",
					"B-locality",
					"B-region",
					"B-postcode",
				],
			),
			"US",
			"tiger",
		),
		&[0, 4, 13, 23, 26],
		&[3, 11, 21, 25, 31],
		&["house_number", "street", "locality", "region", "postcode"],
	)
}

fn dotted_po_box_row() -> Row {
	with_spans(
		row(
			"P.O. Box 123, Buffalo NY 14201",
			&["P.O.", "Box", "123,", "Buffalo", "NY", "14201"],
			&[
				"B-po_box",
				"I-po_box",
				"I-po_box",
				"B-locality",
				"B-region",
				"B-postcode",
			],
		),
		&[0, 14, 22, 25],
		&[12, 21, 24, 30],
		&["po_box", "locality", "region", "postcode"],
	)
}

/// A label table over `O` and the B/I labels of `tags`.
fn label_table(tags: &[&str]) -> (LabelTable, Vec<String>) {
	let mut labels = vec!["O".to_owned()];
	for tag in tags {
		labels.push(format!("B-{tag}"));
		labels.push(format!("I-{tag}"));
	}
	let ids: HashMap<String, i64> = labels.iter().enumerate().map(|(i, l)| (l.clone(), i as i64)).collect();
	(LabelTable::new(&ids, &strings(tags), -100).unwrap(), labels)
}

#[test]
fn expand_token_single_word() {
	let tokens = strings(&["350", "5th", "Ave", "NW"]);
	let labels = strings(&["B-house_number", "B-street", "I-street", "I-street"]);
	let (new_tokens, new_labels) = expand_token(&tokens, &labels, 3, "Northwest");
	assert_eq!(new_tokens, strings(&["350", "5th", "Ave", "Northwest"]));
	assert_eq!(new_labels, labels);
}

#[test]
fn expand_token_multi_word_b_label() {
	let tokens = strings(&["Washington", ",", "DC"]);
	let labels = strings(&["B-region", "O", "B-region"]);
	let (new_tokens, new_labels) = expand_token(&tokens, &labels, 2, "District of Columbia");
	assert_eq!(new_tokens, strings(&["Washington", ",", "District", "of", "Columbia"]));
	assert_eq!(
		new_labels,
		strings(&["B-region", "O", "B-region", "I-region", "I-region"])
	);
}

#[test]
fn expand_token_multi_word_i_label() {
	let tokens = strings(&["New", "York", ",", "NY"]);
	let labels = strings(&["B-locality", "I-locality", "O", "B-region"]);
	let (new_tokens, new_labels) = expand_token(&tokens, &labels, 3, "New York");
	assert_eq!(new_tokens, strings(&["New", "York", ",", "New", "York"]));
	assert_eq!(
		new_labels,
		strings(&["B-locality", "I-locality", "O", "B-region", "I-region"])
	);
}

#[test]
fn the_original_row_is_always_yielded_first() {
	let row = directional_row();
	let results = augment(&row, &mut rng(42), probs(0.0, 0.0));
	assert_eq!(results, vec![row]);
}

#[test]
fn the_directional_expansion_fires() {
	let row = directional_row();
	let results = augment(&row, &mut rng(42), probs(1.0, 0.0));
	assert_eq!(results.len(), 2);
	assert_eq!(results[0], row);
	assert!(results[1].tokens.iter().any(|t| t == "Northwest"));
}

#[test]
fn the_region_expansion_fires() {
	let row = from(
		row(
			"New York , NY",
			&["New", "York", ",", "NY"],
			&["B-locality", "I-locality", "O", "B-region"],
		),
		"US",
		"tiger",
	);
	let results = augment(&row, &mut rng(42), probs(0.0, 1.0));
	assert_eq!(results.len(), 2);
	assert!(results[1].labels.iter().any(|l| l == "B-region"));
	assert!(results[1].labels.iter().any(|l| l == "I-region"));
}

#[test]
fn a_row_without_a_match_gains_no_copy() {
	let row = from(
		row(
			"123 Main St",
			&["123", "Main", "St"],
			&["B-house_number", "B-street", "I-street"],
		),
		"US",
		"tiger",
	);
	assert_eq!(augment(&row, &mut rng(42), probs(1.0, 1.0)).len(), 1);
}

#[test]
fn the_region_expansion_only_expands_region_labeled_tokens() {
	let row = from(
		row(
			"PA Ave , DC",
			&["PA", "Ave", ",", "DC"],
			&["B-street", "I-street", "O", "B-region"],
		),
		"US",
		"tiger",
	);
	let results = augment(&row, &mut rng(42), probs(0.0, 1.0));
	assert_eq!(results.len(), 2);
	assert_eq!(results[1].tokens[0], "PA");
	assert!(results[1].tokens.iter().any(|t| t == "District"));
}

#[test]
fn the_glue_fuses_the_raw_text_only() {
	let row = glue_row();
	let p = AugmentProbabilities {
		glue: 1.0,
		..Default::default()
	};
	let results = augment(&row, &mut rng(42), p);
	assert_eq!(results.len(), 2);
	assert_eq!(results[0], row);
	assert_eq!(results[1].raw, "123 Main St Buffalo NY14201");
	assert_eq!(results[1].tokens, row.tokens);
	assert_eq!(results[1].labels, row.labels);
}

#[test]
fn the_glue_preserves_the_original_punctuation() {
	let row = row(
		"Buffalo, NY 14201",
		&["Buffalo", ",", "NY", "14201"],
		&["B-locality", "O", "B-region", "B-postcode"],
	);
	assert_eq!(glue_region_postcode(&row, 2).unwrap().raw, "Buffalo, NY14201");
}

#[test]
fn the_glue_fuses_the_last_token_of_a_multi_token_region() {
	let row = row(
		"Springfield New York 10001",
		&["Springfield", "New", "York", "10001"],
		&["B-locality", "B-region", "I-region", "B-postcode"],
	);
	let p = AugmentProbabilities {
		glue: 1.0,
		..Default::default()
	};
	let results = augment(&row, &mut rng(42), p);
	assert_eq!(results.len(), 2);
	assert_eq!(results[1].raw, "Springfield New York10001");
}

#[test]
fn the_glue_requires_a_digit_leading_postcode() {
	let row = from(
		row(
			"London England SW1A 1AA",
			&["London", "England", "SW1A", "1AA"],
			&["B-locality", "B-region", "B-postcode", "I-postcode"],
		),
		"GB",
		"wof-admin",
	);
	let p = AugmentProbabilities {
		glue: 1.0,
		..Default::default()
	};
	assert_eq!(augment(&row, &mut rng(42), p).len(), 1);
}

#[test]
fn the_glue_requires_adjacency() {
	let row = row(
		"Buffalo NY USA 14201",
		&["Buffalo", "NY", "USA", "14201"],
		&["B-locality", "B-region", "B-country", "B-postcode"],
	);
	let p = AugmentProbabilities {
		glue: 1.0,
		..Default::default()
	};
	assert_eq!(augment(&row, &mut rng(42), p).len(), 1);
}

#[test]
fn the_glue_at_zero_draws_nothing() {
	let mut reference = rng(7);
	reference.random();
	reference.random();
	let expected = reference.random();
	let mut generator = rng(7);
	augment(&glue_row(), &mut generator, probs(0.0, 0.0));
	assert_eq!(
		generator.random(),
		expected,
		"only the directional and region draws are made"
	);
}

#[test]
fn a_glued_raw_projects_its_split_labels_onto_pieces() {
	let row = row(
		"Buffalo NY 14201",
		&["Buffalo", "NY", "14201"],
		&["B-locality", "B-region", "B-postcode"],
	);
	let fused = glue_region_postcode(&row, 1).unwrap();
	assert_eq!(fused.raw, "Buffalo NY14201");
	let (table, names) = label_table(&["locality", "region", "postcode"]);
	let raw = fused.chars();
	let tokens: Vec<Vec<char>> = fused.tokens.iter().map(|t| t.chars().collect()).collect();
	let char_labels = char_labels_from_tokens(&raw, &tokens, &fused.labels, &table).unwrap();
	let pieces: Vec<Piece> = [(0, 7), (8, 10), (10, 13), (13, 15)]
		.iter()
		.map(|&(begin, end)| Piece { id: 0, begin, end })
		.collect();
	let bio: Vec<&str> = table
		.project(&raw, &char_labels, &pieces)
		.iter()
		.map(|&id| names[id as usize].as_str())
		.collect();
	assert_eq!(bio, ["B-locality", "B-region", "B-postcode", "I-postcode"]);
}

#[test]
fn the_expansion_splices_the_raw_text_and_retargets_the_spans() {
	let row = spanned_directional_row();
	let results = augment(&row, &mut rng(42), probs(1.0, 0.0));
	assert_eq!(results.len(), 2);
	assert_eq!(results[0], row, "the original row keeps its spans");
	let augmented = &results[1];
	assert_eq!(augmented.raw, "350 5th Ave Northwest");
	assert_eq!(
		span_texts(augmented),
		texts(&[("house_number", "350"), ("street", "5th Ave Northwest")])
	);
	assert_span_invariants(augmented);
}

#[test]
fn expanded_spans_project_identically_to_expanded_tokens() {
	let augmented = augment(&spanned_directional_row(), &mut rng(42), probs(1.0, 0.0)).remove(1);
	let (table, _) = label_table(&["house_number", "street"]);
	let raw = augmented.chars();
	let tokens: Vec<Vec<char>> = augmented.tokens.iter().map(|t| t.chars().collect()).collect();
	let pieces: Vec<Piece> = token_spans(&raw, &augmented.tokens)
		.unwrap()
		.into_iter()
		.map(|(begin, end)| Piece { id: 0, begin, end })
		.collect();
	let via_tokens = table.project(
		&raw,
		&char_labels_from_tokens(&raw, &tokens, &augmented.labels, &table).unwrap(),
		&pieces,
	);
	let spans = augmented.encoder_spans().unwrap();
	let ranges = spans.validated(&raw).unwrap();
	let via_spans = table.project(&raw, &spans.char_labels(&raw, &ranges, &table), &pieces);
	assert_eq!(via_spans, via_tokens);
}

#[test]
fn the_glue_shifts_the_spans_with_the_splice() {
	let row = with_spans(
		glue_row(),
		&[0, 4, 12, 20, 23],
		&[3, 11, 19, 22, 28],
		&["house_number", "street", "locality", "region", "postcode"],
	);
	let fused = glue_region_postcode(&row, 4).unwrap();
	assert_eq!(fused.raw, "123 Main St Buffalo NY14201");
	assert_eq!(
		span_texts(&fused),
		texts(&[
			("house_number", "123"),
			("street", "Main St"),
			("locality", "Buffalo"),
			("region", "NY"),
			("postcode", "14201"),
		])
	);
}

#[test]
fn the_glue_of_a_row_without_spans_writes_no_spans() {
	assert!(glue_region_postcode(&glue_row(), 4).unwrap().spans.is_none());
}

#[test]
fn a_non_parallel_span_triple_is_refused() {
	let row = Row {
		spans: Some(SpanTriple {
			starts: vec![0],
			ends: vec![1, 2],
			tags: strings(&["street"]),
		}),
		..row("x", &["x"], &["B-street"])
	};
	let error = row.span_triple().expect_err("an error");
	assert!(error.to_string().contains("not parallel"), "{error}");
}

#[test]
fn the_punctuation_drop_removes_separator_commas_and_retargets_the_spans() {
	let dropped = drop_separator_punct(&punct_row()).unwrap().expect("a dropped copy");
	assert_eq!(dropped.raw, "123 Main St Portland OR 97214");
	assert_eq!(
		span_texts(&dropped),
		texts(&[
			("house_number", "123"),
			("street", "Main St"),
			("locality", "Portland"),
			("region", "OR"),
			("postcode", "97214"),
		])
	);
	assert_span_invariants(&dropped);
	assert_eq!(
		dropped.tokens,
		strings(&["123", "Main", "St", "Portland", "OR", "97214"])
	);
	assert_eq!(dropped.labels, punct_row().labels);
	token_spans(&dropped.chars(), &dropped.tokens).expect("every token is in the dropped text");
}

#[test]
fn the_punctuation_drop_keeps_an_interior_apostrophe() {
	let row = with_spans(
		row(
			"Ben & Jerry's, Burlington",
			&["Ben", "&", "Jerry's,", "Burlington"],
			&["B-venue", "I-venue", "I-venue", "B-locality"],
		),
		&[0, 15],
		&[13, 25],
		&["venue", "locality"],
	);
	let dropped = drop_separator_punct(&row).unwrap().expect("a dropped copy");
	assert_eq!(dropped.raw, "Ben & Jerry's Burlington");
	assert_eq!(
		span_texts(&dropped),
		texts(&[("venue", "Ben & Jerry's"), ("locality", "Burlington")])
	);
	assert_span_invariants(&dropped);
}

#[test]
fn the_punctuation_drop_removes_a_standalone_punctuation_token() {
	let row = with_spans(
		row(
			"Portland , OR",
			&["Portland", ",", "OR"],
			&["B-locality", "O", "B-region"],
		),
		&[0, 11],
		&[8, 13],
		&["locality", "region"],
	);
	let dropped = drop_separator_punct(&row).unwrap().expect("a dropped copy");
	assert_eq!(dropped.raw, "Portland  OR");
	assert_eq!(dropped.tokens, strings(&["Portland", "OR"]));
	assert_eq!(dropped.labels, strings(&["B-locality", "B-region"]));
	assert_eq!(
		span_texts(&dropped),
		texts(&[("locality", "Portland"), ("region", "OR")])
	);
}

#[test]
fn the_punctuation_drop_strips_wrapping_quotes() {
	let row = with_spans(
		row(
			"\"350 5th Ave\"",
			&["\"350", "5th", "Ave\""],
			&["B-house_number", "B-street", "I-street"],
		),
		&[1, 5],
		&[4, 12],
		&["house_number", "street"],
	);
	let dropped = drop_separator_punct(&row).unwrap().expect("a dropped copy");
	assert_eq!(dropped.raw, "350 5th Ave");
	assert_eq!(
		span_texts(&dropped),
		texts(&[("house_number", "350"), ("street", "5th Ave")])
	);
	assert_eq!(dropped.tokens, strings(&["350", "5th", "Ave"]));
}

#[test]
fn the_punctuation_drop_skips_a_row_without_spans() {
	let row = row("Portland, OR", &["Portland,", "OR"], &["B-locality", "B-region"]);
	assert_eq!(drop_separator_punct(&row).unwrap(), None);
}

#[test]
fn the_punctuation_drop_skips_a_row_without_separator_punctuation() {
	assert_eq!(drop_separator_punct(&spanned_directional_row()).unwrap(), None);
}

#[test]
fn the_punctuation_drop_at_zero_draws_nothing() {
	let (mut a, mut b) = (rng(7), rng(7));
	augment(&punct_row(), &mut a, probs(0.0, 0.0));
	let p = AugmentProbabilities {
		punct_drop: 0.0,
		..probs(0.0, 0.0)
	};
	augment(&punct_row(), &mut b, p);
	assert_eq!(a.random(), b.random());
}

#[test]
fn the_punctuation_drop_fires_through_augment_row() {
	let p = AugmentProbabilities {
		punct_drop: 1.0,
		..Default::default()
	};
	let results = augment(&punct_row(), &mut rng(1), p);
	assert_eq!(results[0].raw, "123 Main St, Portland, OR 97214");
	assert!(results[1..].iter().any(|r| r.raw == "123 Main St Portland OR 97214"));
}

#[test]
fn the_expansion_preserves_punctuation_inside_a_span() {
	let results = augment(&dotted_po_box_row(), &mut rng(42), probs(0.0, 1.0));
	assert_eq!(results.len(), 2);
	let augmented = &results[1];
	assert_eq!(augmented.raw, "P.O. Box 123, Buffalo New York 14201");
	assert_eq!(
		span_texts(augmented),
		texts(&[
			("po_box", "P.O. Box 123"),
			("locality", "Buffalo"),
			("region", "New York"),
			("postcode", "14201")
		])
	);
	assert_span_invariants(augmented);
	assert_eq!(augmented.chars()[12], ',');
}

#[test]
fn the_expansion_preserves_the_whitespace_geometry() {
	let row = with_spans(
		row(
			"350 5th  Ave NW\nBuffalo",
			&["350", "5th", "Ave", "NW", "Buffalo"],
			&["B-house_number", "B-street", "I-street", "I-street", "B-locality"],
		),
		&[0, 4, 16],
		&[3, 15, 23],
		&["house_number", "street", "locality"],
	);
	let augmented = augment(&row, &mut rng(42), probs(1.0, 0.0)).remove(1);
	assert_eq!(augmented.raw, "350 5th  Ave Northwest\nBuffalo");
	assert_eq!(
		span_texts(&augmented),
		texts(&[
			("house_number", "350"),
			("street", "5th  Ave Northwest"),
			("locality", "Buffalo")
		])
	);
	assert_span_invariants(&augmented);
}

#[test]
fn the_expansion_of_a_row_without_spans_keeps_its_punctuation_too() {
	let row = Row {
		spans: None,
		..dotted_po_box_row()
	};
	let results = augment(&row, &mut rng(42), probs(0.0, 1.0));
	assert_eq!(results.len(), 2);
	assert_eq!(results[1].raw, "P.O. Box 123, Buffalo New York 14201");
	assert!(results[1].spans.is_none());
}

#[test]
fn a_span_boundary_inside_the_expanded_token_is_refused() {
	let row = with_spans(
		row(
			"Buffalo NY 14201",
			&["Buffalo", "NY", "14201"],
			&["B-locality", "B-region", "B-postcode"],
		),
		&[0, 8, 11],
		&[7, 9, 16],
		&["locality", "region", "postcode"],
	);
	let error = splice_expansion(&row, 1, "New York").expect_err("an error");
	assert!(error.to_string().contains("un-retargetable"), "{error}");
}

#[test]
fn an_expansion_then_a_glue_still_verify() {
	let row = with_spans(
		row(
			"350 5th Ave NW Buffalo, NY 14201",
			&["350", "5th", "Ave", "NW", "Buffalo,", "NY", "14201"],
			&[
				"B-house_number",
				"B-street",
				"I-street",
				"I-street",
				"B-locality",
				"B-region",
				"B-postcode",
			],
		),
		&[0, 4, 15, 24, 27],
		&[3, 14, 22, 26, 32],
		&["house_number", "street", "locality", "region", "postcode"],
	);
	let expanded = splice_expansion(&row, 3, "Northwest").unwrap();
	assert_eq!(expanded.raw, "350 5th Ave Northwest Buffalo, NY 14201");
	let fused = glue_region_postcode(&expanded, 5).unwrap();
	assert_eq!(fused.raw, "350 5th Ave Northwest Buffalo, NY14201");
	assert_eq!(
		span_texts(&fused),
		texts(&[
			("house_number", "350"),
			("street", "5th Ave Northwest"),
			("locality", "Buffalo"),
			("region", "NY"),
			("postcode", "14201"),
		])
	);
	assert_span_invariants(&fused);
}

#[test]
fn the_lowercase_copy_keeps_the_labels_and_spans() {
	let row = spanned_directional_row();
	let out = lowercase_row(&row).unwrap().expect("a lowercased copy");
	assert_eq!(out.raw, "350 5th ave nw");
	assert_eq!(out.tokens, strings(&["350", "5th", "ave", "nw"]));
	assert_eq!(out.labels, row.labels);
	assert_eq!(out.spans, row.spans);
}

#[test]
fn the_lowercase_copy_skips_a_length_changing_row() {
	let row = row("İSTANBUL", &["İSTANBUL"], &["B-locality"]);
	assert_eq!(lowercase_row(&row).unwrap(), None);
}

#[test]
fn the_case_knob_yields_a_lowercased_copy() {
	let row = directional_row();
	let p = AugmentProbabilities {
		case: 1.0,
		..Default::default()
	};
	let results = augment(&row, &mut rng(42), p);
	assert_eq!(results[0], row);
	assert!(results.iter().any(|r| r.raw == "350 5th ave nw"));
}

#[test]
fn the_case_knob_at_zero_is_bit_identical() {
	let row = directional_row();
	let a = augment(
		&row,
		&mut rng(7),
		AugmentProbabilities {
			case: 0.0,
			..probs(0.5, 0.5)
		},
	);
	let b = augment(&row, &mut rng(7), probs(0.5, 0.5));
	assert_eq!(a, b);
}

#[test]
fn the_upper_case_copy_keeps_the_labels_and_spans() {
	let row = with_spans(
		from(
			row(
				"350 5th Ave nw",
				&["350", "5th", "Ave", "nw"],
				&["B-house_number", "B-street", "I-street", "I-street"],
			),
			"US",
			"tiger",
		),
		&[0, 4],
		&[3, 14],
		&["house_number", "street"],
	);
	let out = upper_case_row(&row).unwrap().expect("an upper-cased copy");
	assert_eq!(out.raw, "350 5TH AVE NW");
	assert_eq!(out.tokens, strings(&["350", "5TH", "AVE", "NW"]));
	assert_eq!(out.labels, row.labels);
	assert_eq!(out.spans, row.spans);
}

#[test]
fn the_upper_case_copy_skips_a_length_changing_row() {
	let row = row(
		"Große Straße 1",
		&["Große", "Straße", "1"],
		&["B-street", "I-street", "B-house_number"],
	);
	assert_eq!(upper_case_row(&row).unwrap(), None);
}

#[test]
fn the_upper_case_copy_skips_a_row_already_upper_case() {
	let row = row(
		"MAIN ST 5",
		&["MAIN", "ST", "5"],
		&["B-street", "I-street", "B-house_number"],
	);
	assert_eq!(upper_case_row(&row).unwrap(), None);
}

#[test]
fn the_upper_case_knob_yields_an_upper_cased_copy() {
	let row = directional_row();
	let p = AugmentProbabilities {
		upper_case: 1.0,
		..Default::default()
	};
	let results = augment(&row, &mut rng(42), p);
	assert_eq!(results[0], row);
	assert!(results.iter().any(|r| r.raw == "350 5TH AVE NW"));
}

fn ordinal_row() -> Row {
	row(
		"350 Fifth Ave, New York, NY",
		&["350", "Fifth", "Ave,", "New", "York,", "NY"],
		&[
			"B-house_number",
			"B-street",
			"B-street_suffix",
			"B-locality",
			"I-locality",
			"B-region",
		],
	)
}

#[test]
fn the_ordinal_swap_writes_a_word_ordinal_as_digits_on_a_street_label() {
	let p = AugmentProbabilities {
		ordinal: 1.0,
		..Default::default()
	};
	let rows = augment(&ordinal_row(), &mut rng(7), p);
	let augmented: Vec<&Row> = rows[1..].iter().filter(|r| r.raw.contains("5th")).collect();
	assert!(!augmented.is_empty(), "expected a 5th-form augmented copy");
	assert_eq!(augmented[0].raw, "350 5th Ave, New York, NY");
	assert_eq!(augmented[0].labels, ordinal_row().labels);
}

#[test]
fn the_ordinal_swap_never_touches_an_ordinal_outside_a_street() {
	let row = row(
		"Apt 5th 12 Main St",
		&["Apt", "5th", "12", "Main", "St"],
		&["B-unit", "I-unit", "B-house_number", "B-street", "B-street_suffix"],
	);
	let p = AugmentProbabilities {
		ordinal: 1.0,
		..Default::default()
	};
	assert!(augment(&row, &mut rng(7), p).iter().all(|r| !r.raw.contains("Fifth")));
}

#[test]
fn the_ordinal_knob_at_zero_is_bit_identical() {
	let a = augment(&ordinal_row(), &mut rng(3), probs(0.3, 0.3));
	let b = augment(
		&ordinal_row(),
		&mut rng(3),
		AugmentProbabilities {
			ordinal: 0.0,
			..probs(0.3, 0.3)
		},
	);
	assert_eq!(a, b);
}
