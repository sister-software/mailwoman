// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The epochs of one run read a spread source's rows in turn, so a run whose draws equal the source's rows reads
//! nearly every row once.
//!
//! An epoch seeded alone reads a fresh random part of each row group. Over `E` epochs that each read `1/E` of the
//! source, about `(1 - 1/E)^E` of its rows, 34% at eight epochs, are never read.

mod common;

use common::{config, write_corpus_parquet, WriteOptions};
use mtf_sampler::{CancelToken, Row, SamplerConfig, TrainingBatches};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const FILES: usize = 3;
const GROUPS_PER_FILE: usize = 4;
const GROUP_ROWS: usize = 2_000;
const SPREAD_ROWS: usize = FILES * GROUPS_PER_FILE * GROUP_ROWS;
const EPOCHS: u64 = 8;

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

/// A spread source of 24,000 rows over twelve row groups, and a small source the epochs read in full.
fn corpus(root: &Path) -> PathBuf {
	let corpus = root.join("corpus");
	let options = WriteOptions {
		without_spans: true,
		..Default::default()
	};
	for file in 0..FILES {
		let rows: Vec<Row> = (0..GROUPS_PER_FILE * GROUP_ROWS)
			.map(|i| row(format!("{file}-{i} Spread St"), "spread"))
			.collect();
		write_corpus_parquet(&rows, &corpus.join(format!("train/part-spread-{file}.parquet")), GROUP_ROWS, &options);
	}
	let other: Vec<Row> = (0..400).map(|i| row(format!("{i} Other Rd"), "other")).collect();
	write_corpus_parquet(&other, &corpus.join("train/part-other.parquet"), 1 << 20, &options);
	corpus
}

fn sampler_config(corpus: &Path) -> SamplerConfig {
	config(
		corpus,
		json!({
			"country_weights": {"US": 1.0},
			"source_weights": {"spread": 3.0, "other": 1.0},
			"coarse_filter": false,
			"shuffle_buffer": 1,
		}),
	)
}

/// The draws of each spread row over `EPOCHS` epochs that each expect `SPREAD_ROWS / EPOCHS` spread draws.
fn draws_per_row(config: SamplerConfig, seed: i128) -> BTreeMap<String, u32> {
	// The spread source takes 3/4 of an epoch, so an epoch of 4,000 rows expects 3,000 spread draws, 1/8 of the source.
	let epoch_rows = (SPREAD_ROWS as u64 / EPOCHS) * 4 / 3;
	let mut batches = TrainingBatches::new(config, 100, seed, Some(epoch_rows), 0, CancelToken::default());
	let mut draws = BTreeMap::new();
	loop {
		let rows = batches.next_batch().unwrap();
		if batches.epoch() > EPOCHS {
			break;
		}
		for row in rows.into_iter().filter(|r| r.source == "spread") {
			*draws.entry(row.raw).or_insert(0) += 1;
		}
	}
	draws
}

#[test]
fn a_run_reads_a_spread_source_in_turn_across_its_epochs() {
	let dir = tempfile::tempdir().unwrap();
	let config = sampler_config(&corpus(dir.path()));
	for seed in [1, 7] {
		let draws = draws_per_row(config.clone(), seed);
		let total: u32 = draws.values().sum();
		let read = draws.len() as f64 / SPREAD_ROWS as f64;
		let repeated = draws.values().filter(|&&n| n > 1).count();
		assert!(
			read > 0.9,
			"seed {seed}: the run read {} of {SPREAD_ROWS} spread rows ({read:.3}) over {total} draws",
			draws.len()
		);
		assert!(
			(repeated as f64) < 0.1 * SPREAD_ROWS as f64,
			"seed {seed}: {repeated} spread rows were read more than once over {total} draws"
		);
	}
}
