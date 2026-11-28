// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A `draw_weight` column moves a train source's draws between its rows in proportion to the weights, leaves the
//! source's share of the mixture where `source_weights` puts it, reads 1.0 for a file of the source without the
//! column, and is refused when a weight is not a positive finite number.
mod common;

use common::{config, fixture_row, write_corpus_parquet, WriteOptions};
use mtf_sampler::{Row, Sampler};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;

fn lane(source: &str, prefix: &str, n: usize) -> Vec<Row> {
	(0..n)
		.map(|i| Row {
			raw: format!("{prefix}{i} quiet lane"),
			tokens: vec![format!("{prefix}{i}"), "quiet".into(), "lane".into()],
			labels: vec!["O".into(); 3],
			country: Some("US".into()),
			source: source.into(),
			source_id: None,
			spans: None,
		})
		.collect()
}

fn write(path: &Path, rows: &[Row], draw_weights: Option<Vec<Option<f64>>>) {
	let options = WriteOptions {
		without_spans: true,
		draw_weights,
		..Default::default()
	};
	write_corpus_parquet(rows, path, 16, &options);
}

fn draw(corpus: &Path, settings: serde_json::Value, rows: u64) -> Vec<Row> {
	Sampler::open(&config(corpus, settings), "train", 7, Some(rows))
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect()
}

#[test]
fn draws_follow_the_weights_inside_a_source_and_the_source_share_stays_put() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	// `alpha`'s heavy rows weigh 3.0 and sit in a file with the column; its light rows sit in a file without one, so
	// they read 1.0 and the source's bound is 3.0.
	write(
		&corpus.join("train/alpha-heavy.parquet"),
		&lane("alpha", "h", 40),
		Some(vec![Some(3.0); 40]),
	);
	write(&corpus.join("train/alpha-light.parquet"), &lane("alpha", "l", 40), None);
	write(&corpus.join("train/beta.parquet"), &lane("beta", "b", 20_000), None);
	let settings = json!({
		"country_weights": {"US": 1.0},
		"source_weights": {"alpha": 1.0, "beta": 1.0},
		"coarse_filter": false,
		"shuffle_buffer": 1,
	});
	let rows = draw(&corpus, settings, 16_000);
	let mut by_row: BTreeMap<&str, u64> = BTreeMap::new();
	for row in rows.iter().filter(|r| r.source == "alpha") {
		*by_row.entry(row.raw.as_str()).or_default() += 1;
	}
	let mean = |prefix: char| -> f64 {
		let counts: Vec<u64> = (0..40)
			.map(|i| {
				by_row
					.get(format!("{prefix}{i} quiet lane").as_str())
					.copied()
					.unwrap_or(0)
			})
			.collect();
		counts.iter().sum::<u64>() as f64 / counts.len() as f64
	};
	let (heavy, light) = (mean('h'), mean('l'));
	// About 8,000 alpha draws over 80 rows: 150 per heavy row and 50 per light row.
	assert!(light > 0.0, "every light row keeps a chance to be drawn");
	let ratio = heavy / light;
	assert!(
		(2.7..3.3).contains(&ratio),
		"heavy/light draws {heavy}/{light} = {ratio}, expected about 3"
	);
	let alpha = rows.iter().filter(|r| r.source == "alpha").count() as f64 / rows.len() as f64;
	assert!(
		(0.48..0.52).contains(&alpha),
		"alpha took {alpha} of the draws, and its weight is half"
	);
}

#[test]
fn a_uniform_column_draws_the_rows_a_file_without_one_draws() {
	let countries = ["US", "FR", "GB"];
	let rows: Vec<Row> = (0..60).map(|i| fixture_row(i, countries[i % 3], "alpha")).collect();
	let read = |weights: Option<Vec<Option<f64>>>| -> Vec<String> {
		let dir = tempfile::tempdir().unwrap();
		let corpus = dir.path().join("corpus");
		let options = WriteOptions {
			draw_weights: weights,
			..Default::default()
		};
		write_corpus_parquet(&rows, &corpus.join("train/alpha.parquet"), 8, &options);
		let settings = json!({"source_weights": {"alpha": 1.0}, "coarse_filter": false, "shuffle_buffer": 4});
		draw(&corpus, settings, 200).into_iter().map(|r| r.raw).collect()
	};
	// The fixture's countries weigh 1.0, 0.6 and 0.25, so the country acceptance draw runs on two rows in three.
	assert_eq!(read(Some(vec![Some(1.0); 60])), read(None));
}

#[test]
fn a_weight_that_is_not_positive_and_finite_is_refused() {
	for bad in [Some(0.0), Some(-1.0), Some(f64::NAN), None] {
		let dir = tempfile::tempdir().unwrap();
		let corpus = dir.path().join("corpus");
		let mut weights = vec![Some(1.0); 8];
		weights[3] = bad;
		write(
			&corpus.join("train/alpha.parquet"),
			&lane("alpha", "a", 8),
			Some(weights),
		);
		let settings =
			json!({"country_weights": {"US": 1.0}, "source_weights": {"alpha": 1.0}, "coarse_filter": false});
		let error = Sampler::open(&config(&corpus, settings), "train", 7, Some(10))
			.err()
			.expect("a refusal");
		assert!(error.to_string().contains("draw_weight"), "{error}");
	}
}
