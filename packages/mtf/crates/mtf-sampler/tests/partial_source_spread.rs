// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A row-limited epoch that reads part of a source draws from all of its row groups in proportion, rather than from
//! one contiguous block.
//!
//! The fixture source stores one row shape in its first half of row groups and another in the rest, as a corpus build
//! that writes a source's layers in order does. An epoch that reads a quarter of the source file by file draws from
//! one file's first few row groups, so its share of the shape swings from 0 to 1 across seeds.

mod common;

use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::{CancelToken, RawRows, Row, Sampler, SamplerConfig};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const FILES: usize = 3;
const GROUPS_PER_FILE: usize = 4;
const GROUP_ROWS: usize = 2_000;
const GROUPED_ROWS: usize = FILES * GROUPS_PER_FILE * GROUP_ROWS;
const OTHER_ROWS: usize = 400;

fn row(raw: String, source: &str) -> Row {
	let tokens: Vec<String> = raw.split(' ').map(str::to_owned).collect();
	Row {
		labels: vec!["O".into(); tokens.len()],
		tokens,
		raw,
		country: Some("US".into()),
		source: source.into(),
		source_id: None,
		spans: None,
	}
}

/// Whether a row of the grouped source carries the shape.
fn shaped(row: &Row) -> bool {
	row.raw.contains(" Shape ")
}

/// The grouped source over three files of four row groups, the shape in the first six of its twelve row groups.
fn grouped_corpus(root: &Path) -> PathBuf {
	let corpus = root.join("corpus");
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	for file in 0..FILES {
		let rows: Vec<Row> = (0..GROUPS_PER_FILE * GROUP_ROWS)
			.map(|i| {
				let unit = file * GROUPS_PER_FILE + i / GROUP_ROWS;
				let shape = if unit < FILES * GROUPS_PER_FILE / 2 {
					"Shape"
				} else {
					"Plain"
				};
				row(format!("{file}-{i} {shape} St"), "grouped")
			})
			.collect();
		write_corpus_parquet(
			&rows,
			&corpus.join(format!("train/part-grouped-{file}.parquet")),
			GROUP_ROWS,
			&options,
		);
	}
	let other: Vec<Row> = (0..OTHER_ROWS).map(|i| row(format!("{i} Other Rd"), "other")).collect();
	write_corpus_parquet(&other, &corpus.join("train/part-other.parquet"), 1 << 20, &options);
	corpus
}

fn sampler_config(corpus: &Path) -> SamplerConfig {
	config(
		corpus,
		json!({
			"country_weights": {"US": 1.0},
			"source_weights": {"grouped": 3.0, "other": 1.0},
			"coarse_filter": false,
			"shuffle_buffer": 1,
		}),
	)
}

/// An epoch's rows: `limit × 3/4` expected from the grouped source.
fn epoch(config: &SamplerConfig, seed: i128, limit: u64) -> Vec<Row> {
	Sampler::open(config, "train", seed, Some(limit))
		.unwrap()
		.rows()
		.map(|r| r.unwrap())
		.collect()
}

#[test]
fn an_epoch_reading_part_of_a_source_draws_its_shape_at_the_source_share() {
	let dir = tempfile::tempdir().unwrap();
	let config = sampler_config(&grouped_corpus(dir.path()));
	// 8,000 rows: 6,000 expected from the grouped source, a quarter of its 24,000.
	let limit = 8_000;
	for seed in 1..=8 {
		let rows = epoch(&config, seed, limit);
		let grouped: Vec<&Row> = rows.iter().filter(|r| r.source == "grouped").collect();
		let share = grouped.iter().filter(|r| shaped(r)).count() as f64 / grouped.len() as f64;
		assert!(
			(share - 0.5).abs() < 0.05,
			"seed {seed}: the shape is {share:.3} of {} grouped draws against 0.5 of the source",
			grouped.len()
		);
		let drawn = grouped.len() as f64 / limit as f64;
		assert!(
			(drawn - 0.75).abs() < 0.03,
			"seed {seed}: the grouped source took {drawn:.3} of the epoch against its 0.75 weight"
		);
	}
}

#[test]
fn a_short_last_row_group_is_drawn_in_proportion_when_the_visit_floor_binds() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	// Each file: four full groups of plain rows, then a 200-row last group of shaped rows. The shape is 600 of the
	// source's 24,600 rows, 2.4%.
	for file in 0..FILES {
		let rows: Vec<Row> = (0..GROUPS_PER_FILE * GROUP_ROWS + 200)
			.map(|i| {
				let shape = if i >= GROUPS_PER_FILE * GROUP_ROWS {
					"Shape"
				} else {
					"Plain"
				};
				row(format!("{file}-{i} {shape} St"), "grouped")
			})
			.collect();
		write_corpus_parquet(
			&rows,
			&corpus.join(format!("train/part-grouped-{file}.parquet")),
			GROUP_ROWS,
			&options,
		);
	}
	let other: Vec<Row> = (0..OTHER_ROWS).map(|i| row(format!("{i} Other Rd"), "other")).collect();
	write_corpus_parquet(&other, &corpus.join("train/part-other.parquet"), 1 << 20, &options);
	let config = sampler_config(&corpus);
	// 4,000 rows: 3,000 expected from the grouped source, 12% of it, so the 256-row floor binds on a 2,000-row group.
	let (mut shaped_draws, mut grouped_draws) = (0usize, 0usize);
	for seed in 1..=16 {
		for row in epoch(&config, seed, 4_000).iter().filter(|r| r.source == "grouped") {
			grouped_draws += 1;
			shaped_draws += usize::from(shaped(row));
		}
	}
	let share = shaped_draws as f64 / grouped_draws as f64;
	assert!(
		(share - 600.0 / 24_600.0).abs() < 0.01,
		"the short groups' shape is {share:.4} of {grouped_draws} draws against 0.0244 of the source"
	);
}

#[test]
fn equal_seeds_draw_equal_spread_epochs() {
	let dir = tempfile::tempdir().unwrap();
	let config = sampler_config(&grouped_corpus(dir.path()));
	let raws = |seed| {
		epoch(&config, seed, 4_000)
			.into_iter()
			.map(|r| r.raw)
			.collect::<Vec<_>>()
	};
	assert_eq!(raws(5), raws(5));
	assert_ne!(raws(5), raws(6));
}

#[test]
fn a_spread_pass_reads_every_row_once() {
	let dir = tempfile::tempdir().unwrap();
	let config = sampler_config(&grouped_corpus(dir.path()));
	// The raw stream plans with its row limit and draws until the epoch ends, which is the grouped source's first
	// complete pass: the other source cycles many times before it.
	let mut stream = RawRows::open(&config, "train", 3, Some(4_000), CancelToken::default(), None).unwrap();
	let mut grouped = Vec::new();
	while let Some(row) = stream.next_raw().unwrap() {
		if row.source == "grouped" {
			grouped.push(row.raw);
		}
	}
	assert_eq!(
		grouped.len(),
		GROUPED_ROWS,
		"the pass read some row twice or left one out"
	);
	assert_eq!(grouped.iter().collect::<BTreeSet<_>>().len(), GROUPED_ROWS);
}

#[test]
fn a_source_the_epoch_reads_in_full_reads_as_an_unlimited_stream_does() {
	let dir = tempfile::tempdir().unwrap();
	let config = sampler_config(&grouped_corpus(dir.path()));
	// At 40,000 rows the grouped source expects 30,000 draws, more than it holds, so every source reads file by file
	// and the limit only truncates the stream.
	let limit = 40_000;
	let limited: Vec<String> = epoch(&config, 9, limit).into_iter().map(|r| r.raw).collect();
	let unlimited: Vec<String> = Sampler::open(&config, "train", 9, None)
		.unwrap()
		.rows()
		.take(limit as usize)
		.map(|r| r.unwrap().raw)
		.collect();
	assert_eq!(limited, unlimited);
}
