// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The stream's start state: a configuration whose shuffle buffer holds no row is refused at parse, and a held-out
//! split whose start fails returns that failure on every later call. `file_rows.rs` tests the same for one file.

use mtf_sampler::corpus_files::CorpusFile;
use mtf_sampler::mixture::HeldOut;
use mtf_sampler::pyrandom::{PyRandom, Seed};
use mtf_sampler::sampler::Shared;
use mtf_sampler::{CancelToken, SamplerConfig, Weights};

fn shared() -> Shared {
	Shared {
		country_weights: Weights(vec![("US".into(), 1.0)]),
		max_country_weight: 1.0,
		coarse_filter: false,
		active_tags: Default::default(),
		source_weights: None,
		cancel: CancelToken::default(),
		observer: None,
	}
}

#[test]
fn a_shuffle_buffer_of_zero_is_refused_by_name() {
	let text = serde_json::json!({
		"corpus_dir": "/nonexistent",
		"country_weights": {"US": 1.0},
		"active_tags": ["street"],
		"shuffle_buffer": 0,
	})
	.to_string();
	let refusal = SamplerConfig::from_json(&text).unwrap_err().to_string();
	assert!(refusal.contains("shuffle_buffer"), "{refusal}");
}

#[test]
fn a_held_out_split_whose_start_failed_fails_again() {
	let missing = CorpusFile {
		path: "/nonexistent/val/part-a.parquet".into(),
		filter: None,
	};
	let mut held_out = HeldOut::new(vec![missing], "val", Some(10));
	let mut rng = PyRandom::new(Seed::Int(7));
	let shared = shared();
	let first = held_out.next(&mut rng, &shared).unwrap_err();
	let second = held_out.next(&mut rng, &shared).unwrap_err();
	assert_eq!(first, second);
}
