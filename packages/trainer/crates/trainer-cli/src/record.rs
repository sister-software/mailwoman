// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `TRAINING.json`: the run's training record beside its checkpoints, written before training starts.
//!
//! A first process writes the record: a new run ID, the branch, the admitting grant's claims without its holder, the
//! trainer's identity, the resolved config's and corpus MANIFEST's sha256, and the parent checkpoint when the run
//! branches from another run's checkpoint or fine-tunes from `train.init_from`. Every later process in the same
//! output directory, a retry or a resume, keeps that record and appends its own verification event. A resume under
//! another branch or another grant is refused: it is a new run, which branches from a checkpoint into a new output
//! directory.

use crate::authorize::Branch;
use product_license::provenance::{
	check_record, random_hex24, sha256_hex, RecordedGrant, RunParent, TrainerIdentity, TrainingRecord,
	VerificationEvent, RECORD_FORMAT, TRAINING_RECORD_FILE,
};
use product_license::time::format_utc_instant;
use product_license::token::TrainingGrantPayload;
use std::path::{Path, PathBuf};
use trainer_loop::config::RunConfig;

/// The environment variable the Modal launcher sets to the published trainer image's name.
pub const TRAINER_IMAGE_ENV: &str = "MAILWOMAN_TRAINER_IMAGE";

fn recorded(grant: &TrainingGrantPayload) -> RecordedGrant {
	RecordedGrant {
		grant: grant.grant.clone(),
		agreement: grant.agreement.clone(),
		kid: grant.kid.clone(),
		expires: grant.expires.clone(),
	}
}

fn file_sha256(path: &Path) -> Result<String, String> {
	std::fs::read(path)
		.map(|bytes| sha256_hex(&bytes))
		.map_err(|e| format!("{}: {e}", path.display()))
}

/// The sha256 of a checkpoint's model weights: `model.safetensors`, or a converted Python checkpoint's
/// `pytorch_model.bin`.
fn model_sha256(checkpoint: &Path) -> Result<String, String> {
	for name in [
		trainer_model::checkpoint::MODEL_FILE,
		trainer_model::checkpoint::PYTORCH_MODEL_FILE,
	] {
		if checkpoint.join(name).is_file() {
			return file_sha256(&checkpoint.join(name));
		}
	}
	Err(format!(
		"{} holds no model weights to record as the run's parent",
		checkpoint.display()
	))
}

fn read_record(path: &Path) -> Result<TrainingRecord, String> {
	let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
	let record: TrainingRecord = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
	check_record(&record).map_err(|e| format!("{}: {e}", path.display()))?;
	Ok(record)
}

/// The parent of a run that starts in a fresh output directory: the checkpoint `--resume` names outside the output
/// directory (a branch), else `train.init_from` (a fine-tune), else none.
///
/// A parent whose run recorded another license branch is refused: an `AGPL-3.0-only` checkpoint can't seed a run
/// whose export is signed under the commercial branch, and a commercial checkpoint can't seed an open-source run.
fn parent(
	run: &RunConfig,
	output_dir: &Path,
	resume: Option<&Path>,
	branch: Branch,
) -> Result<Option<RunParent>, String> {
	let checkpoint = match resume.filter(|dir| !dir.starts_with(output_dir)) {
		Some(dir) => Some(dir.to_path_buf()),
		None => Some(run.train_str("init_from").map_err(|e| e.to_string())?)
			.filter(|s| !s.is_empty())
			.map(PathBuf::from),
	};
	let Some(checkpoint) = checkpoint else {
		return Ok(None);
	};
	let parent_record = checkpoint.parent().map(|run_dir| run_dir.join(TRAINING_RECORD_FILE));
	let run_id = match parent_record.filter(|p| p.is_file()) {
		Some(path) => {
			let record = read_record(&path)?;
			if record.license_branch != branch.license() {
				return Err(format!(
					"{} trained under {}, and this trainer trains under {}; a run's parent checkpoint must come from a \
					 run of the same license branch",
					path.display(),
					record.license_branch,
					branch.license()
				));
			}
			Some(record.run_id)
		}
		None => None,
	};
	Ok(Some(RunParent {
		run_id,
		model_sha256: model_sha256(&checkpoint)?,
	}))
}

/// Writes or extends the run's training record before training starts, and returns the record.
pub fn prepare(
	run: &RunConfig,
	resolved: &Path,
	resume: Option<&Path>,
	grant: Option<&TrainingGrantPayload>,
	now_ms: i64,
) -> Result<TrainingRecord, String> {
	let branch = Branch::compiled();
	let output_dir = run.output_dir().map_err(|e| e.to_string())?;
	std::fs::create_dir_all(&output_dir).map_err(|e| format!("{}: {e}", output_dir.display()))?;
	let path = output_dir.join(TRAINING_RECORD_FILE);
	let event = |kind: &str| VerificationEvent {
		event: kind.to_owned(),
		at: format_utc_instant(now_ms),
		grant: grant.map(recorded),
	};
	let record = if path.is_file() {
		let mut record = read_record(&path)?;
		if record.license_branch != branch.license() {
			return Err(format!(
				"{} trained under {}, and this trainer trains under {}; branch from a checkpoint into a new output directory",
				path.display(),
				record.license_branch,
				branch.license()
			));
		}
		let recorded_grant = record.grant.as_ref().map(|g| g.grant.as_str());
		if recorded_grant != grant.map(|g| g.grant.as_str()) {
			return Err(format!(
				"{} was admitted under grant {}, and this process holds grant {}; a run keeps one grant, so branch from a \
				 checkpoint into a new output directory",
				path.display(),
				recorded_grant.unwrap_or("none"),
				grant.map_or("none", |g| g.grant.as_str())
			));
		}
		record.verifications.push(event("resume"));
		record
	} else {
		let corpus_manifest = run
			.data_str("corpus_dir")
			.map_err(|e| e.to_string())?
			.map(|dir| Path::new(&dir).join("MANIFEST.json"))
			.filter(|manifest| manifest.is_file());
		TrainingRecord {
			format: RECORD_FORMAT.to_owned(),
			run_id: format!("mwrun_{}", random_hex24()?),
			license_branch: branch.license().to_owned(),
			grant: grant.map(recorded),
			trainer: TrainerIdentity {
				version: env!("CARGO_PKG_VERSION").to_owned(),
				build: branch.build().to_owned(),
				image: std::env::var(TRAINER_IMAGE_ENV).ok().filter(|s| !s.is_empty()),
			},
			resolved_config_sha256: file_sha256(resolved)?,
			corpus_manifest_sha256: corpus_manifest.as_deref().map(file_sha256).transpose()?,
			parent: parent(run, &output_dir, resume, branch)?,
			verifications: vec![event("start")],
		}
	};
	check_record(&record)?;
	let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())? + "\n";
	std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
	Ok(record)
}
