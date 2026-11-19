// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `index_split`'s totals, which the counting threads add up, match the per-source counts of the same split.

mod common;

use mtf_sampler::corpus_files::{corpus_split_files, index_split, source_row_counts, SplitIndex};
use std::sync::Mutex;

#[test]
fn the_index_counts_every_file_row_and_source_and_reports_each_file() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = common::build_reference_corpus(dir.path());
	let config = common::config(&corpus, serde_json::json!({}));
	let files = corpus_split_files(&config, "train").unwrap();
	let sources = source_row_counts(&config, "train").unwrap();
	let expected = SplitIndex {
		files: files.len(),
		rows: sources.iter().map(|(_, n)| n).sum(),
		sources: sources.len(),
	};
	assert!(expected.files > 1 && expected.sources > 1, "{expected:?}");
	let reported = Mutex::new(Vec::new());
	let index = index_split(&files, &|i| reported.lock().unwrap().push(i.files)).unwrap();
	assert_eq!(index, expected);
	let mut reported = reported.into_inner().unwrap();
	reported.sort_unstable();
	assert_eq!(reported, (1..=files.len()).collect::<Vec<_>>());
}
