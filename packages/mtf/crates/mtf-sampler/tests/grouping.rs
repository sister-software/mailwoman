// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The grouping-character augmentation (#2845) keeps every span on its component's text, and its knob at 0 draws
//! nothing.
mod address_rows;

use address_rows::{layouts, make_row, rng, span_texts};
use mtf_sampler::augment::grouping::{group_row, wrap_row, wrap_span};
use mtf_sampler::augment::splice::token_spans;
use mtf_sampler::augment::{augment_row, PostcodeMoveOutcomes};
use mtf_sampler::{AugmentProbabilities, Row};

fn boston() -> Row {
	make_row(
		"123 Main St, Boston, MA 02111, USA",
		&[
			("house_number", "123"),
			("street", "Main St"),
			("locality", "Boston"),
			("region", "MA"),
			("postcode", "02111"),
			("country", "USA"),
		],
		"US",
		None,
	)
}

fn cafe() -> Row {
	make_row(
		"Café Le Dôme, 108 Boulevard du Montparnasse, 75014 Paris",
		&[
			("venue", "Café Le Dôme"),
			("house_number", "108"),
			("street", "Boulevard du Montparnasse"),
			("postcode", "75014"),
			("locality", "Paris"),
		],
		"FR",
		None,
	)
}

fn assert_consistent(before: &Row, after: &Row) {
	assert_eq!(span_texts(after), span_texts(before));
	assert_eq!(after.tokens.len(), after.labels.len());
	token_spans(&after.chars(), &after.tokens).expect("every token is in the grouped text");
}

#[test]
fn wrapping_the_row_shifts_every_span_and_keeps_its_text() {
	let row = boston();
	let wrapped = wrap_row(&row, ("\"", "\"")).unwrap();
	assert_eq!(wrapped.raw, "\"123 Main St, Boston, MA 02111, USA\"");
	assert_eq!(wrapped.tokens[0], "\"123");
	assert_eq!(wrapped.labels, row.labels);
	assert_consistent(&row, &wrapped);
}

#[test]
fn wrapping_a_venue_leaves_the_guillemets_outside_its_span() {
	let row = cafe();
	let wrapped = wrap_span(&row, &["venue"], ("«", "»"))
		.unwrap()
		.expect("a wrapped copy");
	assert!(wrapped.raw.starts_with("«Café Le Dôme», 108"), "{}", wrapped.raw);
	assert_consistent(&row, &wrapped);
}

#[test]
fn bracketing_a_trailing_country() {
	let row = boston();
	let wrapped = wrap_span(&row, &["country"], ("(", ")"))
		.unwrap()
		.expect("a wrapped copy");
	assert!(wrapped.raw.ends_with("MA 02111, (USA)"), "{}", wrapped.raw);
	assert_consistent(&row, &wrapped);
}

#[test]
fn a_cjk_row_is_wrapped_in_a_full_width_pair() {
	let row = make_row(
		"東京都港区六本木6-10-1",
		&[
			("region", "東京都"),
			("locality", "港区"),
			("dependent_locality", "六本木"),
			("house_number", "6-10-1"),
		],
		"JP",
		Some(&["東京都港区六本木6-10-1"]),
	);
	for seed in 0..10 {
		let grouped = group_row(&row, &mut rng(seed)).unwrap().expect("a grouped copy");
		assert!(
			"「（『【".contains(grouped.raw.chars().next().unwrap()),
			"seed {seed}: {}",
			grouped.raw
		);
		assert_consistent(&row, &grouped);
	}
}

#[test]
fn every_variant_keeps_the_spans_across_seeds() {
	for row in [boston(), cafe()] {
		for seed in 0..40 {
			let grouped = group_row(&row, &mut rng(seed)).unwrap().expect("a grouped copy");
			assert_consistent(&row, &grouped);
		}
	}
}

#[test]
fn a_note_appends_unlabeled_tokens() {
	let row = boston();
	for seed in 0..40 {
		let grouped = group_row(&row, &mut rng(seed)).unwrap().expect("a grouped copy");
		if grouped.raw.ends_with(')') && !grouped.raw.ends_with("(USA)") {
			assert!(grouped.raw.starts_with("123"));
			let appended = &grouped.labels[row.labels.len()..];
			assert!(
				!appended.is_empty() && appended.iter().all(|l| l == "O"),
				"{appended:?}"
			);
			return;
		}
	}
	panic!("no seed in 0..39 chose the note variant");
}

fn rows(p: &AugmentProbabilities, seed: i128, move_prob: f64) -> (Vec<Row>, Vec<u32>) {
	let layouts = layouts();
	let mut generator = rng(seed);
	let out = augment_row(
		&boston(),
		&mut generator,
		p,
		move_prob,
		Some(&layouts),
		&mut PostcodeMoveOutcomes::default(),
	)
	.into_iter()
	.map(|r| r.unwrap())
	.collect();
	(out, (0..4).map(|_| generator.next_u32()).collect())
}

#[test]
fn the_knob_at_zero_leaves_the_stream_bit_identical() {
	let base = AugmentProbabilities {
		directional: 0.3,
		region: 0.3,
		case: 0.2,
		..Default::default()
	};
	for seed in 0..20 {
		let grouped = AugmentProbabilities { grouping: 0.0, ..base };
		assert_eq!(rows(&base, seed, 0.2), rows(&grouped, seed, 0.2), "seed {seed}");
	}
}

#[test]
fn grouping_draws_last_so_earlier_copies_are_unchanged() {
	let base = AugmentProbabilities {
		directional: 1.0,
		region: 1.0,
		case: 1.0,
		..Default::default()
	};
	let (without, _) = rows(&base, 3, 0.0);
	let (with, _) = rows(&AugmentProbabilities { grouping: 1.0, ..base }, 3, 0.0);
	assert_eq!(with[..without.len()], without[..]);
	assert_eq!(with.len(), without.len() + 1);
}
