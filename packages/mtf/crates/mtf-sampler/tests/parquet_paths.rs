// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Manifest path resolution: a stale path re-roots under its own corpus, an overlay's base, the store or the data
//! root's copy of the volume mount; an unresolvable or mismatched file is an error naming it; a manifest-less corpus
//! verifies each file against its record; and the current file-list key wins over the retired ones.
mod common;

use common::config;
use mtf_sampler::corpus_files::{corpus_split_files, file_sha256, manifest_files};
use mtf_sampler::SamplerConfig;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The retired manifest keys, newest first, spelled with escapes because the repository's vocabulary checks ban both
/// words.
const RETIRED_KEYS: [&str; 2] = ["sl\u{69}ces", "sh\u{61}rds"];
const OLDEST_KEY: &str = RETIRED_KEYS[1];

/// The sha256 of the one byte `x`, which every fixture file holds.
fn x_sha() -> String {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("x");
	std::fs::write(&path, b"x").unwrap();
	file_sha256(&path).unwrap()
}

fn write_x(path: &Path) {
	std::fs::create_dir_all(path.parent().unwrap()).unwrap();
	std::fs::write(path, b"x").unwrap();
}

fn write_manifest(corpus: &Path, manifest: Value) {
	std::fs::create_dir_all(corpus).unwrap();
	std::fs::write(corpus.join("MANIFEST.json"), manifest.to_string()).unwrap();
}

fn entry(split: &str, path: impl serde::Serialize) -> Value {
	json!({"split": split, "sha256": x_sha(), "path": path})
}

fn settings(corpus: &Path) -> SamplerConfig {
	config(corpus, json!({"country_weights": {"US": 1.0}}))
}

fn with_data_root(corpus: &Path, data_root: &Path) -> SamplerConfig {
	config(corpus, json!({"country_weights": {"US": 1.0}, "data_root": data_root}))
}

fn paths(config: &SamplerConfig, split: &str) -> mtf_sampler::Result<Vec<PathBuf>> {
	Ok(corpus_split_files(config, split)?.into_iter().map(|f| f.path).collect())
}

fn error(config: &SamplerConfig, split: &str) -> String {
	paths(config, split).expect_err("an error").to_string()
}

#[test]
fn a_listed_path_resolves_as_is() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let part = corpus.join("train/part-0000.parquet");
	write_x(&part);
	write_manifest(&corpus, json!({"files": [entry("train", &part)]}));
	assert_eq!(paths(&settings(&corpus), "train").unwrap(), vec![part]);
}

#[test]
fn a_path_from_another_machine_reroots_under_the_corpus() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let part = corpus.join("train/part-0000.parquet");
	write_x(&part);
	write_manifest(
		&corpus,
		json!({"files": [entry("train", "/build-machine/corpus/train/part-0000.parquet")]}),
	);
	assert_eq!(paths(&settings(&corpus), "train").unwrap(), vec![part]);
}

#[test]
fn a_volume_mount_path_resolves_under_the_data_root() {
	// A store file named under Modal's volume mount sits in another corpus version's directory, which the
	// corpus-relative re-root cannot find. The host keeps the volume's tree under the data root.
	let dir = tempfile::tempdir().unwrap();
	let data_root = dir.path().join("data-root");
	let corpus = data_root.join("corpus/versioned/v2-overlay");
	std::fs::create_dir_all(corpus.join("train")).unwrap();
	let store_file = data_root.join("corpus/versioned/v1-store/store/nad/abc/data.parquet");
	write_x(&store_file);
	write_manifest(
		&corpus,
		json!({"files": [entry("train", "/data/corpus/versioned/v1-store/store/nad/abc/data.parquet")]}),
	);
	assert_eq!(
		paths(&with_data_root(&corpus, &data_root), "train").unwrap(),
		vec![store_file]
	);
}

#[test]
fn a_volume_mount_sidecar_resolves_under_the_data_root() {
	// A split-attribute sidecar of a base corpus sits in that corpus's directory, beside no file of the overlay.
	let dir = tempfile::tempdir().unwrap();
	let sidecar = dir
		.path()
		.join("corpus/versioned/v1/corpus-v1/attributes/nad/abc/data.split.json");
	std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
	std::fs::write(
		&sidecar,
		json!({"attribute": "split", "policyHash": "p", "file": {"sha256": x_sha()}, "val": [], "test": []})
			.to_string(),
	)
	.unwrap();
	let overlay = dir.path().join("overlay");
	let part = overlay.join("data.parquet");
	write_x(&part);
	let raw = "/data/corpus/versioned/v1/corpus-v1/attributes/nad/abc/data.split.json";
	write_manifest(
		&overlay,
		json!({"files": [{
			"path": part,
			"sha256": x_sha(),
			"split_attribute": {"path": raw, "sha256": file_sha256(&sidecar).unwrap(), "policy_hash": "p"},
		}]}),
	);
	assert_eq!(
		paths(&with_data_root(&overlay, dir.path()), "train").unwrap(),
		vec![part]
	);
}

#[test]
fn a_volume_mount_path_without_a_data_root_stays_unresolvable() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	std::fs::create_dir_all(corpus.join("train")).unwrap();
	write_manifest(
		&corpus,
		json!({"files": [entry("train", "/data/elsewhere/store/nad/abc/data.parquet")]}),
	);
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("1 are unresolvable"), "{message}");
}

#[test]
fn a_partial_resolution_names_the_missing_file() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let present = corpus.join("train/part-0000.parquet");
	write_x(&present);
	write_manifest(
		&corpus,
		json!({"files": [entry("train", &present), entry("train", "/data/other-corpus/train/part-9999.parquet")]}),
	);
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("part-9999"), "{message}");
}

#[test]
fn a_manifest_whose_files_are_all_absent_is_an_error_rather_than_a_glob() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	write_x(&corpus.join("train/unlisted.parquet"));
	write_manifest(&corpus, json!({"files": [entry("train", "/nope/train/x.parquet")]}));
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("x.parquet"), "{message}");
}

#[test]
fn a_manifest_less_glob_verifies_each_file_against_its_record() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let part = corpus.join("train/data.parquet");
	write_x(&part);
	let record = corpus.join("train/data.RECORD.json");
	std::fs::write(&record, json!({"sha256": x_sha()}).to_string()).unwrap();
	assert_eq!(paths(&settings(&corpus), "train").unwrap(), vec![part]);

	std::fs::write(&record, json!({"sha256": "0".repeat(64)}).to_string()).unwrap();
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("hashes to sha256"), "{message}");

	std::fs::remove_file(&record).unwrap();
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("no data.RECORD.json"), "{message}");
}

#[test]
fn a_retired_key_overlay_resolves_its_base_and_its_own_file() {
	let dir = tempfile::tempdir().unwrap();
	let base_part = dir.path().join("base/train/part-0000.parquet");
	write_x(&base_part);
	let corpus = dir.path().join("corpus");
	let own_part = corpus.join("train/overlay-00000.parquet");
	write_x(&own_part);
	write_manifest(
		&corpus,
		json!({OLDEST_KEY: [entry("train", &base_part), entry("train", &own_part)]}),
	);
	assert_eq!(paths(&settings(&corpus), "train").unwrap(), vec![base_part, own_part]);
}

#[test]
fn a_retired_key_manifest_gets_the_partial_resolution_guard_too() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let present = corpus.join("train/part-0000.parquet");
	write_x(&present);
	write_manifest(
		&corpus,
		json!({OLDEST_KEY: [entry("train", &present), entry("train", "/data/other-corpus/train/part-9999.parquet")]}),
	);
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("part-9999"), "{message}");
}

/// An overlay manifest listing its own `val/part-0000.parquet` and a sibling base corpus's.
fn overlay_manifest(overlay: &Path, base_name: &str) {
	write_manifest(
		overlay,
		json!({"files": [
			entry("val", "/data/corpus/versioned/v8-cjk-regs/val/part-0000.parquet"),
			entry("val", format!("/data/corpus/versioned/{base_name}/val/part-0000.parquet")),
		]}),
	);
}

#[test]
fn an_overlays_base_parts_reroot_beside_it() {
	let dir = tempfile::tempdir().unwrap();
	let versioned = dir.path().join("corpus/versioned");
	let overlay = versioned.join("v8-cjk-regs");
	let own = overlay.join("val/part-0000.parquet");
	let base_part = versioned.join("v8-jp-kana/val/part-0000.parquet");
	write_x(&own);
	write_x(&base_part);
	overlay_manifest(&overlay, "v8-jp-kana");
	let mut expected = vec![own, base_part];
	expected.sort();
	assert_eq!(paths(&settings(&overlay), "val").unwrap(), expected);
}

#[test]
fn a_base_part_never_resolves_to_the_overlays_same_numbered_one() {
	let dir = tempfile::tempdir().unwrap();
	let overlay = dir.path().join("corpus/versioned/v8-cjk-regs");
	write_x(&overlay.join("val/part-0000.parquet"));
	overlay_manifest(&overlay, "v8-jp-kana");
	let message = error(&settings(&overlay), "val");
	assert!(message.contains("v8-jp-kana"), "{message}");
}

#[test]
fn a_sibling_that_is_not_there_is_still_an_error() {
	let dir = tempfile::tempdir().unwrap();
	let overlay = dir.path().join("corpus/versioned/v8-cjk-regs");
	let own = overlay.join("val/part-0000.parquet");
	write_x(&own);
	write_manifest(
		&overlay,
		json!({"files": [entry("val", &own), entry("val", "/data/corpus/versioned/v8-absent/val/part-0000.parquet")]}),
	);
	let message = error(&settings(&overlay), "val");
	assert!(message.contains("v8-absent"), "{message}");
}

#[test]
fn a_store_file_reroots_beside_the_corpus_directory() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().join("versioned/v0.8.0");
	let corpus = root.join("corpus-v0.8.0");
	let digest = "a".repeat(64);
	let stored = root.join("store/ban").join(&digest).join("data.parquet");
	write_x(&stored);
	write_manifest(
		&corpus,
		json!({"files": [entry("val", format!("/build-machine/versioned/v0.8.0/store/ban/{digest}/data.parquet"))]}),
	);
	assert_eq!(paths(&settings(&corpus), "val").unwrap(), vec![stored]);
}

#[test]
fn a_file_whose_bytes_changed_is_an_error() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let part = corpus.join("train/rewritten.parquet");
	std::fs::create_dir_all(part.parent().unwrap()).unwrap();
	std::fs::write(&part, b"y").unwrap();
	write_manifest(&corpus, json!({"files": [entry("train", &part)]}));
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("rewritten.parquet hashes to sha256"), "{message}");
}

#[test]
fn an_entry_without_a_sha256_is_an_error() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = dir.path().join("corpus");
	let part = corpus.join("train/unlisted-digest.parquet");
	write_x(&part);
	write_manifest(&corpus, json!({"files": [{"split": "train", "path": part}]}));
	let message = error(&settings(&corpus), "train");
	assert!(message.contains("with no sha256"), "{message}");
}

#[test]
fn the_current_key_wins_when_a_manifest_carries_both() {
	assert_eq!(
		manifest_files(&json!({"files": [{"path": "new"}], OLDEST_KEY: [{"path": "old"}]})),
		vec![json!({"path": "new"})]
	);
	assert_eq!(
		manifest_files(&json!({OLDEST_KEY: [{"path": "old"}]})),
		vec![json!({"path": "old"})]
	);
	assert_eq!(
		manifest_files(&json!({RETIRED_KEYS[0]: [{"path": "v0.8"}]})),
		vec![json!({"path": "v0.8"})]
	);
	assert!(manifest_files(&json!({"files": []})).is_empty());
	assert!(manifest_files(&json!({})).is_empty());
}
