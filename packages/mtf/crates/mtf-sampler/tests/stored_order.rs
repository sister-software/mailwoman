// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `read_order: stored` reads every admitted train row exactly once: the sources in the order `source_weights` lists
//! them, each source's files in the manifest's order, each file's row groups ascending and each group's rows as
//! stored. The training batches end with the files rather than opening a second epoch, and the rows a check refused
//! are counted.

mod common;

use common::{config, fixture_row, write_corpus_parquet, WriteOptions};
use mtf_sampler::corpus_files::file_sha256;
use mtf_sampler::{CancelToken, Row, RowDrops, TrainingBatches};
use serde_json::{json, Value};
use std::path::Path;

/// The countries the rows cycle through. `DE` is absent from the weights, so its rows are refused and counted.
const COUNTRIES: [&str; 3] = ["US", "FR", "DE"];

/// Writes `n` rows of `source`, each with the `source_id` `<name>:<i>`, in row groups of 3. Returns the manifest
/// entry and the ids of the rows the weights admit, in stored order.
fn write(path: &Path, name: &str, source: &str, n: usize) -> (Value, Vec<String>) {
	let rows: Vec<Row> = (0..n)
		.map(|i| fixture_row(i, COUNTRIES[i % COUNTRIES.len()], source))
		.collect();
	let ids: Vec<String> = (0..n).map(|i| format!("{name}:{i}")).collect();
	let options = WriteOptions {
		without_spans: false,
		source_ids: Some(ids.iter().cloned().map(Some).collect()),
	};
	write_corpus_parquet(&rows, path, 3, &options);
	let entry =
		json!({"split": "train", "path": path, "source": source, "rows": n, "sha256": file_sha256(path).unwrap()});
	let admitted = ids
		.into_iter()
		.enumerate()
		.filter(|(i, _)| COUNTRIES[i % COUNTRIES.len()] != "DE")
		.map(|(_, id)| id)
		.collect();
	(entry, admitted)
}

#[test]
fn a_stored_order_run_reads_each_row_once_in_stored_order_and_ends() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	// The manifest lists the postcode files first and `b2` before `b1`, so path order and listed order disagree.
	let (b2, b2_ids) = write(&corpus.join("train/b2.parquet"), "b2", "wof-postalcode", 4);
	let (a, a_ids) = write(&corpus.join("train/a.parquet"), "a", "wof-admin", 6);
	let (b1, b1_ids) = write(&corpus.join("train/b1.parquet"), "b1", "wof-postalcode", 3);
	std::fs::write(corpus.join("MANIFEST.json"), json!({"files": [b2, a, b1]}).to_string()).unwrap();
	let settings = |exclude: Value| {
		config(
			&corpus,
			json!({
				// FR weighs less than US, so a mixture would draw an acceptance test for each FR row.
				"country_weights": {"US": 1.0, "FR": 0.6},
				// Listed admin first: the stored read trains the coarser source first.
				"source_weights": {"wof-admin": 1.0, "wof-postalcode": 1.0},
				"augment": {"upper_case": 1.0},
				"augment_exclude_sources": exclude,
				"read_order": "stored",
			}),
		)
	};

	let mut batches = TrainingBatches::new(
		settings(json!(["wof-admin", "wof-postalcode"])),
		4,
		42,
		None,
		0,
		CancelToken::default(),
	);
	let mut read = Vec::new();
	let mut sizes = Vec::new();
	// A run whose max_steps exceeds the rows keeps asking; the batches end after the last row.
	for _ in 0..10 {
		let Some(rows) = batches.next_batch().unwrap() else {
			break;
		};
		sizes.push(rows.len());
		read.extend(rows.into_iter().map(|r| r.source_id.expect("a source_id")));
	}
	let stored: Vec<String> = a_ids.into_iter().chain(b2_ids).chain(b1_ids).collect();
	assert_eq!(
		read, stored,
		"every admitted row once, source by source, in listed file and stored row order"
	);
	assert_eq!(sizes, [4, 4, 1], "the final batch is the short remainder");
	assert_eq!(batches.next_batch().unwrap(), None, "the run stays ended");
	assert_eq!(batches.epoch(), 1, "the split is opened once, never a second epoch");
	let summary = batches.stored_summary().expect("a stored-order summary");
	assert_eq!(summary.yielded, 9);
	assert_eq!(
		summary.read,
		[("wof-admin".to_owned(), 4), ("wof-postalcode".to_owned(), 5)]
	);
	assert_eq!(
		summary.drops,
		RowDrops {
			filtered: 0,
			country: 4,
			coarse: 0
		},
		"each DE row is counted, not lost"
	);

	let refused = TrainingBatches::new(settings(json!(["wof-admin"])), 4, 42, None, 0, CancelToken::default())
		.next_batch()
		.unwrap_err()
		.to_string();
	assert!(
		refused.contains("absent from augment_exclude_sources") && refused.contains("wof-postalcode"),
		"{refused}"
	);
}
