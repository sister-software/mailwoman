// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The stream's contract: row limits, exhaustion, the astral skip, source restarts, held-out quotas, observer
//! events, cancellation, the `seed + epoch` reopening and the refusal of a missing or unverifiable file.

mod common;

use common::{config, fixture_row, tagged_row, write_corpus_parquet, WriteOptions};
use mtf_sampler::corpus_files::file_sha256;
use mtf_sampler::{CancelToken, Error, Event, Observer, Row, Sampler, SkipReason, TrainingBatches};
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<Event>>>);

impl Observer for Recorder {
	fn event(&mut self, event: &Event) {
		self.0.lock().unwrap().push(event.clone());
	}
}

impl Recorder {
	fn events(&self) -> Vec<Event> {
		self.0.lock().unwrap().clone()
	}
}

/// A manifest-less corpus: `big` with 30 rows in row groups of 4, `small` with 5 rows, and a val split of two files.
fn corpus(root: &Path) -> std::path::PathBuf {
	let corpus = root.join("corpus");
	let o = WriteOptions::default();
	let big: Vec<Row> = (0..30).map(|i| fixture_row(i, "US", "big")).collect();
	let small: Vec<Row> = (0..5).map(|i| fixture_row(i, "US", "small")).collect();
	write_corpus_parquet(&big, &corpus.join("train/part-big.parquet"), 4, &o);
	write_corpus_parquet(&small, &corpus.join("train/part-small.parquet"), 4, &o);
	let val_a: Vec<Row> = (0..40).map(|i| fixture_row(i, "US", "big")).collect();
	let val_b: Vec<Row> = (0..10).map(|i| fixture_row(i, "US", "small")).collect();
	write_corpus_parquet(&val_a, &corpus.join("val/part-a.parquet"), 8, &o);
	write_corpus_parquet(&val_b, &corpus.join("val/part-b.parquet"), 8, &o);
	corpus
}

fn base(corpus: &Path) -> mtf_sampler::SamplerConfig {
	config(
		corpus,
		json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0, "small": 1.0}, "shuffle_buffer": 4}),
	)
}

fn drain(sampler: &mut Sampler) -> Vec<Row> {
	sampler.rows().map(|r| r.unwrap()).collect()
}

#[test]
fn a_row_limit_caps_the_stream_and_exhaustion_is_none() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let mut limited = Sampler::open(&base(&corpus), "train", 7, Some(10)).unwrap();
	assert_eq!(drain(&mut limited).len(), 10);
	assert!(limited.next_row().unwrap().is_none());

	let mut whole = Sampler::open(&base(&corpus), "train", 7, None).unwrap();
	let rows = drain(&mut whole);
	assert!(rows.len() >= 35, "every source completes a pass: {}", rows.len());
	assert!(
		whole.next_row().unwrap().is_none(),
		"an exhausted stream stays exhausted"
	);
	assert_eq!(whole.next_batch(8).unwrap(), None);
}

#[test]
fn equal_seeds_draw_equal_rows_and_other_seeds_reorder_them() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let draw = |seed| drain(&mut Sampler::open(&base(&corpus), "train", seed, Some(20)).unwrap());
	assert_eq!(draw(3), draw(3));
	assert_ne!(draw(3), draw(4));
}

#[test]
fn a_small_source_restarts_until_every_source_completes_a_pass() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let recorder = Recorder::default();
	let mut sampler = Sampler::open_with(
		&base(&corpus),
		"train",
		7,
		None,
		CancelToken::default(),
		Some(Box::new(recorder.clone())),
	)
	.unwrap();
	let rows = drain(&mut sampler);
	let events = recorder.events();
	let restarts: Vec<&Event> = events
		.iter()
		.filter(|e| matches!(e, Event::SourceRestarted { source, .. } if source == "small"))
		.collect();
	assert!(
		!restarts.is_empty(),
		"the 5-row source restarts while the 30-row source reads its pass"
	);
	let Some(Event::EpochComplete { realized }) = events.iter().find(|e| matches!(e, Event::EpochComplete { .. }))
	else {
		panic!("no epoch_complete event");
	};
	let big = realized.iter().find(|(s, _)| s == "big").unwrap().1;
	assert_eq!(big, 30, "the largest source is read exactly once");
	assert_eq!(realized.iter().map(|(_, n)| n).sum::<u64>(), rows.len() as u64);
	let emitted: Vec<u64> = events
		.iter()
		.filter_map(|e| match e {
			Event::RowEmitted { index, .. } => Some(*index),
			_ => None,
		})
		.collect();
	assert_eq!(emitted, (0..rows.len() as u64).collect::<Vec<_>>());
}

#[test]
fn an_astral_offset_row_is_skipped_and_reported_but_counts_toward_the_limit() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let mut rows: Vec<Row> = (0..6).map(|i| fixture_row(i, "US", "only")).collect();
	// The TS build stores UTF-16 offsets: `𦑃` is two units, so the span ends one past the code-point length.
	let mut astral = tagged_row(
		"𦑃 1",
		&[("𦑃".into(), "street"), ("1".into(), "house_number")],
		"US",
		"only",
	);
	astral.spans.as_mut().unwrap().ends = vec![2, 4];
	astral.spans.as_mut().unwrap().starts = vec![0, 3];
	rows.push(astral);
	write_corpus_parquet(&rows, &corpus.join("train/part.parquet"), 8, &WriteOptions::default());
	let config = config(&corpus, json!({"country_weights": {"US": 1.0}, "shuffle_buffer": 2}));
	let recorder = Recorder::default();
	let mut sampler = Sampler::open_with(
		&config,
		"train",
		1,
		Some(7),
		CancelToken::default(),
		Some(Box::new(recorder.clone())),
	)
	.unwrap();
	let yielded = drain(&mut sampler);
	assert_eq!(
		yielded.len(),
		6,
		"seven rows are emitted and the astral one is not yielded"
	);
	assert_eq!(sampler.astral_skipped(), 1);
	assert!(recorder.events().iter().any(|e| matches!(
		e,
		Event::RowSkipped { reason: SkipReason::AstralOffsets, raw, .. } if raw == "𦑃 1"
	)));

	let dropped = mtf_sampler::SamplerConfig {
		drop_spans: true,
		..config.clone()
	};
	let mut tokens = Sampler::open(&dropped, "train", 1, Some(7)).unwrap();
	let rows = drain(&mut tokens);
	assert_eq!(rows.len(), 7, "with the spans dropped no row has offsets to check");
	assert!(rows.iter().all(|r| r.spans.is_none()));
}

#[test]
fn a_held_out_limit_takes_rows_from_every_file_in_proportion() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	// 40 and 10 rows: a 10-row draw is a share of 8 and 2, both whole, so no fractional draw changes them.
	let mut sampler = Sampler::open(&base(&corpus), "val", 5, Some(10)).unwrap();
	let rows = drain(&mut sampler);
	assert_eq!(rows.len(), 10);
	assert_eq!(rows.iter().filter(|r| r.source == "big").count(), 8);
	assert_eq!(rows.iter().filter(|r| r.source == "small").count(), 2);

	let mut all = Sampler::open(&base(&corpus), "val", 5, None).unwrap();
	assert_eq!(
		drain(&mut all).len(),
		50,
		"without a limit the held-out files stream whole"
	);
}

#[test]
fn a_held_out_stream_is_neither_weighted_nor_augmented() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let mut augmented = base(&corpus);
	augmented.augment.directional = 1.0;
	augmented.augment.case = 1.0;
	let mut sampler = Sampler::open(&augmented, "val", 5, None).unwrap();
	assert_eq!(drain(&mut sampler).len(), 50, "no augmented copies on a held-out split");
}

#[test]
fn training_batches_reopen_with_seed_plus_epoch_and_skip_resumed_batches() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let config = base(&corpus);
	let epoch = |seed: i128| -> Vec<Vec<Row>> {
		let mut s = Sampler::open(&config, "train", seed, None).unwrap();
		s.batches(8).map(|b| b.unwrap()).collect()
	};
	let expected: Vec<Vec<Row>> = epoch(11).into_iter().chain(epoch(12)).collect();
	let mut stream = TrainingBatches::new(config.clone(), 8, 10, None, 0, CancelToken::default());
	let mut actual = Vec::new();
	for _ in 0..expected.len() {
		actual.push(stream.next_batch().unwrap());
	}
	assert_eq!(
		actual, expected,
		"epoch 1 reads seed 11 and epoch 2 seed 12, each ending with its partial batch"
	);
	assert_eq!(stream.epoch(), 2);

	let mut resumed = TrainingBatches::new(config, 8, 10, None, 3, CancelToken::default());
	assert_eq!(
		resumed.next_batch().unwrap(),
		expected[3],
		"a resumed stream continues at the batch it stopped at"
	);
}

#[test]
fn an_epoch_without_rows_is_an_error() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	// The one row is skipped for its astral offsets, so the epoch yields nothing.
	let mut astral = tagged_row(
		"𦑃 1",
		&[("𦑃".into(), "street"), ("1".into(), "house_number")],
		"US",
		"only",
	);
	astral.spans.as_mut().unwrap().ends = vec![2, 4];
	astral.spans.as_mut().unwrap().starts = vec![0, 3];
	write_corpus_parquet(
		&[astral],
		&corpus.join("train/part.parquet"),
		8,
		&WriteOptions::default(),
	);
	let config = config(&corpus, json!({"country_weights": {"US": 1.0}}));
	let mut stream = TrainingBatches::new(config.clone(), 8, 1, None, 0, CancelToken::default());
	let error = stream.next_batch().expect_err("an error");
	assert!(
		error.to_string().contains("yielded no rows in epoch 1 (seed 2)"),
		"{error}"
	);

	// A limit of 0 still emits one row, as the Python stream did.
	let ok = dir.path().join("ok");
	write_corpus_parquet(
		&[fixture_row(0, "US", "only")],
		&ok.join("train/part.parquet"),
		8,
		&WriteOptions::default(),
	);
	let mut limited = TrainingBatches::new(config_for(&ok), 8, 1, Some(0), 0, CancelToken::default());
	assert_eq!(limited.next_batch().unwrap().len(), 1);
}

fn config_for(corpus: &Path) -> mtf_sampler::SamplerConfig {
	config(corpus, json!({"country_weights": {"US": 1.0}}))
}

#[test]
fn a_cancelled_stream_returns_cancelled() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let cancel = CancelToken::default();
	let mut sampler = Sampler::open_with(&base(&corpus), "train", 7, None, cancel.clone(), None).unwrap();
	assert!(sampler.next_row().unwrap().is_some());
	cancel.cancel();
	let mut saw_cancelled = false;
	for _ in 0..100 {
		match sampler.next_row() {
			Err(Error::Cancelled) => {
				saw_cancelled = true;
				break;
			}
			Ok(Some(_)) => continue,
			other => panic!("unexpected {other:?}"),
		}
	}
	assert!(saw_cancelled);
}

fn manifest(corpus: &Path, files: serde_json::Value) {
	std::fs::create_dir_all(corpus).unwrap();
	std::fs::write(corpus.join("MANIFEST.json"), json!({ "files": files }).to_string()).unwrap();
}

#[test]
fn a_manifest_file_that_resolves_nowhere_is_an_error_naming_it() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	manifest(
		&corpus,
		json!([{"path": "/nowhere/corpus/train/part-0.parquet", "split": "train", "sha256": "00"}]),
	);
	let error = Sampler::open(&base(&corpus), "train", 1, None).err().expect("an error");
	assert!(
		error.to_string().contains("/nowhere/corpus/train/part-0.parquet"),
		"{error}"
	);
}

#[test]
fn a_file_without_or_with_a_wrong_sha256_is_an_error() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let path = corpus.join("train/part-0.parquet");
	let rows: Vec<Row> = (0..3).map(|i| fixture_row(i, "US", "big")).collect();
	write_corpus_parquet(&rows, &path, 4, &WriteOptions::default());
	manifest(&corpus, json!([{"path": path, "split": "train"}]));
	let error = Sampler::open(&base(&corpus), "train", 1, None).err().expect("an error");
	assert!(error.to_string().contains("no sha256"), "{error}");

	manifest(&corpus, json!([{"path": path, "split": "train", "sha256": "ab"}]));
	let error = Sampler::open(&base(&corpus), "train", 1, None).err().expect("an error");
	assert!(error.to_string().contains("hashes to sha256"), "{error}");

	manifest(
		&corpus,
		json!([{"path": path, "split": "train", "sha256": file_sha256(&path).unwrap()}]),
	);
	let config = config(
		&corpus,
		json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0}}),
	);
	assert_eq!(drain(&mut Sampler::open(&config, "train", 1, None).unwrap()).len(), 3);
}

#[test]
fn a_source_without_a_weight_or_a_stale_weight_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = corpus(dir.path());
	let unnamed = config(
		&corpus,
		json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0}}),
	);
	let error = Sampler::open(&unnamed, "train", 1, None).err().expect("an error");
	assert!(error.to_string().contains("absent from source_weights"), "{error}");

	let stale = config(
		&corpus,
		json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0, "small": 1.0, "gone": 2.0}}),
	);
	let error = Sampler::open(&stale, "train", 1, None).err().expect("an error");
	assert!(error.to_string().contains("\"gone\""), "{error}");

	let excluded = config(
		&corpus,
		json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0, "small": 1.0},
			"augment_exclude_sources": ["retired"]}),
	);
	let error = Sampler::open(&excluded, "train", 1, None).err().expect("an error");
	assert!(error.to_string().contains("retired"), "{error}");
}

#[test]
fn a_split_attribute_filters_rows_by_source_id() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let path = corpus.join("data.parquet");
	let rows: Vec<Row> = (0..9).map(|i| fixture_row(i, "US", "big")).collect();
	let ids: Vec<Option<String>> = (0..9).map(|i| Some(format!("id-{i}"))).collect();
	write_corpus_parquet(
		&rows,
		&path,
		4,
		&WriteOptions {
			source_ids: Some(ids),
			..Default::default()
		},
	);
	let digest = file_sha256(&path).unwrap();
	let attribute = corpus.join("data.split.json");
	std::fs::write(
		&attribute,
		json!({"attribute": "split", "policyHash": "p", "file": {"sha256": digest}, "val": ["id-1", "id-2"], "test": ["id-3"]})
			.to_string(),
	)
	.unwrap();
	manifest(
		&corpus,
		json!([{"path": path, "sha256": digest, "split_attribute": {"path": attribute, "sha256": file_sha256(&attribute).unwrap(), "policy_hash": "p"}}]),
	);
	let config = config(
		&corpus,
		json!({"country_weights": {"US": 1.0}, "source_weights": {"big": 1.0}}),
	);
	let raws = |split: &str| -> Vec<String> {
		let mut r: Vec<String> = drain(&mut Sampler::open(&config, split, 1, None).unwrap())
			.into_iter()
			.map(|r| r.raw)
			.collect();
		r.sort();
		r
	};
	assert_eq!(raws("train").len(), 6);
	assert_eq!(raws("val"), {
		let mut v = vec![rows[1].raw.clone(), rows[2].raw.clone()];
		v.sort();
		v
	});
	assert_eq!(raws("test"), vec![rows[3].raw.clone()]);
	let counts = mtf_sampler::corpus_files::source_row_counts(&config, "train").unwrap();
	assert_eq!(counts, vec![("big".to_owned(), 6)]);
}
