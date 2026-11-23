// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The shared fixtures under `packages/license/test/fixtures/product/`, which the TypeScript verifier runs in
//! `packages/core/lib/license/fixtures.test.ts`. A case that fails here and passes there is a parity defect.

use product_license::entitlement::check_training;
use product_license::keys::{signing_key_from_pem, TrustMap};
use product_license::provenance::{
	encode_manifest, read_payload, verify_manifest, write_manifest, ProvenanceManifest, ProvenanceSigner,
};
use product_license::time::parse_utc_instant_ms;
use product_license::token::{verify_license_key, verify_training_grant};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/product")
}

fn read(name: &str) -> Value {
	let path = fixtures().join(name);
	serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn trust(map: &Value) -> TrustMap {
	TrustMap::from_pems(
		map.as_object()
			.unwrap()
			.iter()
			.map(|(k, v)| (k.as_str(), v.as_str().unwrap())),
	)
	.unwrap()
}

#[test]
fn every_token_case_returns_the_specified_statuses() {
	let tokens = read("tokens.json");
	let trust = trust(&tokens["trusted_license_keys"]);
	let cases = tokens["cases"].as_array().unwrap();
	assert!(cases.len() >= 20, "the fixture holds {} cases", cases.len());
	let mut failures = Vec::new();
	for case in cases {
		let name = case["name"].as_str().unwrap();
		let token = case["token"].as_str();
		let now = parse_utc_instant_ms(case["now"].as_str().unwrap()).unwrap();
		let observed = (
			verify_license_key(token.unwrap_or(""), &trust, now).status(),
			verify_training_grant(token.unwrap_or(""), &trust, now).status(),
			check_training(token, &trust, now).code(),
		);
		let expected = (
			case["expect"]["license_key"].as_str().unwrap(),
			case["expect"]["training_grant"].as_str().unwrap(),
			case["expect"]["training"].as_str().unwrap(),
		);
		if observed != expected {
			failures.push(format!("{name}: expected {expected:?}, observed {observed:?}"));
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_provenance_case_returns_the_specified_result() {
	let cases = read("provenance.json");
	let trust = trust(&cases["trusted_provenance_keys"]);
	for case in cases["cases"].as_array().unwrap() {
		let path = fixtures().join("provenance").join(case["manifest"].as_str().unwrap());
		let observed = verify_manifest(&path, &trust, case["require_signature"].as_bool().unwrap());
		assert_eq!(
			observed.code(),
			case["expect"].as_str().unwrap(),
			"{}: {observed:?}",
			case["name"]
		);
	}
}

fn copy_fixture() -> tempfile::TempDir {
	let dir = tempfile::tempdir().unwrap();
	for entry in std::fs::read_dir(fixtures().join("provenance")).unwrap() {
		let entry = entry.unwrap();
		std::fs::copy(entry.path(), dir.path().join(entry.file_name())).unwrap();
	}
	dir
}

#[test]
fn a_changed_model_or_sidecar_fails_verification() {
	let trust = trust(&read("provenance.json")["trusted_provenance_keys"]);
	for changed in ["model.onnx", "TRAINING.json", "CORPUS.json"] {
		let dir = copy_fixture();
		let mut bytes = std::fs::read(dir.path().join(changed)).unwrap();
		bytes[0] ^= 1;
		std::fs::write(dir.path().join(changed), bytes).unwrap();
		let observed = verify_manifest(&dir.path().join("model.provenance.json"), &trust, true);
		assert_eq!(observed.code(), "artifact_mismatch", "{changed}");
	}
	let dir = copy_fixture();
	std::fs::remove_file(dir.path().join("CORPUS.json")).unwrap();
	assert_eq!(
		verify_manifest(&dir.path().join("model.provenance.json"), &trust, true).code(),
		"artifact_mismatch"
	);
}

#[test]
fn a_manifest_moved_beside_another_model_fails_verification() {
	let trust = trust(&read("provenance.json")["trusted_provenance_keys"]);
	let dir = copy_fixture();
	std::fs::write(dir.path().join("model.onnx"), b"another model's graph\n").unwrap();
	assert_eq!(
		verify_manifest(&dir.path().join("model.provenance.json"), &trust, true).code(),
		"artifact_mismatch"
	);
}

#[test]
fn an_altered_payload_fails_the_signature() {
	let trust = trust(&read("provenance.json")["trusted_provenance_keys"]);
	let dir = copy_fixture();
	let path = dir.path().join("model.provenance.json");
	let manifest: ProvenanceManifest = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
	let mut payload = read_payload(&manifest).unwrap();
	payload.training.as_mut().unwrap().grant.as_mut().unwrap().expires = "2099-12-31".to_owned();
	let keys = read("keys.json");
	let other = ProvenanceSigner::new(
		keys["provenance"]["kid"].as_str().unwrap(),
		signing_key_from_pem(keys["provenance"]["privateKeyPEM"].as_str().unwrap()).unwrap(),
	)
	.unwrap();
	let resigned = encode_manifest(&payload, Some(&other)).unwrap();
	let forged = ProvenanceManifest {
		signature: manifest.signature.clone(),
		..resigned
	};
	write_manifest(&path, &forged).unwrap();
	assert_eq!(verify_manifest(&path, &trust, true).code(), "bad_signature");
}

#[test]
fn a_manifest_signed_here_verifies_and_a_mislabeled_key_never_signs() {
	let keys = read("keys.json");
	let trust = trust(&read("provenance.json")["trusted_provenance_keys"]);
	let key = signing_key_from_pem(keys["provenance"]["privateKeyPEM"].as_str().unwrap()).unwrap();
	assert!(ProvenanceSigner::new(keys["license"]["kid"].as_str().unwrap(), key.clone()).is_err());
	let signer = ProvenanceSigner::new(keys["provenance"]["kid"].as_str().unwrap(), key).unwrap();
	let dir = copy_fixture();
	let path = dir.path().join("model.provenance.json");
	let manifest: ProvenanceManifest = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
	let payload = read_payload(&manifest).unwrap();
	write_manifest(&path, &encode_manifest(&payload, Some(&signer)).unwrap()).unwrap();
	assert_eq!(verify_manifest(&path, &trust, true).code(), "verified");
}
