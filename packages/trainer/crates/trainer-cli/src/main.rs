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
  trainer train <resolved.json> [--set section.key=value]... [--resume <dir>|auto] [--threads N]
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
		let text = serde_json::to_string_pretty(results).map_err(|e| e.to_string())?;
		std::fs::write(path, text + "\n").map_err(|e| format!("{path}: {e}"))?;
	}
	Ok(results.iter().all(|r| r.pass() && r.notes.is_empty()))
}

/// The `stage3` BIO labels, the map a checkpoint without `id2label` takes.
fn stage3_labels(text: &str) -> Result<Vec<String>, String> {
	let doc: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
	doc.pointer("/label_sets/stage3/bio_labels")
		.and_then(|v| v.as_array())
		.map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
		.ok_or_else(|| "the label schema has no stage3 set".to_owned())
}

fn run(args: &[String]) -> Result<bool, String> {
	set_threads(args);
	let err = |e: trainer_loop::Error| e.to_string();
	match args.first().map(String::as_str) {
		Some("train") => {
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
			// Two checkpoint directories' weights, and their Fisher artifacts when both hold one.
			let a = PathBuf::from(args.get(1).ok_or(USAGE)?);
			let b = PathBuf::from(args.get(2).ok_or(USAGE)?);
			let ta = trainer_model::checkpoint::read_model_tensors(&a).map_err(|e| e.to_string())?;
			let tb = trainer_model::checkpoint::read_model_tensors(&b).map_err(|e| e.to_string())?;
			let mut result = StageResult::new("checkpoint weights", "exact");
			for (name, t) in &ta {
				let other = tb.iter().find(|(n, _)| n == name).map(|(_, t)| t);
				match other {
					Some(o) => result.push(
						trainer_loop::compare::diff(name, t, o, trainer_loop::compare::Tolerance::Exact)
							.map_err(err)?,
					),
					None => result.notes.push(format!("{name} is in the first checkpoint only")),
				}
			}
			let mut results = vec![result];
			let fa = a.join(trainer_loop::fisher::FISHER_ARTIFACT);
			let fb = b.join(trainer_loop::fisher::FISHER_ARTIFACT);
			if fa.is_file() && fb.is_file() {
				let xa = trainer_loop::fisher::read_npz(&fa).map_err(err)?;
				let xb = trainer_loop::fisher::read_npz(&fb).map_err(err)?;
				let mut fisher = StageResult::new("Fisher artifact", "1e-5 rel");
				for (name, t) in &xa {
					if let Some((_, o)) = xb.iter().find(|(n, _)| n == name) {
						fisher.push(
							trainer_loop::compare::diff(
								name,
								t,
								o,
								trainer_loop::compare::Tolerance::Relative { rel: 1e-5, floor: 1e-3 },
							)
							.map_err(err)?,
						);
					} else {
						fisher.notes.push(format!("{name} is in the first artifact only"));
					}
				}
				results.push(fisher);
			}
			report(&results, args)
		}
		Some("export-feeds") => {
			let checkpoint = PathBuf::from(option(args, "--checkpoint").ok_or(USAGE)?);
			let record = PathBuf::from(option(args, "--record").ok_or(USAGE)?);
			let out = PathBuf::from(option(args, "--out").ok_or(USAGE)?);
			let rows = option(args, "--rows").and_then(|n| n.parse().ok()).unwrap_or(64);
			let files = DataFiles::discover();
			let schema = std::fs::read_to_string(&files.label_schema).map_err(|e| e.to_string())?;
			let schema = stage3_labels(&schema)?;
			let n = trainer_loop::export_check::write_feeds(&checkpoint, &record, &out, rows, &schema).map_err(err)?;
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
