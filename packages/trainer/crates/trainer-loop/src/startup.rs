// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The startup log: one line per step a run takes before its first batch, so a launch that is still opening its corpus
//! reads as working rather than stuck.
//!
//! Each line is `<tag> <UTC time> <step>: <detail> (<seconds>s)`, and the seconds run from the previous line, so every
//! moment of startup is counted against one step.

use crate::Result;
use mtf_sampler::corpus_files::{index_split, CorpusFile, SplitIndex};
use std::fmt::Display;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The startup log of one run.
pub struct Startup {
	tag: &'static str,
	since: Instant,
	/// How often a long step reports its progress.
	every: Duration,
}

impl Startup {
	pub fn new(tag: &'static str) -> Self {
		Self {
			tag,
			since: Instant::now(),
			every: Duration::from_secs(30),
		}
	}

	/// Sets how often a long step reports its progress.
	pub fn with_progress_every(mut self, every: Duration) -> Self {
		self.every = every;
		self
	}

	fn line(&self, message: impl Display, since: Instant) {
		println!(
			"{} {} {message} ({:.2}s)",
			self.tag,
			chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
			since.elapsed().as_secs_f64()
		);
	}

	/// Prints the step that ends now, timed from the previous line, and starts the next one.
	pub fn step(&mut self, message: impl Display) {
		self.line(message, self.since);
		self.since = Instant::now();
	}

	/// Prints the checkpoint a run resumes from, given `--resume` as `requested`.
	pub fn resume(&mut self, requested: Option<&str>, resume: Option<&Path>) {
		match (requested, resume) {
			(Some("auto"), Some(dir)) => self.step(format_args!("resume auto: {}", dir.display())),
			(Some("auto"), None) => self.step("resume auto: no complete checkpoint, starting fresh"),
			(_, Some(dir)) => self.step(format_args!("resume: {}", dir.display())),
			(_, None) => self.step("resume: not requested, starting fresh"),
		}
	}

	/// Indexes the train split's files by source, reporting the running totals while the count runs.
	pub fn index_files(&mut self, files: &[CorpusFile]) -> Result<SplitIndex> {
		let last_line = Mutex::new(Instant::now());
		let index = index_split(files, &|index| {
			let mut last = last_line.lock().expect("not poisoned");
			if last.elapsed() >= self.every && index.files < files.len() {
				self.line(
					format_args!("sampler index ({}/{} files): {index} so far", index.files, files.len()),
					self.since,
				);
				*last = Instant::now();
			}
		})?;
		Ok(index)
	}
}
