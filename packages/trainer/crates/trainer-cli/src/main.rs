//! `trainer`: train from a resolved config, convert a Python checkpoint, and run the staged comparison.
//!
//! The resolved config is what `mailwoman train config resolve <config.yaml> --out <resolved.json>` writes. The
//! repository data files (postcode layouts, shapes, syntax, the address-system registry and the label schema) are
//! read from the checkout the binary was built from, or from `MAILWOMAN_REPO_ROOT`.

use std::path::PathBuf;
use std::process::ExitCode;
use trainer_loop::compare::StageResult;
use trainer_loop::config::{DataFiles, RunConfig};
use trainer_loop::supervised::TrainOptions;

const USAGE: &str = "usage:
  trainer train <resolved.json> [--set section.key=value]... [--resume <dir>|auto] [--threads N] [--device cpu|cuda]
  trainer device [--device cpu|cuda]
  trainer convert-checkpoint <python-checkpoint-dir> [--out <dir>]
  trainer compare-checkpoints <dir-a> <dir-b> [--report <json>]
  trainer export-feeds --checkpoint <dir> --record <record.safetensors> --out <feeds.json> [--rows N]
  trainer parity f1 <record-dir> [--threads N] [--report <json>]
  trainer parity stages <record-dir> --config <resolved.json> [--no-sample] [--threads N] [--report <json>]";

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
	args.windows(2).find(|w| w[0] == name).map(|w| w[1].as_str())
}

fn options<'a>(args: &'a [String], name: &str) -> Vec<&'a str> {
	args.windows(2)
		.filter(|w| w[0] == name)
		.map(|w| w[1].as_str())
		.collect()
}

fn set_threads(args: &[String]) {
	if let Some(n) = option(args, "--threads").and_then(|n| n.parse().ok()) {
		tch::set_num_threads(n);
	}
}

fn report(results: &[StageResult], args: &[String]) -> Result<bool, String> {
	for r in results {
		println!("{}", r.summary());
		for note in &r.notes {
			println!("    note: {note}");
		}
	}
	if let Some(path) = option(args, "--report") {
		let report = trainer_loop::parity::Report::new(results).map_err(|e| e.to_string())?;
		let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
		std::fs::write(path, text + "\n").map_err(|e| format!("{path}: {e}"))?;
	}
	Ok(results.iter().all(|r| r.pass() && r.notes.is_empty()))
}

/// The device a run must train on: `--device`, else `MAILWOMAN_EXPECT_DEVICE`, else whichever the trainer picks.
fn expected_device(args: &[String]) -> Option<String> {
	option(args, "--device")
		.map(str::to_owned)
		.or_else(|| std::env::var("MAILWOMAN_EXPECT_DEVICE").ok())
		.filter(|v| !v.is_empty())
		.map(|v| v.to_ascii_lowercase())
}

/// What libtorch reports about CUDA, for the refusal and for `trainer device`.
fn cuda_report() -> String {
	format!(
		"has_cuda={} has_cudart={} cuda_available={} device_count={}",
		tch::utils::has_cuda(),
		tch::utils::has_cudart(),
		tch::Cuda::is_available(),
		tch::Cuda::device_count()
	)
}

/// Refuse a run whose chosen device is not the expected one, before the corpus is opened. The trainer takes the first
/// CUDA device when libtorch has one, so a CUDA backend that failed to load would otherwise train on the CPU.
fn check_device(args: &[String]) -> Result<(), String> {
	let chosen = trainer_loop::supervised::device();
	let Some(expected) = expected_device(args) else {
		return Ok(());
	};
	let matches = match expected.as_str() {
		"cuda" => chosen.is_cuda(),
		"cpu" => !chosen.is_cuda(),
		other => return Err(format!("unknown device {other:?} (expected cpu or cuda)")),
	};
	if matches {
		Ok(())
	} else {
		Err(format!(
			"the run expects device {expected}, but libtorch gives {chosen:?} ({})",
			cuda_report()
		))
	}
}

fn run(args: &[String]) -> Result<bool, String> {
	set_threads(args);
	let err = |e: trainer_loop::Error| e.to_string();
	match args.first().map(String::as_str) {
		Some("device") => {
			println!("device={:?} {}", trainer_loop::supervised::device(), cuda_report());
			check_device(args)?;
			Ok(true)
		}
		Some("train") => {
			check_device(args)?;
			let path = PathBuf::from(args.get(1).ok_or(USAGE)?);
			let mut run = RunConfig::read(&path).map_err(err)?;
			for s in options(args, "--set") {
				run.set(s).map_err(err)?;
			}
			let opts = TrainOptions {
				resume: option(args, "--resume").map(str::to_owned),
				files: None,
				autocast_on_cpu: args.iter().any(|a| a == "--autocast-cpu"),
			};
			trainer_loop::supervised::train(&run, &opts).map_err(err)?;
			Ok(true)
		}
		Some("convert-checkpoint") => {
			let dir = PathBuf::from(args.get(1).ok_or(USAGE)?);
			let out = option(args, "--out").map(PathBuf::from).unwrap_or_else(|| dir.clone());
			let n = trainer_model::checkpoint::convert_pytorch_checkpoint(&dir, &out).map_err(|e| e.to_string())?;
			println!(
				"{n} tensors -> {}",
				out.join(trainer_model::checkpoint::MODEL_FILE).display()
			);
			Ok(true)
		}
		Some("compare-checkpoints") => {
			let a = PathBuf::from(args.get(1).ok_or(USAGE)?);
			let b = PathBuf::from(args.get(2).ok_or(USAGE)?);
			println!("scope: {}", trainer_loop::compare::CHECKPOINT_SCOPE);
			let results = trainer_loop::compare::compare_checkpoints(&a, &b).map_err(err)?;
			report(&results, args)
		}
		Some("export-feeds") => {
			let checkpoint = PathBuf::from(option(args, "--checkpoint").ok_or(USAGE)?);
			let record = PathBuf::from(option(args, "--record").ok_or(USAGE)?);
			let out = PathBuf::from(option(args, "--out").ok_or(USAGE)?);
			let rows = option(args, "--rows").and_then(|n| n.parse().ok()).unwrap_or(64);
			let files = DataFiles::discover();
			let schema = trainer_loop::batch::read_label_schema(&files).map_err(err)?;
			let (labels, conventions) = (
				schema.set("stage3").map_err(|e| e.to_string())?,
				schema.conventions_by_locale(),
			);
			let defaults = trainer_model::SchemaDefaults {
				labels: &labels.bio_labels,
				conventions: &conventions,
			};
			let n = trainer_loop::export_check::write_feeds(&checkpoint, &record, &out, rows, defaults).map_err(err)?;
			println!("{n} probes -> {}", out.display());
			Ok(true)
		}
		Some("parity") => {
			let kind = args.get(1).ok_or(USAGE)?;
			let dir = PathBuf::from(args.get(2).ok_or(USAGE)?);
			let results = match kind.as_str() {
				"f1" => trainer_loop::parity::f1::run(&dir).map_err(err)?,
				"stages" => {
					let resolved = PathBuf::from(option(args, "--config").ok_or(USAGE)?);
					let files = DataFiles::discover();
					trainer_loop::parity::stages::run(&trainer_loop::parity::stages::CellInputs {
						record_dir: &dir,
						resolved: &resolved,
						files: &files,
						sample: !args.iter().any(|a| a == "--no-sample"),
					})
					.map_err(err)?
				}
				other => return Err(format!("unknown parity check {other:?}\n{USAGE}")),
			};
			report(&results, args)
		}
		_ => Err(USAGE.to_owned()),
	}
}

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	match run(&args) {
		Ok(true) => ExitCode::SUCCESS,
		Ok(false) => ExitCode::from(1),
		Err(message) => {
			eprintln!("{message}");
			ExitCode::from(2)
		}
	}
}
