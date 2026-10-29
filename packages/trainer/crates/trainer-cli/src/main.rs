//! `trainer`: train from a resolved config, convert a Python checkpoint, and run the staged comparison.

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage:
  trainer parity f1 <record-dir> [--threads N] [--report <json>]";

fn threads(args: &[String]) -> i32 {
	args.windows(2)
		.find(|w| w[0] == "--threads")
		.and_then(|w| w[1].parse().ok())
		.unwrap_or(4)
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
	args.windows(2).find(|w| w[0] == name).map(|w| w[1].as_str())
}

fn run(args: &[String]) -> Result<bool, String> {
	match args.first().map(String::as_str) {
		Some("parity") => {
			let kind = args.get(1).ok_or(USAGE)?;
			let dir = PathBuf::from(args.get(2).ok_or(USAGE)?);
			tch::set_num_threads(threads(args));
			let results = match kind.as_str() {
				"f1" => trainer_loop::parity::f1::run(&dir).map_err(|e| e.to_string())?,
				other => return Err(format!("unknown parity check {other:?}\n{USAGE}")),
			};
			for r in &results {
				println!("{}", r.summary());
				for note in &r.notes {
					println!("    note: {note}");
				}
			}
			if let Some(path) = option(args, "--report") {
				let text = serde_json::to_string_pretty(&results).map_err(|e| e.to_string())?;
				std::fs::write(path, text + "\n").map_err(|e| format!("{path}: {e}"))?;
			}
			Ok(results.iter().all(|r| r.pass() && r.notes.is_empty()))
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
