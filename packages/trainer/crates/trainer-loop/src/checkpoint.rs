//! `train/checkpoint.py`'s resumable checkpoints in the Rust format, and the latest complete one.
//!
//! A checkpoint directory `step-XXXXXX/` holds `model.safetensors` and `config.json` (the model),
//! `optimizer.safetensors` and `optimizer.json`, `scheduler.json`, and `training_state.json`. Everything is written
//! into `.tmp-step-XXXXXX/` first, `training_state.json` last, and the directory is then renamed into place, so an
//! interrupted save leaves either the previous complete checkpoint or nothing `find_latest_checkpoint` reads. As in
//! the Python trainer, the data stream is not saved: a resume skips the batches its predecessors consumed.
//!
//! `rng_state.safetensors` holds the state of every generator the loop draws from: libtorch's default CPU generator,
//! the default generator of the CUDA device the model trains on, and any generator a loop owns, such as the MLM
//! mask's. A resume restores them (`restore_generators`), so dropout and the curriculum noise continue the sequence an
//! uninterrupted run would draw. The Python trainer reseeded from `train.seed` on every resume instead.

use crate::optim::AdamW;
use crate::schedules::LambdaLr;
use crate::{fail, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tch::{Device, Tensor};
use trainer_model::autocast::{default_generator_state, set_default_generator_state, Generator};
use trainer_model::CoarseEncoder;

pub const TRAINING_STATE: &str = "training_state.json";

/// Written into a run's output directory once its end-of-run writes have all succeeded: the final checkpoint, the
/// Fisher artifact and the realized draws. A periodic checkpoint at `max_steps` is written before them, so only this
/// file shows the run finished.
pub const TRAINING_COMPLETE: &str = "training-complete.json";

/// The step and the stamped `training_state.json` of a checkpoint a run resumes from.
///
/// A resume continues a run, so `optimizer.json` and an integer `step` are required. A weights-only checkpoint is a
/// starting point for `train.init_from`, not a run to resume. This reads and checks both before any state is loaded,
/// so a refused resume leaves the caller's optimizer and scheduler as they were.
pub fn read_resume_state(resume_from: &Path) -> Result<(i64, Value)> {
	if !resume_from.join("optimizer.json").is_file() {
		return Err(fail!(
			"{} holds no optimizer.json, so it is not a run to resume; start from it with train.init_from",
			resume_from.display()
		));
	}
	let state_path = resume_from.join(TRAINING_STATE);
	let state: Value = serde_json::from_str(
		&std::fs::read_to_string(&state_path).map_err(|e| fail!("{}: {e}", state_path.display()))?,
	)?;
	let step = state["step"]
		.as_i64()
		.ok_or_else(|| fail!("{}: `step` is not an integer: {}", state_path.display(), state["step"]))?;
	Ok((step, state))
}

/// The generator states a checkpoint saves beside the model.
pub const RNG_STATE: &str = "rng_state.safetensors";

const DEFAULT_CPU: &str = "default_cpu";
const DEFAULT_CUDA: &str = "default_cuda";

fn generator_states(device: Device, owned: &[(&str, &Generator)]) -> Result<Vec<(String, Tensor)>> {
	let mut states = vec![(DEFAULT_CPU.to_owned(), default_generator_state(Device::Cpu)?)];
	if device.is_cuda() {
		states.push((DEFAULT_CUDA.to_owned(), default_generator_state(device)?));
	}
	for (name, generator) in owned {
		states.push(((*name).to_owned(), generator.state()?));
	}
	Ok(states)
}

/// Restores the generators a checkpoint saved: the default ones and each of ``owned`` by name. Answers false, leaving
/// every generator as it is, for a checkpoint written before generator states were saved.
///
/// Raises when the checkpoint's states do not match this run: a CUDA state for a CPU run or the reverse, or an owned
/// generator it holds no state for.
pub fn restore_generators(dir: &Path, device: Device, owned: &mut [(&str, &mut Generator)]) -> Result<bool> {
	let path = dir.join(RNG_STATE);
	if !path.is_file() {
		return Ok(false);
	}
	let states = Tensor::read_safetensors(&path)?;
	let get = |name: &str| {
		states
			.iter()
			.find(|(n, _)| n == name)
			.map(|(_, t)| t)
			.ok_or_else(|| fail!("{} holds no {name} generator state", path.display()))
	};
	set_default_generator_state(Device::Cpu, get(DEFAULT_CPU)?)?;
	let saved_cuda = states.iter().any(|(n, _)| n == DEFAULT_CUDA);
	match (device.is_cuda(), saved_cuda) {
		(true, true) => set_default_generator_state(device, get(DEFAULT_CUDA)?)?,
		(false, false) => {}
		(run_cuda, _) => {
			return Err(fail!(
				"{} was saved by a {} run and this run trains on {device:?}",
				path.display(),
				if run_cuda { "CPU" } else { "CUDA" }
			))
		}
	}
	for (name, generator) in owned.iter_mut() {
		generator.set_state(get(name)?)?;
	}
	Ok(true)
}

/// `checkpoint_dir_name`.
pub fn checkpoint_dir_name(step: i64) -> String {
	format!("step-{step:06}")
}

/// `save_checkpoint`, with the default generators' states and those of ``generators``, which the loop owns.
pub fn save_checkpoint(
	model: &CoarseEncoder,
	output_dir: &Path,
	step: i64,
	extras: &Value,
	optim: Option<&AdamW>,
	scheduler: Option<&LambdaLr>,
	generators: &[(&str, &Generator)],
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
		Tensor::write_safetensors(&generator_states(model.device(), generators)?, tmp.join(RNG_STATE))?;
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
