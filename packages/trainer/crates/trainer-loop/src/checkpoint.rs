//! `train/checkpoint.py`'s resumable checkpoints in the Rust format, and the latest complete one.
//!
//! A checkpoint directory `step-XXXXXX/` holds `model.safetensors` and `config.json` (the model),
//! `optimizer.safetensors` and `optimizer.json`, `scheduler.json`, and `training_state.json`. Everything is written
//! into `.tmp-step-XXXXXX/` first, `training_state.json` last, and the directory is then renamed into place, so an
//! interrupted save leaves either the previous complete checkpoint or nothing `find_latest_checkpoint` reads. As in
//! the Python trainer, the data stream is not saved: a resume skips the batches its predecessors consumed.

use crate::optim::AdamW;
use crate::schedules::LambdaLr;
use crate::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use trainer_model::CoarseEncoder;

pub const TRAINING_STATE: &str = "training_state.json";

/// `checkpoint_dir_name`.
pub fn checkpoint_dir_name(step: i64) -> String {
	format!("step-{step:06}")
}

/// `save_checkpoint`.
pub fn save_checkpoint(
	model: &CoarseEncoder,
	output_dir: &Path,
	step: i64,
	extras: &Value,
	optim: Option<&AdamW>,
	scheduler: Option<&LambdaLr>,
) -> Result<PathBuf> {
	let ck = output_dir.join(checkpoint_dir_name(step));
	let tmp = output_dir.join(format!(".tmp-{}", checkpoint_dir_name(step)));
	if tmp.exists() {
		std::fs::remove_dir_all(&tmp)?;
	}
	std::fs::create_dir_all(&tmp)?;
	let written = (|| -> Result<()> {
		trainer_model::checkpoint::write_model(&tmp, &model.store, &model.spec)?;
		if let Some(o) = optim {
			o.save(&tmp)?;
		}
		if let Some(s) = scheduler {
			s.save(&tmp)?;
		}
		std::fs::write(tmp.join(TRAINING_STATE), serde_json::to_string_pretty(extras)? + "\n")?;
		Ok(())
	})();
	if let Err(e) = written {
		let _ = std::fs::remove_dir_all(&tmp);
		return Err(e);
	}
	if ck.exists() {
		std::fs::remove_dir_all(&ck)?;
	}
	std::fs::rename(&tmp, &ck)?;
	Ok(ck)
}

/// `find_latest_checkpoint`: the highest-step `step-*` directory holding `training_state.json`.
pub fn find_latest_checkpoint(output_dir: &Path) -> Result<Option<PathBuf>> {
	if !output_dir.is_dir() {
		return Ok(None);
	}
	let mut candidates: Vec<PathBuf> = std::fs::read_dir(output_dir)?
		.filter_map(|e| e.ok().map(|e| e.path()))
		.filter(|p| {
			p.file_name()
				.and_then(|n| n.to_str())
				.is_some_and(|n| n.starts_with("step-"))
				&& p.join(TRAINING_STATE).is_file()
		})
		.collect();
	candidates.sort();
	Ok(candidates.pop())
}

/// `checkpoint_extras`: the step, the config stamped for the resume-drift report, and the vocabulary width.
pub fn checkpoint_extras(step: i64, config: &Value, vocab_size: i64) -> Value {
	serde_json::json!({
		"step": step,
		"config": {
			"data": config.get("data").cloned().unwrap_or(Value::Null),
			"model": config.get("model").cloned().unwrap_or(Value::Null),
			"train": config.get("train").cloned().unwrap_or(Value::Null),
		},
		"vocab_size": vocab_size,
	})
}

/// `_report_resume_drift`: one line per config field that differs from the checkpoint's stamped config.
///
/// `max_steps` is reported because the live config's schedule replaces the checkpoint's on resume
/// (`LambdaLr::load`), so a changed horizon changes every later rate.
pub fn resume_drift(live: &Value, saved: &Value) -> Vec<String> {
	let mut drift = Vec::new();
	for section in ["data", "model", "train"] {
		let Some(live_section) = live.get(section).and_then(Value::as_object) else {
			continue;
		};
		for (key, live_value) in live_section {
			if ["output_dir", "trackio_run_name", "csv_log_path"].contains(&key.as_str()) {
				continue;
			}
			let saved_value = saved.get(section).and_then(|s| s.get(key));
			if saved_value != Some(live_value) {
				drift.push(format!(
					"{section}.{key}: checkpoint={} -> live={live_value}",
					saved_value.map_or("<absent>".to_owned(), Value::to_string)
				));
			}
		}
	}
	drift
}
