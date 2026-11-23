// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The training record a run writes (`TRAINING.json`) and the provenance manifest an export writes beside a graph
//! (`<graph>.provenance.json`), with the schemas of `@mailwoman/license/product/provenance`.
//!
//! A manifest binds the sha256 and length of the graph and each sidecar to the training record, and a provenance
//! key signs the ASCII bytes `mwp1.<payload>`, where `<payload>` is the unpadded base64url of the payload JSON as the
//! manifest carries it. A provenance key never signs a credential, and a license key never verifies a manifest.

use crate::keys::{key_digest, TrustMap};
use crate::time::is_utc_instant;
use crate::token::{is_base64url, BASE64URL};
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const PROVENANCE_PREFIX: &str = "mwp1";
pub const TRAINING_RECORD_FILE: &str = "TRAINING.json";
pub const PROVENANCE_MANIFEST_SUFFIX: &str = ".provenance.json";
pub const PROVENANCE_METADATA_KEY: &str = "mailwoman.provenance_id";
pub const MANIFEST_FORMAT: &str = "mailwoman-model-provenance/1";
pub const RECORD_FORMAT: &str = "mailwoman-training-record/1";

/// The grant claims a record carries: everything the verifier read except the holder's name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordedGrant {
	pub grant: String,
	pub agreement: String,
	pub kid: String,
	pub expires: String,
}

/// One authorization check: at the start of a run, or at a resume.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VerificationEvent {
	pub event: String,
	pub at: String,
	pub grant: Option<RecordedGrant>,
}

/// The checkpoint a run started from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunParent {
	pub run_id: Option<String>,
	pub model_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrainerIdentity {
	pub version: String,
	pub build: String,
	pub image: Option<String>,
}

/// `TRAINING.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrainingRecord {
	pub format: String,
	pub run_id: String,
	pub license_branch: String,
	pub grant: Option<RecordedGrant>,
	pub trainer: TrainerIdentity,
	pub resolved_config_sha256: String,
	pub corpus_manifest_sha256: Option<String>,
	pub parent: Option<RunParent>,
	pub verifications: Vec<VerificationEvent>,
}

/// One bound file, by its path relative to the manifest's directory.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BoundArtifact {
	pub path: String,
	pub sha256: String,
	pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManifestParent {
	pub provenance_id: String,
	pub manifest_sha256: String,
	pub transformation: String,
}

/// A manifest's payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProvenancePayload {
	pub v: u8,
	pub provenance_id: String,
	pub created: String,
	pub attestation: String,
	pub artifacts: Vec<BoundArtifact>,
	pub training: Option<TrainingRecord>,
	pub parent: Option<ManifestParent>,
}

/// A manifest file. `kid` and `signature` are both present for a signed manifest and both `null` otherwise.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProvenanceManifest {
	pub format: String,
	pub payload: String,
	pub kid: Option<String>,
	pub signature: Option<String>,
}

/// A provenance key and its id, `p<major>-<eight hex digits>`.
pub struct ProvenanceSigner {
	pub kid: String,
	pub key: SigningKey,
}

impl ProvenanceSigner {
	/// A signer whose id must carry its key's digest, so a mislabeled key never signs.
	pub fn new(kid: &str, key: SigningKey) -> Result<Self, String> {
		let digest = key_digest(&key.verifying_key());
		let shaped = kid.starts_with('p') && kid.ends_with(&format!("-{digest}"));
		if !shaped {
			return Err(format!(
				"provenance key id {kid} does not carry its key's digest {digest}"
			));
		}
		Ok(Self {
			kid: kid.to_owned(),
			key,
		})
	}
}

pub fn sha256_hex(bytes: &[u8]) -> String {
	Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// 12 random bytes as 24 lowercase hex digits, for run and provenance ids.
pub fn random_hex24() -> Result<String, String> {
	use std::io::Read;
	let mut bytes = [0u8; 12];
	std::fs::File::open("/dev/urandom")
		.and_then(|mut f| f.read_exact(&mut bytes))
		.map_err(|e| format!("/dev/urandom: {e}"))?;
	Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Hashes each file under `dir` and returns the entries a manifest binds, in the order given.
pub fn bind_artifacts(dir: &Path, paths: &[&str]) -> Result<Vec<BoundArtifact>, String> {
	paths
		.iter()
		.map(|path| {
			let bytes = std::fs::read(dir.join(path)).map_err(|e| format!("{}: {e}", dir.join(path).display()))?;
			Ok(BoundArtifact {
				path: (*path).to_owned(),
				sha256: sha256_hex(&bytes),
				bytes: bytes.len() as u64,
			})
		})
		.collect()
}

fn is_hex(text: &str, len: usize) -> bool {
	text.len() == len && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_id(text: &str, prefix: &str) -> bool {
	text.strip_prefix(prefix).is_some_and(|hex| is_hex(hex, 24))
}

/// The record checks of `TrainingRecordSchema`.
pub fn check_record(record: &TrainingRecord) -> Result<(), String> {
	let grant_ok = |g: &RecordedGrant| {
		![&g.grant, &g.agreement, &g.kid, &g.expires]
			.iter()
			.any(|s| s.is_empty())
	};
	let checks = [
		(record.format == RECORD_FORMAT, "format"),
		(is_id(&record.run_id, "mwrun_"), "run_id"),
		(
			["LicenseRef-Commercial", "AGPL-3.0-only"].contains(&record.license_branch.as_str()),
			"license_branch",
		),
		(record.grant.as_ref().is_none_or(grant_ok), "grant"),
		(
			!record.trainer.version.is_empty()
				&& ["commercial", "open-source"].contains(&record.trainer.build.as_str()),
			"trainer",
		),
		(is_hex(&record.resolved_config_sha256, 64), "resolved_config_sha256"),
		(
			record.corpus_manifest_sha256.as_deref().is_none_or(|s| is_hex(s, 64)),
			"corpus_manifest_sha256",
		),
		(
			record.parent.as_ref().is_none_or(|p| is_hex(&p.model_sha256, 64)),
			"parent",
		),
		(
			!record.verifications.is_empty()
				&& record.verifications.iter().all(|v| {
					["start", "resume"].contains(&v.event.as_str())
						&& is_utc_instant(&v.at)
						&& v.grant.as_ref().is_none_or(grant_ok)
				}),
			"verifications",
		),
	];
	match checks.iter().find(|(ok, _)| !ok) {
		Some((_, field)) => Err(format!("training.{field} does not match the record schema")),
		None => Ok(()),
	}
}

/// The payload checks of `ProvenancePayloadSchema`.
pub fn check_payload(payload: &ProvenancePayload) -> Result<(), String> {
	let path_ok = |p: &str| !p.is_empty() && !p.starts_with('/') && !p.split('/').any(|s| s == "..");
	let checks = [
		(payload.v == 1, "v"),
		(is_id(&payload.provenance_id, "mwprov_"), "provenance_id"),
		(is_utc_instant(&payload.created), "created"),
		(
			["managed", "customer-submitted", "unattested"].contains(&payload.attestation.as_str()),
			"attestation",
		),
		(
			!payload.artifacts.is_empty()
				&& payload
					.artifacts
					.iter()
					.all(|a| path_ok(&a.path) && is_hex(&a.sha256, 64)),
			"artifacts",
		),
		(
			payload.parent.as_ref().is_none_or(|p| {
				!p.provenance_id.is_empty()
					&& is_hex(&p.manifest_sha256, 64)
					&& ["quantize", "split-embeddings"].contains(&p.transformation.as_str())
			}),
			"parent",
		),
	];
	if let Some((_, field)) = checks.iter().find(|(ok, _)| !ok) {
		return Err(format!("payload.{field} does not match the payload schema"));
	}
	payload.training.as_ref().map_or(Ok(()), check_record)
}

/// Builds a manifest for `payload`, signed when a signer is given.
///
/// An unsigned manifest must declare the `unattested` attestation, and a signed one another.
pub fn encode_manifest(
	payload: &ProvenancePayload,
	signer: Option<&ProvenanceSigner>,
) -> Result<ProvenanceManifest, String> {
	check_payload(payload)?;
	if (payload.attestation == "unattested") != signer.is_none() {
		return Err(format!(
			"a manifest with attestation {} must {}be signed",
			payload.attestation,
			if signer.is_some() { "not " } else { "" }
		));
	}
	let encoded = BASE64URL.encode(serde_json::to_vec(payload).map_err(|e| e.to_string())?);
	let (kid, signature) = match signer {
		None => (None, None),
		Some(signer) => {
			let signature: Signature = signer.key.sign(format!("{PROVENANCE_PREFIX}.{encoded}").as_bytes());
			(Some(signer.kid.clone()), Some(BASE64URL.encode(signature.to_bytes())))
		}
	};
	Ok(ProvenanceManifest {
		format: MANIFEST_FORMAT.to_owned(),
		payload: encoded,
		kid,
		signature,
	})
}

/// The manifest path beside a graph: `model.onnx` → `model.provenance.json`.
pub fn manifest_path_for(graph: &Path) -> std::path::PathBuf {
	let stem = graph.file_stem().and_then(|s| s.to_str()).unwrap_or("model");
	graph.with_file_name(format!("{stem}{PROVENANCE_MANIFEST_SUFFIX}"))
}

/// Writes a manifest as pretty JSON with a trailing newline.
pub fn write_manifest(path: &Path, manifest: &ProvenanceManifest) -> Result<(), String> {
	let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())? + "\n";
	std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Why a manifest failed verification: the codes of `ProvenanceRefusal`.
#[derive(Clone, Debug, PartialEq)]
pub enum ProvenanceVerification {
	Verified {
		kid: Option<String>,
		payload: Box<ProvenancePayload>,
	},
	Refused {
		refusal: &'static str,
		reason: String,
	},
}

impl ProvenanceVerification {
	pub fn code(&self) -> &'static str {
		match self {
			Self::Verified { .. } => "verified",
			Self::Refused { refusal, .. } => refusal,
		}
	}
}

fn refused(refusal: &'static str, reason: impl Into<String>) -> ProvenanceVerification {
	ProvenanceVerification::Refused {
		refusal,
		reason: reason.into(),
	}
}

/// Reads and decodes a manifest's payload without checking its signature or the files it binds.
pub fn read_payload(manifest: &ProvenanceManifest) -> Result<ProvenancePayload, String> {
	let bytes = BASE64URL
		.decode(&manifest.payload)
		.map_err(|_| "payload is not base64url".to_owned())?;
	let payload: ProvenancePayload =
		serde_json::from_slice(&bytes).map_err(|e| format!("payload does not match the payload schema: {e}"))?;
	check_payload(&payload)?;
	Ok(payload)
}

/// Verifies a manifest file against the files beside it: the schemas, the signature under a trusted provenance key,
/// and each bound file's length and sha256. `require_signature` refuses an unattested manifest.
pub fn verify_manifest(path: &Path, trust: &TrustMap, require_signature: bool) -> ProvenanceVerification {
	let Ok(text) = std::fs::read_to_string(path) else {
		return refused("malformed", format!("{} cannot be read", path.display()));
	};
	let manifest: ProvenanceManifest = match serde_json::from_str(&text) {
		Ok(m) => m,
		Err(e) => return refused("malformed", format!("manifest: {e}")),
	};
	if manifest.format != MANIFEST_FORMAT || !is_base64url(&manifest.payload) {
		return refused(
			"malformed",
			"manifest: format or payload does not match the manifest schema",
		);
	}
	let payload = match read_payload(&manifest) {
		Ok(p) => p,
		Err(reason) => return refused("malformed", reason),
	};
	match (&manifest.kid, &manifest.signature) {
		(None, None) => {
			if payload.attestation != "unattested" {
				return refused(
					"unsigned",
					format!("an unsigned manifest declares attestation {}", payload.attestation),
				);
			}
			if require_signature {
				return refused("unsigned", "the manifest is unsigned");
			}
		}
		(Some(kid), Some(signature)) => {
			let Some(key) = trust.get(kid) else {
				return refused(
					"unknown_key",
					format!("signed by provenance key id {kid}, which this build does not trust"),
				);
			};
			let signed = is_base64url(signature)
				&& BASE64URL
					.decode(signature)
					.ok()
					.and_then(|bytes| Signature::from_slice(&bytes).ok())
					.is_some_and(|s| {
						key.verify_strict(format!("{PROVENANCE_PREFIX}.{}", manifest.payload).as_bytes(), &s)
							.is_ok()
					});
			if !signed {
				return refused("bad_signature", format!("signature does not verify under key id {kid}"));
			}
			if payload.attestation == "unattested" {
				return refused("malformed", "a signed manifest declares attestation unattested");
			}
		}
		_ => return refused("malformed", "kid and signature must be both present or both null"),
	}
	let dir = path.parent().unwrap_or(Path::new("."));
	for artifact in &payload.artifacts {
		match std::fs::read(dir.join(&artifact.path)) {
			Ok(bytes) if bytes.len() as u64 == artifact.bytes && sha256_hex(&bytes) == artifact.sha256 => {}
			Ok(_) => {
				return refused(
					"artifact_mismatch",
					format!("{} differs from the bytes the manifest binds", artifact.path),
				)
			}
			Err(_) => {
				return refused(
					"artifact_mismatch",
					format!("{} is missing beside the manifest", artifact.path),
				)
			}
		}
	}
	ProvenanceVerification::Verified {
		kid: manifest.kid.clone(),
		payload: Box::new(payload),
	}
}
