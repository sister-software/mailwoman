// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The provenance manifest each export, quantization and embedding split writes beside its graph.
//!
//! `export-onnx` copies the run's `TRAINING.json` beside the graph with `CORPUS.json`, gives the graph a provenance
//! id in its ONNX metadata, and writes `<graph>.provenance.json`, which binds the sha256 and length of the graph and
//! each sidecar to the training record. `quantize` and `split-embeddings` change the graph's bytes, so each writes a
//! new manifest for its output with a parent reference to the input's manifest, which it verifies first.
//!
//! A managed export holds a provenance key in `MAILWOMAN_PROVENANCE_SIGNING_KEY` and its id in
//! `MAILWOMAN_PROVENANCE_SIGNING_KID`, and signs with the `managed` attestation. Without a key a manifest is
//! `unattested`: it records digests and asserts nothing. A run trained under `LicenseRef-Commercial` exports only with
//! a key, so every commercial model leaves the export with a signed manifest.

use crate::onnx::{ModelProto, StringStringEntryProto};
use crate::{fail, Result};
use product_license::keys::{signing_key_from_pem, trusted_provenance_keys, TrustMap};
use product_license::provenance::{
	bind_artifacts, check_record, encode_manifest, manifest_path_for, random_hex24, sha256_hex, verify_manifest,
	write_manifest, ManifestParent, ProvenancePayload, ProvenanceSigner, ProvenanceVerification, TrainingRecord,
	PROVENANCE_METADATA_KEY, TRAINING_RECORD_FILE,
};
use product_license::time::{format_utc_instant, now_ms};
use product_license::{PROVENANCE_KEY_ENV, PROVENANCE_KID_ENV};
use std::path::Path;

const COMMERCIAL: &str = "LicenseRef-Commercial";

/// The provenance key in the environment, both variables or neither.
pub fn signer_from_env() -> Result<Option<ProvenanceSigner>> {
	let key = std::env::var(PROVENANCE_KEY_ENV).ok().filter(|v| !v.is_empty());
	let kid = std::env::var(PROVENANCE_KID_ENV).ok().filter(|v| !v.is_empty());
	match (key, kid) {
		(None, None) => Ok(None),
		(Some(pem), Some(kid)) => {
			let key = signing_key_from_pem(&pem).map_err(|e| fail!("{PROVENANCE_KEY_ENV}: {e}"))?;
			Ok(Some(ProvenanceSigner::new(&kid, key).map_err(|e| fail!("{e}"))?))
		}
		_ => Err(fail!(
			"set both {PROVENANCE_KEY_ENV} and {PROVENANCE_KID_ENV}, or neither"
		)),
	}
}

/// The provenance keys a parent manifest verifies under: the embedded register, or in a debug build the key id → spki
/// PEM map in `MAILWOMAN_PROVENANCE_TRUST_FILE`, which the tests set. A release build reads only the register.
pub fn trust() -> Result<TrustMap> {
	if cfg!(debug_assertions) {
		if let Some(path) = std::env::var_os("MAILWOMAN_PROVENANCE_TRUST_FILE") {
			let text = std::fs::read_to_string(&path).map_err(|e| fail!("{}: {e}", path.to_string_lossy()))?;
			let map: serde_json::Map<String, serde_json::Value> =
				serde_json::from_str(&text).map_err(|e| fail!("{e}"))?;
			return TrustMap::from_pems(map.iter().filter_map(|(k, v)| Some((k.as_str(), v.as_str()?))))
				.map_err(|e| fail!("{e}"));
		}
	}
	Ok(trusted_provenance_keys())
}

/// A new provenance id, `mwprov_` and 24 hex digits.
pub fn new_provenance_id() -> Result<String> {
	Ok(format!("mwprov_{}", random_hex24().map_err(|e| fail!("{e}"))?))
}

/// Sets the graph's `mailwoman.provenance_id` metadata, replacing an inherited one.
pub fn stamp_provenance_id(model: &mut ModelProto, id: &str) {
	model
		.metadata_props
		.retain(|p| p.key.as_deref() != Some(PROVENANCE_METADATA_KEY));
	model.metadata_props.push(StringStringEntryProto {
		key: Some(PROVENANCE_METADATA_KEY.to_owned()),
		value: Some(id.to_owned()),
	});
}

/// Reads and checks a run's `TRAINING.json`.
pub fn read_record(path: &Path) -> Result<TrainingRecord> {
	let text = std::fs::read_to_string(path).map_err(|e| fail!("{}: {e}", path.display()))?;
	let record: TrainingRecord = serde_json::from_str(&text).map_err(|e| fail!("{}: {e}", path.display()))?;
	check_record(&record).map_err(|e| fail!("{}: {e}", path.display()))?;
	Ok(record)
}

/// The training record of the run that wrote `checkpoint`, from `TRAINING.json` beside it, or `None` for a run that
/// predates the record.
pub fn checkpoint_record(checkpoint: &Path) -> Result<Option<(std::path::PathBuf, TrainingRecord)>> {
	let Some(path) = checkpoint
		.parent()
		.map(|p| p.join(TRAINING_RECORD_FILE))
		.filter(|p| p.is_file())
	else {
		return Ok(None);
	};
	let record = read_record(&path)?;
	Ok(Some((path, record)))
}

/// Refuses an unsigned manifest for a commercial run's model.
fn require_signer_for(record: Option<&TrainingRecord>, signer: Option<&ProvenanceSigner>) -> Result<()> {
	if record.is_some_and(|r| r.license_branch == COMMERCIAL) && signer.is_none() {
		return Err(fail!(
			"the run trained under {COMMERCIAL}, and its model exports only with a signed provenance manifest; set \
			 {PROVENANCE_KEY_ENV} and {PROVENANCE_KID_ENV}"
		));
	}
	Ok(())
}

/// Checks before a byte-changing step that a commercial run's model can leave it with a signed manifest.
pub fn preflight(record: Option<&TrainingRecord>, signer: Option<&ProvenanceSigner>) -> Result<()> {
	require_signer_for(record, signer)
}

/// Writes `<graph>.provenance.json` beside `graph`, binding the graph and `sidecars` (file names in the graph's
/// directory), and returns the manifest's path.
pub fn write_beside(
	graph: &Path,
	sidecars: &[&str],
	provenance_id: &str,
	training: Option<TrainingRecord>,
	parent: Option<ManifestParent>,
	signer: Option<&ProvenanceSigner>,
) -> Result<std::path::PathBuf> {
	require_signer_for(training.as_ref(), signer)?;
	let dir = graph
		.parent()
		.filter(|d| !d.as_os_str().is_empty())
		.unwrap_or(Path::new("."));
	let name = graph
		.file_name()
		.and_then(|n| n.to_str())
		.ok_or_else(|| fail!("{} has no file name", graph.display()))?;
	let mut paths = vec![name];
	paths.extend(sidecars.iter().copied().filter(|s| dir.join(s).is_file()));
	let payload = ProvenancePayload {
		v: 1,
		provenance_id: provenance_id.to_owned(),
		created: format_utc_instant(now_ms()),
		attestation: if signer.is_some() { "managed" } else { "unattested" }.to_owned(),
		artifacts: bind_artifacts(dir, &paths).map_err(|e| fail!("{e}"))?,
		training,
		parent,
	};
	let manifest = encode_manifest(&payload, signer).map_err(|e| fail!("{e}"))?;
	let path = manifest_path_for(graph);
	write_manifest(&path, &manifest).map_err(|e| fail!("{e}"))?;
	Ok(path)
}

/// The verified manifest beside an input graph and the parent reference a derived graph's manifest carries, or `None`
/// when the input has no manifest.
///
/// A manifest that fails verification refuses the step: a derived graph never inherits provenance it can't show.
pub fn parent_of(input: &Path, transformation: &str) -> Result<Option<(ManifestParent, ProvenancePayload)>> {
	let manifest = manifest_path_for(input);
	if !manifest.is_file() {
		return Ok(None);
	}
	match verify_manifest(&manifest, &trust()?, false) {
		ProvenanceVerification::Verified { payload, .. } => {
			let bytes = std::fs::read(&manifest).map_err(|e| fail!("{}: {e}", manifest.display()))?;
			let parent = ManifestParent {
				provenance_id: payload.provenance_id.clone(),
				manifest_sha256: sha256_hex(&bytes),
				transformation: transformation.to_owned(),
			};
			Ok(Some((parent, *payload)))
		}
		ProvenanceVerification::Refused { refusal, reason } => Err(fail!(
			"{} does not verify ({refusal}: {reason}); a derived graph inherits only provenance that verifies",
			manifest.display()
		)),
	}
}
