// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The provenance manifests `export-onnx`, `quantize` and `split-embeddings` write, run on the built binary with the
//! tiny-bundle checkpoint, the shared fixture training record and the fixture provenance key.

use prost::Message;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use trainer_export::onnx::ModelProto;

fn fixtures() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn product_fixtures() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../license/test/fixtures/product")
}

fn json(path: &Path) -> Value {
	serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

struct Run {
	root: tempfile::TempDir,
	signed: bool,
}

impl Run {
	/// A run directory holding the tiny-bundle checkpoint at `run/step-000001`, with `TRAINING.json` of `branch`
	/// beside it.
	fn new(branch: &str, signed: bool) -> Self {
		let root = tempfile::tempdir().unwrap();
		let checkpoint = root.path().join("run/step-000001");
		std::fs::create_dir_all(&checkpoint).unwrap();
		for file in ["config.json", "pytorch_model.bin"] {
			std::fs::copy(fixtures().join("tiny-bundle").join(file), checkpoint.join(file)).unwrap();
		}
		let mut record = json(&product_fixtures().join("provenance/TRAINING.json"));
		if branch == "AGPL-3.0-only" {
			record["license_branch"] = branch.into();
			record["grant"] = Value::Null;
			record["trainer"]["build"] = "open-source".into();
			record["verifications"][0]["grant"] = Value::Null;
		}
		std::fs::write(root.path().join("run/TRAINING.json"), record.to_string()).unwrap();
		let keys = json(&product_fixtures().join("keys.json"));
		let trust =
			serde_json::json!({ keys["provenance"]["kid"].as_str().unwrap(): keys["provenance"]["publicKeyPEM"] });
		std::fs::write(root.path().join("trust.json"), trust.to_string()).unwrap();
		std::fs::create_dir_all(root.path().join("export")).unwrap();
		Self { root, signed }
	}

	fn path(&self, relative: &str) -> PathBuf {
		self.root.path().join(relative)
	}

	fn run(&self, args: &[&str]) -> Output {
		let keys = json(&product_fixtures().join("keys.json"));
		let mut command = Command::new(env!("CARGO_BIN_EXE_trainer-export"));
		command
			.args(args)
			.env("MAILWOMAN_PROVENANCE_TRUST_FILE", self.path("trust.json"))
			.env_remove("MAILWOMAN_PROVENANCE_SIGNING_KEY")
			.env_remove("MAILWOMAN_PROVENANCE_SIGNING_KID");
		if self.signed {
			command
				.env(
					"MAILWOMAN_PROVENANCE_SIGNING_KEY",
					keys["provenance"]["privateKeyPEM"].as_str().unwrap(),
				)
				.env(
					"MAILWOMAN_PROVENANCE_SIGNING_KID",
					keys["provenance"]["kid"].as_str().unwrap(),
				);
		}
		command.output().unwrap()
	}

	fn export(&self) -> Output {
		let checkpoint = self.path("run/step-000001");
		let output = self.path("export/model.onnx");
		self.run(&[
			"export-onnx",
			"--checkpoint",
			checkpoint.to_str().unwrap(),
			"--output",
			output.to_str().unwrap(),
		])
	}

	fn verify(&self, manifest: &str) -> (Option<i32>, Value) {
		let path = self.path(manifest);
		let output = self.run(&[
			"verify-provenance",
			"--manifest",
			path.to_str().unwrap(),
			"--require-signature",
			"true",
		]);
		(
			output.status.code(),
			serde_json::from_slice(&output.stdout).unwrap_or(Value::Null),
		)
	}
}

fn text(output: &Output) -> String {
	format!(
		"{}{}",
		String::from_utf8_lossy(&output.stdout),
		String::from_utf8_lossy(&output.stderr)
	)
}

fn provenance_id_in(graph: &Path) -> Option<String> {
	let model = ModelProto::decode(std::fs::read(graph).unwrap().as_slice()).unwrap();
	model
		.metadata_props
		.iter()
		.find(|p| p.key.as_deref() == Some("mailwoman.provenance_id"))
		.and_then(|p| p.value.clone())
}

#[test]
fn a_commercial_run_exports_only_with_a_provenance_key() {
	let run = Run::new("LicenseRef-Commercial", false);
	let output = run.export();
	assert_eq!(output.status.code(), Some(2), "{}", text(&output));
	assert!(text(&output).contains("exports only with a signed provenance manifest"));
	assert!(
		!run.path("export/model.onnx").exists(),
		"the refused export wrote the graph"
	);
}

#[test]
fn a_signed_export_binds_its_bytes_and_records_the_grant() {
	let run = Run::new("LicenseRef-Commercial", true);
	let output = run.export();
	assert_eq!(output.status.code(), Some(0), "{}", text(&output));
	let (code, report) = run.verify("export/model.provenance.json");
	assert_eq!(code, Some(0), "{report}");
	assert_eq!(report["attestation"], "managed");
	assert_eq!(report["license_branch"], "LicenseRef-Commercial");
	assert_eq!(report["grant"], "mtg_0123456789abcdef01234567");
	assert_eq!(
		provenance_id_in(&run.path("export/model.onnx")),
		report["provenance_id"].as_str().map(str::to_owned)
	);

	// The graph's bytes, a bound sidecar, and the training record each bind.
	for changed in ["export/model.onnx", "export/TRAINING.json", "export/CORPUS.json"] {
		if !run.path(changed).exists() {
			continue;
		}
		let original = std::fs::read(run.path(changed)).unwrap();
		let mut altered = original.clone();
		let last = altered.len() - 1;
		altered[last] ^= 1;
		std::fs::write(run.path(changed), &altered).unwrap();
		let (code, report) = run.verify("export/model.provenance.json");
		assert_eq!(
			(code, report["refusal"].as_str()),
			(Some(1), Some("artifact_mismatch")),
			"{changed}"
		);
		std::fs::write(run.path(changed), original).unwrap();
	}
}

#[test]
fn quantize_and_split_write_derived_manifests_with_parent_references() {
	let run = Run::new("LicenseRef-Commercial", true);
	assert_eq!(run.export().status.code(), Some(0));
	let parent_id = run.verify("export/model.provenance.json").1["provenance_id"].clone();

	let input = run.path("export/model.onnx");
	let quantized = run.path("export/model-int8.onnx");
	let output = run.run(&[
		"quantize",
		"--input",
		input.to_str().unwrap(),
		"--output",
		quantized.to_str().unwrap(),
	]);
	assert_eq!(output.status.code(), Some(0), "{}", text(&output));
	let (code, report) = run.verify("export/model-int8.provenance.json");
	assert_eq!(code, Some(0), "{report}");
	assert_ne!(report["provenance_id"], parent_id);
	assert_eq!(
		provenance_id_in(&quantized),
		report["provenance_id"].as_str().map(str::to_owned)
	);

	let manifest = json(&run.path("export/model-int8.provenance.json"));
	let payload: Value = serde_json::from_slice(&base64_url_decode(manifest["payload"].as_str().unwrap())).unwrap();
	assert_eq!(payload["parent"]["provenance_id"], parent_id);
	assert_eq!(payload["parent"]["transformation"], "quantize");
	assert_eq!(payload["training"]["run_id"], "mwrun_00112233445566778899aabb");

	let split = run.path("split");
	let output = run.run(&[
		"split-embeddings",
		"--input",
		quantized.to_str().unwrap(),
		"--out-dir",
		split.to_str().unwrap(),
	]);
	assert_eq!(output.status.code(), Some(0), "{}", text(&output));
	let (code, report) = run.verify("split/encoder.provenance.json");
	assert_eq!(code, Some(0), "{report}");
}

#[test]
fn a_derived_graph_refuses_an_input_whose_manifest_does_not_verify() {
	let run = Run::new("LicenseRef-Commercial", true);
	assert_eq!(run.export().status.code(), Some(0));
	let input = run.path("export/model.onnx");
	let mut bytes = std::fs::read(&input).unwrap();
	let last = bytes.len() - 1;
	bytes[last] ^= 1;
	std::fs::write(&input, bytes).unwrap();
	let quantized = run.path("export/model-int8.onnx");
	let output = run.run(&[
		"quantize",
		"--input",
		input.to_str().unwrap(),
		"--output",
		quantized.to_str().unwrap(),
	]);
	assert_eq!(output.status.code(), Some(2), "{}", text(&output));
	assert!(text(&output).contains("inherits only provenance that verifies"));
}

#[test]
fn an_open_source_run_exports_an_unattested_manifest_without_a_key() {
	let run = Run::new("AGPL-3.0-only", false);
	let output = run.export();
	assert_eq!(output.status.code(), Some(0), "{}", text(&output));
	let (code, report) = run.verify("export/model.provenance.json");
	assert_eq!((code, report["refusal"].as_str()), (Some(1), Some("unsigned")));
	let path = run.path("export/model.provenance.json");
	let output = run.run(&["verify-provenance", "--manifest", path.to_str().unwrap()]);
	assert_eq!(output.status.code(), Some(0), "{}", text(&output));
}

fn base64_url_decode(text: &str) -> Vec<u8> {
	let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let mut bits = 0u32;
	let mut count = 0;
	let mut out = Vec::new();
	for byte in text.bytes() {
		bits = (bits << 6) | alphabet.iter().position(|&a| a == byte).unwrap() as u32;
		count += 6;
		if count >= 8 {
			count -= 8;
			out.push((bits >> count) as u8);
		}
	}
	out
}
