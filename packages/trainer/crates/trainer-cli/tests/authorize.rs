// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The training entry point's license check, run on the built `trainer` binary with the shared grant fixtures.
//!
//! `cargo test -p trainer-cli --features commercial` runs the commercial trainer's cases, and `cargo test -p
//! trainer-cli` the open-source trainer's. A debug build reads the fixtures' trust map from
//! `MAILWOMAN_TRAINING_TRUST_FILE` and its clock from `MAILWOMAN_TRAINING_NOW`; a release build reads neither.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixtures() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../license/test/fixtures/product")
}

fn tokens() -> Value {
	serde_json::from_str(&std::fs::read_to_string(fixtures().join("tokens.json")).unwrap()).unwrap()
}

/// The token of the fixture case whose name starts with `prefix`.
#[cfg_attr(not(feature = "commercial"), allow(dead_code))]
fn token(prefix: &str) -> String {
	tokens()["cases"]
		.as_array()
		.unwrap()
		.iter()
		.find(|c| c["name"].as_str().unwrap().starts_with(prefix))
		.and_then(|c| c["token"].as_str())
		.unwrap_or_else(|| panic!("no fixture case starts with {prefix:?}"))
		.to_owned()
}

struct Sandbox {
	root: tempfile::TempDir,
}

impl Sandbox {
	fn new() -> Self {
		let root = tempfile::tempdir().unwrap();
		std::fs::write(
			root.path().join("trust.json"),
			tokens()["trusted_license_keys"].to_string(),
		)
		.unwrap();
		let resolved = serde_json::json!({
			"schema_version": 1,
			"config_path": "fixture.yaml",
			"config_sha256": "0",
			"config": {
				"data": { "corpus_dir": root.path().join("corpus") },
				"model": {},
				// `trackio_enabled` makes `train` stop at its first check, after the record is written and before the
				// corpus is read, so these tests need no corpus and no GPU.
				"train": { "output_dir": root.path().join("out"), "init_from": "", "seed": 1, "trackio_enabled": true },
			},
			"derived": { "csv_log_path": root.path().join("train_log.csv") },
		});
		std::fs::write(root.path().join("resolved.json"), resolved.to_string()).unwrap();
		Self { root }
	}

	fn out(&self) -> PathBuf {
		self.root.path().join("out")
	}

	fn run(&self, args: &[&str], grant: Option<&str>, now: &str) -> Output {
		let mut command = Command::new(env!("CARGO_BIN_EXE_trainer"));
		command
			.args(args)
			.env_remove("MAILWOMAN_TRAINING_GRANT")
			.env("MAILWOMAN_TRAINING_TRUST_FILE", self.root.path().join("trust.json"))
			.env("MAILWOMAN_TRAINING_NOW", now)
			.env_remove("MAILWOMAN_TRAINER_IMAGE");
		if let Some(grant) = grant {
			command.env("MAILWOMAN_TRAINING_GRANT", grant);
		}
		command.output().unwrap()
	}

	fn train(&self, grant: Option<&str>, now: &str) -> Output {
		let resolved = self.root.path().join("resolved.json");
		self.run(&["train", resolved.to_str().unwrap(), "--resume", "auto"], grant, now)
	}

	fn record(&self) -> Value {
		serde_json::from_str(&std::fs::read_to_string(self.out().join("TRAINING.json")).unwrap()).unwrap()
	}
}

const DURING: &str = "2026-12-01T00:00:00.000Z";
#[cfg_attr(not(feature = "commercial"), allow(dead_code))]
const AFTER: &str = "2027-02-01T00:00:00.000Z";

fn text(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(feature = "commercial")]
mod commercial {
	use super::*;

	#[test]
	fn authorize_admits_an_active_grant_and_prints_no_token_or_holder() {
		let sandbox = Sandbox::new();
		let grant = token("an active training grant");
		let output = sandbox.run(&["authorize"], Some(&grant), DURING);
		let stdout = text(&output.stdout);
		assert_eq!(output.status.code(), Some(0), "{stdout}{}", text(&output.stderr));
		let report: Value = serde_json::from_str(stdout.trim()).unwrap();
		assert_eq!(report["branch"], "LicenseRef-Commercial");
		assert_eq!(report["grant"]["grant"], "mtg_0123456789abcdef01234567");
		assert!(!stdout.contains(&grant), "the token reached stdout");
		assert!(
			!stdout.contains("Fixture Training Customer"),
			"the holder reached stdout"
		);
	}

	#[test]
	fn authorize_refuses_every_credential_that_is_no_active_training_grant() {
		let sandbox = Sandbox::new();
		let cases = [
			(None, DURING, "missing"),
			(Some(token("an active training grant")), AFTER, "expired"),
			(
				Some(token("a purchased platform key with scope all")),
				DURING,
				"not_a_training_grant",
			),
			(
				Some(token("an open-source declaration with scope all")),
				DURING,
				"not_a_training_grant",
			),
			(Some(token("a grant that permits only deploy")), DURING, "not_permitted"),
			(Some(token("a training grant from a signer")), DURING, "unknown_key"),
			(Some(token("an altered payload")), DURING, "invalid"),
			(Some(token("a token with two parts")), DURING, "invalid"),
		];
		for (grant, now, code) in cases {
			let output = sandbox.run(&["authorize"], grant.as_deref(), now);
			assert_eq!(output.status.code(), Some(3), "{code}: {}", text(&output.stdout));
			let report: Value = serde_json::from_str(text(&output.stdout).trim()).unwrap();
			assert_eq!(report["refusal"], code);
		}
	}

	#[test]
	fn train_refuses_before_it_reads_the_config_or_touches_a_checkpoint() {
		let sandbox = Sandbox::new();
		let checkpoint = sandbox.out().join("step-000010");
		std::fs::create_dir_all(&checkpoint).unwrap();
		std::fs::write(checkpoint.join("training_state.json"), "{\"step\": 10}\n").unwrap();
		for (grant, now) in [(None, DURING), (Some(token("an active training grant")), AFTER)] {
			let output = sandbox.train(grant.as_deref(), now);
			assert_eq!(output.status.code(), Some(3), "{}", text(&output.stderr));
			assert!(text(&output.stderr).contains("training refused"));
		}
		let mut entries: Vec<_> = std::fs::read_dir(sandbox.out())
			.unwrap()
			.map(|e| e.unwrap().file_name())
			.collect();
		entries.sort();
		assert_eq!(
			entries,
			["step-000010"],
			"the refused run wrote into the output directory"
		);
		assert_eq!(
			std::fs::read_to_string(checkpoint.join("training_state.json")).unwrap(),
			"{\"step\": 10}\n"
		);
	}

	#[test]
	fn an_admitted_run_records_the_grant_and_a_resume_appends_a_verification() {
		let sandbox = Sandbox::new();
		let grant = token("an active training grant");
		// Each process stops at `trackio_enabled` (exit 2) after writing the record.
		assert_eq!(sandbox.train(Some(&grant), DURING).status.code(), Some(2));
		let first = sandbox.record();
		assert_eq!(first["license_branch"], "LicenseRef-Commercial");
		assert_eq!(first["trainer"]["build"], "commercial");
		assert_eq!(first["grant"]["grant"], "mtg_0123456789abcdef01234567");
		assert_eq!(first["verifications"].as_array().unwrap().len(), 1);
		let written = std::fs::read_to_string(sandbox.out().join("TRAINING.json")).unwrap();
		assert!(
			!written.contains("Fixture Training Customer"),
			"the holder reached TRAINING.json"
		);
		assert!(!written.contains(&grant), "the token reached TRAINING.json");

		assert_eq!(
			sandbox.train(Some(&grant), "2027-01-31T23:59:59.999Z").status.code(),
			Some(2)
		);
		let resumed = sandbox.record();
		assert_eq!(resumed["run_id"], first["run_id"]);
		assert_eq!(resumed["verifications"][1]["event"], "resume");
		assert_eq!(resumed["verifications"][1]["at"], "2027-01-31T23:59:59Z");

		// After expiry, a retry is refused and the record keeps both events.
		assert_eq!(sandbox.train(Some(&grant), AFTER).status.code(), Some(3));
		assert_eq!(sandbox.record(), resumed);
	}
}

#[cfg(not(feature = "commercial"))]
mod open_source {
	use super::*;

	#[test]
	fn the_open_source_trainer_checks_no_grant_and_records_its_branch() {
		let sandbox = Sandbox::new();
		let output = sandbox.run(&["authorize"], None, DURING);
		assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
		let report: Value = serde_json::from_str(text(&output.stdout).trim()).unwrap();
		assert_eq!(report["branch"], "AGPL-3.0-only");
		assert_eq!(report["grant"], Value::Null);

		assert_eq!(sandbox.train(None, DURING).status.code(), Some(2));
		let record = sandbox.record();
		assert_eq!(record["license_branch"], "AGPL-3.0-only");
		assert_eq!(record["trainer"]["build"], "open-source");
		assert_eq!(record["grant"], Value::Null);
		assert_eq!(record["verifications"][0]["grant"], Value::Null);
	}

	#[test]
	fn a_branch_from_another_runs_checkpoint_is_a_new_run_with_a_parent() {
		let parent = Sandbox::new();
		assert_eq!(parent.train(None, DURING).status.code(), Some(2));
		let parent_record = parent.record();
		let checkpoint = parent.out().join("step-000010");
		std::fs::create_dir_all(&checkpoint).unwrap();
		std::fs::write(checkpoint.join("model.safetensors"), b"parent weights").unwrap();

		let child = Sandbox::new();
		let resolved = child.root.path().join("resolved.json");
		let output = child.run(
			&[
				"train",
				resolved.to_str().unwrap(),
				"--resume",
				checkpoint.to_str().unwrap(),
			],
			None,
			DURING,
		);
		assert_eq!(output.status.code(), Some(2), "{}", text(&output.stderr));
		let record = child.record();
		assert_ne!(record["run_id"], parent_record["run_id"]);
		assert_eq!(record["parent"]["run_id"], parent_record["run_id"]);
		// sha256 of `parent weights`.
		assert_eq!(
			record["parent"]["model_sha256"],
			"c95ec0126ceefdf7169dcc8eb56abba0e33733baa3ed65f71dbdb84fd0a078cb"
		);
	}
}
