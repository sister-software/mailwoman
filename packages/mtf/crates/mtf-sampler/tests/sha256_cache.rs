// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The sha256 sidecar: a hit needs a matching size and mtime, records from two files merge, an unreadable sidecar is
//! a miss, and the loader records digests and trusts them before hashing.
use mtf_sampler::corpus_files::{file_sha256, verify_sha256s};
use mtf_sampler::sha256_cache::{cached_sha256, record_sha256s};
use std::fs::{File, FileTimes};
use std::time::Duration;

#[test]
fn an_unchanged_file_hits() {
	let dir = tempfile::tempdir().unwrap();
	let (cache, data) = (dir.path().join("cache.json"), dir.path().join("a.bin"));
	std::fs::write(&data, b"abc").unwrap();
	record_sha256s(&cache, &[(&data, "digest")]).unwrap();
	assert_eq!(cached_sha256(&cache, &data).unwrap().as_deref(), Some("digest"));
}

#[test]
fn a_rewritten_file_misses() {
	let dir = tempfile::tempdir().unwrap();
	let (cache, data) = (dir.path().join("cache.json"), dir.path().join("a.bin"));
	std::fs::write(&data, b"abc").unwrap();
	record_sha256s(&cache, &[(&data, "digest")]).unwrap();
	let modified = std::fs::metadata(&data).unwrap().modified().unwrap();
	let file = File::options().write(true).open(&data).unwrap();
	file.set_times(FileTimes::new().set_modified(modified + Duration::from_millis(1)))
		.unwrap();
	assert_eq!(cached_sha256(&cache, &data).unwrap(), None);
}

#[test]
fn records_from_two_files_merge() {
	let dir = tempfile::tempdir().unwrap();
	let cache = dir.path().join("cache.json");
	let (first, second) = (dir.path().join("a.bin"), dir.path().join("b.bin"));
	std::fs::write(&first, b"a").unwrap();
	std::fs::write(&second, b"b").unwrap();
	record_sha256s(&cache, &[(&first, "one")]).unwrap();
	record_sha256s(&cache, &[(&second, "two")]).unwrap();
	assert_eq!(
		(
			cached_sha256(&cache, &first).unwrap(),
			cached_sha256(&cache, &second).unwrap()
		),
		(Some("one".to_owned()), Some("two".to_owned()))
	);
}

#[test]
fn an_unreadable_sidecar_is_a_miss() {
	let dir = tempfile::tempdir().unwrap();
	let (cache, data) = (dir.path().join("cache.json"), dir.path().join("a.bin"));
	std::fs::write(&data, b"abc").unwrap();
	std::fs::write(&cache, "{not json").unwrap();
	assert_eq!(cached_sha256(&cache, &data).unwrap(), None);
}

#[test]
fn the_loader_records_digests_then_trusts_the_sidecar() {
	let dir = tempfile::tempdir().unwrap();
	let (cache, data) = (dir.path().join("cache.json"), dir.path().join("a.bin"));
	std::fs::write(&data, b"abc").unwrap();
	let expected = file_sha256(&data).unwrap();
	verify_sha256s(&[(data.clone(), Some(expected.clone()))], Some(&cache)).unwrap();
	assert_eq!(cached_sha256(&cache, &data).unwrap(), Some(expected));

	// A file this process has not verified, whose sidecar entry holds a digest its bytes do not hash to, passes
	// against that digest, which only a lookup that skips the hash can produce.
	let other = dir.path().join("b.bin");
	std::fs::write(&other, b"abc").unwrap();
	record_sha256s(&cache, &[(&other, "recorded")]).unwrap();
	verify_sha256s(&[(other, Some("recorded".to_owned()))], Some(&cache))
		.expect("a fresh verification rehashed a file the sidecar already measured");
}

#[test]
fn a_cached_digest_that_disagrees_with_the_manifest_is_still_an_error() {
	let dir = tempfile::tempdir().unwrap();
	let (cache, data) = (dir.path().join("cache.json"), dir.path().join("a.bin"));
	std::fs::write(&data, b"abc").unwrap();
	record_sha256s(&cache, &[(&data, "measured")]).unwrap();
	let error = verify_sha256s(&[(data, Some("claimed".to_owned()))], Some(&cache)).expect_err("an error");
	assert!(error.to_string().contains("MANIFEST lists"), "{error}");
}
