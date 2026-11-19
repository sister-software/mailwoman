// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The startup progress of a split: `index_split`'s totals, which the counting threads add up, match the per-source
//! counts of the same split, and the listing reports every file it checks with the bytes it hashed.

mod common;

use mtf_sampler::corpus_files::{
	corpus_split_files, corpus_split_files_with, index_split, source_row_counts, ListProgress, SplitIndex,
};
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

#[test]
fn the_listing_reports_each_file_checked_and_the_bytes_it_hashed() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = common::build_reference_corpus(dir.path());
	let config = common::config(&corpus, serde_json::json!({}));
	let last = Mutex::new(ListProgress::default());
	let files = corpus_split_files_with(&config, "train", &|p| *last.lock().unwrap() = p).unwrap();
	let sizes: u64 = files.iter().map(|f| std::fs::metadata(&f.path).unwrap().len()).sum();
	let first = *last.lock().unwrap();
	assert_eq!(
		(first.checked, first.files, first.bytes_hashed),
		(files.len(), files.len(), sizes)
	);
	// The files are now in the process's verified set, so a second listing checks them without hashing.
	corpus_split_files_with(&config, "train", &|p| *last.lock().unwrap() = p).unwrap();
	let second = *last.lock().unwrap();
	assert_eq!((second.checked, second.bytes_hashed), (files.len(), 0));
}
