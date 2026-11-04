//! The rows a supervised run trained on, written for the realized-draws stage of the exposure report.
//!
//! The Python loop counted each consumed row with `exposure/report.py`'s `StageCounter` and wrote
//! `exposure-realized-from-<step>.json`. The Rust loop writes the rows instead, and
//! `packages/mailwoman/tools/training/exposure/realized.run.ts` counts them with the TypeScript phenomena and writes
//! the same report, so the phenomenon predicates keep one implementation.
//!
//! The run writes `exposure-realized-from-<step>.rows.jsonl.zst`, one JSON object per consumed row with its `raw`,
//! `country` and span triple, and when it ends `exposure-realized-from-<step>.rows.json`, which records the stream's
//! file name, its row count and the report's inputs. The second file is written last, so its presence marks a complete stream. A
//! resumed process counts only what it trains and writes its own segment from the step it resumed at, as the Python
//! loop did.

use crate::{fail, Result};
use mtf_sampler::Row;
use serde::Serialize;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// The schema the stream's description declares.
pub const REALIZED_ROWS_SCHEMA: &str = "mailwoman.realized-rows/v1";
/// The schema of a checkpoint's country–shape counts.
pub const SHAPE_COUNTS_SCHEMA: &str = "mailwoman.exposure-shapes/v1";

/// The separator `shapeKeyOf` joins a shape's tags with.
const SHAPE_SEPARATOR: &str = " -> ";

/// The retention table's key for a row: `<country>|<tag> -> <tag> -> …`.
fn shape_key(country: &str, tags: &[String]) -> String {
	format!("{country}|{}", tags.join(SHAPE_SEPARATOR))
}

/// zstd's default level.
const LEVEL: i32 = 3;

/// One consumed row, as `StageCounter.add_span_row` read it, with its source and stable identity.
#[derive(Serialize)]
struct RowRecord<'a> {
	raw: &'a str,
	country: Option<&'a str>,
	source: &'a str,
	source_id: Option<&'a str>,
	span_starts: Option<&'a [i64]>,
	span_ends: Option<&'a [i64]>,
	span_tags: Option<&'a [String]>,
}

/// The stream's two file names for a segment that starts at `resume_step`.
pub fn realized_paths(output_dir: &Path, resume_step: i64) -> (PathBuf, PathBuf) {
	let stem = format!("exposure-realized-from-{resume_step}.rows");
	(
		output_dir.join(format!("{stem}.jsonl.zst")),
		output_dir.join(format!("{stem}.json")),
	)
}

/// The open stream of one run segment.
pub struct RealizedRows {
	encoder: zstd::Encoder<'static, BufWriter<File>>,
	staged: PathBuf,
	rows_path: PathBuf,
	meta_path: PathBuf,
	resume_step: i64,
	count: u64,
	shapes: HashMap<String, u64>,
}

impl RealizedRows {
	pub fn create(output_dir: &Path, resume_step: i64) -> Result<Self> {
		let (rows_path, meta_path) = realized_paths(output_dir, resume_step);
		let staged = PathBuf::from(format!("{}.partial", rows_path.display()));
		let file = File::create(&staged).map_err(|e| fail!("{}: {e}", staged.display()))?;
		let encoder = zstd::Encoder::new(BufWriter::new(file), LEVEL)?;
		Ok(Self {
			encoder,
			staged,
			rows_path,
			meta_path,
			resume_step,
			count: 0,
			shapes: HashMap::new(),
		})
	}

	/// Appends a consumed batch's rows.
	pub fn add(&mut self, rows: &[Row]) -> Result<()> {
		for row in rows {
			let spans = row.spans.as_ref();
			let record = RowRecord {
				raw: &row.raw,
				country: row.country.as_deref(),
				source: &row.source,
				source_id: row.source_id.as_deref(),
				span_starts: spans.map(|s| s.starts.as_slice()),
				span_ends: spans.map(|s| s.ends.as_slice()),
				span_tags: spans.map(|s| s.tags.as_slice()),
			};
			serde_json::to_writer(&mut self.encoder, &record)?;
			self.encoder.write_all(b"\n")?;
			self.count += 1;
			if let (Some(country), Some(spans)) = (row.country.as_deref(), spans) {
				*self.shapes.entry(shape_key(country, &spans.tags)).or_insert(0) += 1;
			}
		}
		Ok(())
	}

	/// Writes the consumed-row count of every country–shape key so far, as `exposure-shapes-<step>.json`.
	///
	/// A checkpoint writes one, so the run's exposure to each retained form can be compared with the retention table
	/// while the run continues. The keys are `shapeKeyOf`'s from `packages/corpus/lib/utils/retention.ts`.
	pub fn write_shape_counts(&self, output_dir: &Path, step: i64) -> Result<PathBuf> {
		let path = output_dir.join(format!("exposure-shapes-{step}.json"));
		let shapes: BTreeMap<&str, u64> = self.shapes.iter().map(|(k, v)| (k.as_str(), *v)).collect();
		let body = json!({
			"schema": SHAPE_COUNTS_SCHEMA,
			"counted_from_step": self.resume_step,
			"counted_to_step": step,
			"row_count": self.count,
			"shapes": shapes,
		});
		std::fs::write(&path, serde_json::to_string(&body)? + "\n")?;
		Ok(path)
	}

	/// Closes the stream and writes its description, which the report's `inputs` and `label_set` come from.
	pub fn finish(self, output_dir: &Path, corpus_dir: &str, label_set: &str, final_step: i64) -> Result<PathBuf> {
		let mut writer = self.encoder.finish()?;
		writer.flush()?;
		drop(writer);
		std::fs::rename(&self.staged, &self.rows_path)?;
		let name = self
			.rows_path
			.file_name()
			.and_then(|n| n.to_str())
			.ok_or_else(|| fail!("{} has no file name", self.rows_path.display()))?;
		let meta = json!({
			"schema": REALIZED_ROWS_SCHEMA,
			"rows": name,
			"row_count": self.count,
			"label_set": label_set,
			"inputs": {
				"output_dir": output_dir.display().to_string(),
				"corpus_dir": corpus_dir,
				"counted_from_step": self.resume_step.to_string(),
				"counted_to_step": final_step.to_string(),
			},
		});
		std::fs::write(&self.meta_path, serde_json::to_string_pretty(&meta)? + "\n")?;
		Ok(self.meta_path)
	}
}
