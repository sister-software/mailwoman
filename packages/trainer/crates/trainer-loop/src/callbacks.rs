//! `train/callbacks/`: the console lines, `train_log.csv`, and the interval checkpoints.
//!
//! The Trackio mirror is retired: `train_log.csv` is the run's metric record, and a config that sets
//! `train.trackio_enabled` is refused by [`refuse_trackio`].

/// Refuses `train.trackio_enabled`, which the Python trainer mirrored to a Hugging Face Space and the Rust trainer
/// does not.
pub fn refuse_trackio(run: &crate::config::RunConfig) -> crate::Result<()> {
	if run.train_bool("trackio_enabled")? {
		return Err(crate::fail!(
			"train.trackio_enabled is set, and the Rust trainer has no Trackio mirror (retired in the Python removal \
			 plan); unset it and read train_log.csv"
		));
	}
	Ok(())
}

use crate::checkpoint::{checkpoint_extras, save_checkpoint};
use crate::metrics::{eval_csv_row, Metrics};
use crate::optim::AdamW;
use crate::schedules::LambdaLr;
use crate::Result;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use trainer_model::CoarseEncoder;

/// What a callback can read of a run in progress.
pub struct StepView<'a> {
	pub model: &'a CoarseEncoder,
	pub optim: &'a AdamW,
	pub scheduler: &'a LambdaLr,
	pub output_dir: &'a Path,
	pub config: &'a Value,
	pub vocab_size: i64,
	pub start_step: i64,
	pub elapsed: f64,
	pub train_loss: f64,
	pub learning_rate: f64,
}

/// A run observer. A callback that must stop the run returns an error.
pub trait Callback {
	fn on_step_end(&mut self, view: &StepView, step: i64) -> Result<()>;
	fn on_eval_end(&mut self, view: &StepView, step: i64, metrics: &Metrics) -> Result<()>;
	fn on_train_end(&mut self) -> Result<()> {
		Ok(())
	}
}

/// An integer with thousands separators, Python's `{n:,}`.
pub fn grouped(n: i64) -> String {
	let digits = n.unsigned_abs().to_string();
	let mut out = String::new();
	for (i, c) in digits.chars().enumerate() {
		if i > 0 && (digits.len() - i).is_multiple_of(3) {
			out.push(',');
		}
		out.push(c);
	}
	if n < 0 {
		format!("-{out}")
	} else {
		out
	}
}

/// The five tags the eval block prints inline.
const HEADLINE_TAGS: [&str; 5] = ["locality", "region", "street", "house_number", "postcode"];

/// `ConsoleCallback`.
pub struct Console {
	pub log_every: i64,
	pub max_steps: i64,
}

impl Callback for Console {
	fn on_step_end(&mut self, view: &StepView, step: i64) -> Result<()> {
		if step % self.log_every != 0 {
			return Ok(());
		}
		let ran = step - view.start_step;
		let rate = if view.elapsed > 0.0 {
			ran as f64 / view.elapsed
		} else {
			0.0
		};
		let span = if view.start_step != 0 {
			format!(" over {} since step {}", grouped(ran), grouped(view.start_step))
		} else {
			String::new()
		};
		println!(
			"step {step}/{}  train_loss={:.4}  lr={:.6}  rate={rate:.2} steps/s{span}",
			self.max_steps, view.train_loss, view.learning_rate
		);
		Ok(())
	}

	fn on_eval_end(&mut self, _view: &StepView, _step: i64, m: &Metrics) -> Result<()> {
		let get = |k: &str, d: f64| m.get(k).copied().unwrap_or(d);
		let tags: Vec<String> = HEADLINE_TAGS
			.iter()
			.map(|t| format!("{t}={:.3}", get(&format!("f1_tag.{t}"), 0.0)))
			.collect();
		println!(
			"  [eval] val_loss={:.4}  macro_f1={:.4}  val_rows={}\n         {}",
			get("val_loss", f64::NAN),
			get("macro_f1", 0.0),
			get("val_rows", 0.0) as i64,
			tags.join("  ")
		);
		if let Some(cp) = m.get("cross_pollution") {
			let per: Vec<String> = m
				.iter()
				.filter_map(|(k, v)| {
					k.strip_prefix("cross_pollution.")
						.map(|loc| format!("{loc}={:.2}%", v * 100.0))
				})
				.collect();
			println!(
				"         [pr3] cross_pollution={:.2}%  ({})  locale_acc={:.3}",
				cp * 100.0,
				per.join("  "),
				get("locale_acc", f64::NAN)
			);
		}
		Ok(())
	}
}

/// `CSVMetricsCallback`: step rows and eval rows in one file, `\r\n`-terminated as Python's `csv.writer` writes.
pub struct CsvMetrics {
	file: std::fs::File,
	log_every: i64,
	tags: Vec<String>,
}

fn write_row(file: &mut std::fs::File, cells: &[String]) -> Result<()> {
	file.write_all(cells.join(",").as_bytes())?;
	file.write_all(b"\r\n")?;
	file.flush()?;
	Ok(())
}

impl CsvMetrics {
	/// Opens the CSV: appended to on a resume that finds it, started with a header otherwise.
	pub fn open(path: &PathBuf, log_every: i64, tags: Vec<String>, resume_step: i64) -> Result<Self> {
		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent)?;
		}
		let append = resume_step > 0 && path.is_file();
		let mut file = std::fs::OpenOptions::new()
			.create(true)
			.write(true)
			.append(append)
			.truncate(!append)
			.open(path)?;
		if !append {
			let mut header: Vec<String> = ["step", "wall_seconds", "train_loss", "lr", "val_loss", "val_macro_f1"]
				.iter()
				.map(|s| (*s).to_owned())
				.collect();
			header.extend(tags.iter().map(|t| format!("f1.{t}")));
			header.extend(tags.iter().map(|t| format!("support.{t}")));
			write_row(&mut file, &header)?;
		}
		Ok(Self { file, log_every, tags })
	}
}

impl Callback for CsvMetrics {
	fn on_step_end(&mut self, view: &StepView, step: i64) -> Result<()> {
		if step % self.log_every != 0 {
			return Ok(());
		}
		let mut cells = vec![
			step.to_string(),
			format!("{:.1}", view.elapsed),
			format!("{:.6}", view.train_loss),
			format!("{:.8}", view.learning_rate),
			String::new(),
			String::new(),
		];
		cells.extend(std::iter::repeat_n(String::new(), 2 * self.tags.len()));
		write_row(&mut self.file, &cells)
	}

	fn on_eval_end(&mut self, view: &StepView, step: i64, metrics: &Metrics) -> Result<()> {
		write_row(&mut self.file, &eval_csv_row(step, view.elapsed, metrics, &self.tags))
	}
}

/// `CheckpointerCallback`: a checkpoint every `save_every` steps.
pub struct Checkpointer {
	pub save_every: i64,
}

impl Callback for Checkpointer {
	fn on_step_end(&mut self, view: &StepView, step: i64) -> Result<()> {
		if step % self.save_every != 0 {
			return Ok(());
		}
		let saved = save_checkpoint(
			view.model,
			view.output_dir,
			step,
			&checkpoint_extras(step, view.config, view.vocab_size),
			Some(view.optim),
			Some(view.scheduler),
		)?;
		println!("  [save] checkpoint → {}", saved.display());
		Ok(())
	}

	fn on_eval_end(&mut self, _view: &StepView, _step: i64, _metrics: &Metrics) -> Result<()> {
		Ok(())
	}
}
