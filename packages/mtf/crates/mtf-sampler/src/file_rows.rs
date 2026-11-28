// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Read the filter-accepted rows of one parquet file in shuffled order.
//!
//! The file's row groups are visited in an order shuffled with the caller's generator, and each row group's rows in
//! an order shuffled after it is read. A row is accepted when the file's row filter admits its `source_id`, its
//! source is the one the caller expects, it passes the country-weight acceptance test, and, with the coarse filter
//! on, one of its labels names an active tag. Every draw is made in the order the Python loader made it: the row
//! group order when the file is first read, the row order after each row group is read, and one acceptance draw per
//! row whose country weighs less than the heaviest country.
//!
//! [`RowGroupVisit`] reads one row group for a source the epoch reads in part: a few rows per visit, in an order
//! the group's own seed fixes, so the pass that visits it again continues where the last visit stopped.
//!
//! [`FileRows::stored`] reads a file in stored order and draws nothing: row groups ascending, each group's rows as
//! stored, and a row of a positively weighted country accepted without the acceptance draw.
//!
//! A train read of a source whose files store [`DRAW_WEIGHT_COLUMN`] multiplies each row's weight into the same
//! acceptance draw: a row is accepted with probability `(country weight / heaviest country weight) × (draw weight /
//! bound)`, where the bound is the largest draw weight among the source's files ([`DrawWeights`]). A file of that
//! source without the column reads 1.0 for every row. The mixture picks the source before the source yields a row,
//! so the acceptance moves draws between the source's rows and leaves the source's share of the run unchanged: over
//! the passes a run makes, a row's expected draws are the source's draws per row times its draw weight over the
//! source's mean draw weight. A read without a bound, a held-out read, and a stored-order read ignore the column.

use crate::columns::{column, F64Column, IntListColumn, StrColumn, StrListColumn};
use crate::corpus_files::{CorpusFile, RowFilter};
use crate::error::{quote, Error, Result};
use crate::parquet_file::ParquetFile;
use crate::pyrandom::PyRandom;
use crate::row::{Row, SpanTriple};
use crate::sampler::Shared;
use std::path::PathBuf;
use std::sync::Arc;

/// The columns every corpus file stores.
pub const REQUIRED_COLUMNS: [&str; 5] = ["raw", "tokens", "labels", "country", "source"];

/// The char-offset label columns: a file stores all three or none.
pub const SPAN_COLUMNS: [&str; 3] = ["span_starts", "span_ends", "span_tags"];

/// The optional per-row draw weight: a positive, finite float that scales a row's chance of being drawn within its
/// source.
pub const DRAW_WEIGHT_COLUMN: &str = "draw_weight";

/// The bound a source's draw weights are divided by, so each row's acceptance stays a probability.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawWeights {
	/// The largest draw weight among the source's files, and 1.0 when one of them stores no column.
	pub bound: f64,
}

impl DrawWeights {
	/// The bound over `files`, or `None` when none of them stores [`DRAW_WEIGHT_COLUMN`], so the read draws exactly as
	/// it does for a corpus without the column.
	///
	/// Refuses a null, non-finite or non-positive weight, because a row that can never be drawn would leave the source
	/// without a trace, and a row whose weight is unreadable has no defined chance.
	pub fn of_files(files: &[CorpusFile]) -> Result<Option<Self>> {
		let mut bound: Option<f64> = None;
		let mut unweighted = false;
		for file in files {
			let parquet = ParquetFile::open(&file.path)?;
			if !parquet.has_column(DRAW_WEIGHT_COLUMN) {
				unweighted = true;
				continue;
			}
			for batch in parquet.batches(&[DRAW_WEIGHT_COLUMN], 65_536)? {
				let batch = batch?;
				let weights = F64Column::new(column(&batch, DRAW_WEIGHT_COLUMN, &file.path)?, DRAW_WEIGHT_COLUMN)?;
				for i in 0..weights.len() {
					let weight = draw_weight_at(&weights, i, &file.path)?;
					bound = Some(bound.map_or(weight, |b: f64| b.max(weight)));
				}
			}
		}
		Ok(bound.map(|b| Self {
			bound: if unweighted { b.max(1.0) } else { b },
		}))
	}
}

/// The draw weight of row `i`, refusing a value that is null, non-finite or not positive.
fn draw_weight_at(weights: &F64Column, i: usize, path: &std::path::Path) -> Result<f64> {
	match weights.get(i) {
		Some(weight) if weight.is_finite() && weight > 0.0 => Ok(weight),
		found => Err(Error::Row(format!(
			"{}: a {DRAW_WEIGHT_COLUMN} value is {found:?}, and a draw weight must be a positive finite number",
			path.display()
		))),
	}
}

/// The draw weights one row group's acceptance test reads.
struct GroupDrawWeights {
	/// `None` for a file without the column, whose rows read 1.0.
	column: Option<F64Column>,
	bound: f64,
}

/// The rows of the expected source a read passed over, by the check that refused them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RowDrops {
	/// Refused by the file's row filter: a held-out id of its split attribute, or a manifest deletion.
	pub filtered: u64,
	/// The row's country is absent from `country_weights` or weighs zero.
	pub country: u64,
	/// The coarse filter found no active tag among the row's labels.
	pub coarse: u64,
}

impl RowDrops {
	pub fn add(&mut self, other: RowDrops) {
		self.filtered += other.filtered;
		self.country += other.country;
		self.coarse += other.coarse;
	}
}

/// One read row group, held until its rows are visited.
struct RowGroup {
	index: usize,
	raw: StrColumn,
	tokens: StrListColumn,
	labels: StrListColumn,
	country: StrColumn,
	source: StrColumn,
	/// Present when the file stores `source_id`, so a consumed row keeps its stable identity for the exposure record.
	source_id: Option<StrColumn>,
	spans: Option<(IntListColumn, IntListColumn, StrListColumn)>,
	/// Present when the read applies draw weights.
	draw_weights: Option<GroupDrawWeights>,
	admitted: Option<Vec<bool>>,
	order: Vec<usize>,
	position: usize,
	taken: usize,
}

/// The rows of one file, as `_file_row_iter` yielded them.
pub struct FileRows {
	path: PathBuf,
	expected_source: Option<Arc<str>>,
	row_filter: Option<Arc<RowFilter>>,
	row_group_limit: Option<usize>,
	draw_weights: Option<DrawWeights>,
	file: Option<ParquetFile>,
	has_spans: bool,
	row_groups: Vec<usize>,
	next_group: usize,
	current: Option<RowGroup>,
	start: StartState,
	/// Read in stored order with no generator draw, rather than in shuffled order.
	stored_order: bool,
	drops: RowDrops,
}

/// Whether a lazily started reader has opened its input.
///
/// A failed start is terminal and keeps its error. A start draws from the caller's generator, so trying again would
/// draw a second time and move every later draw.
#[derive(Debug, Clone, PartialEq)]
pub enum StartState {
	Pending,
	Started,
	Failed(Error),
}

impl StartState {
	/// Run `start` on the first call, and answer the recorded outcome on every later one.
	pub fn ensure(&mut self, start: impl FnOnce() -> Result<()>) -> Result<()> {
		match self {
			StartState::Started => Ok(()),
			StartState::Failed(error) => Err(error.clone()),
			StartState::Pending => match start() {
				Ok(()) => {
					*self = StartState::Started;
					Ok(())
				}
				Err(error) => {
					*self = StartState::Failed(error.clone());
					Err(error)
				}
			},
		}
	}
}

/// Whether a file stores the span triple, refusing a file that stores part of it.
fn span_schema(file: &ParquetFile, path: &std::path::Path) -> Result<bool> {
	let present: Vec<&str> = SPAN_COLUMNS.iter().copied().filter(|c| file.has_column(c)).collect();
	if !present.is_empty() && present.len() != SPAN_COLUMNS.len() {
		let missing: Vec<&str> = SPAN_COLUMNS.iter().copied().filter(|c| !file.has_column(c)).collect();
		return Err(Error::Row(format!(
			"corrupt parquet file {}: carries span columns {present:?} but is missing {missing:?} — the #519 \
			 triple is all-or-none per file",
			path.display()
		)));
	}
	Ok(!present.is_empty())
}

/// Reads one row group, with its row order shuffled by `shuffle` once the group is read.
fn read_row_group(
	file: &ParquetFile,
	path: &std::path::Path,
	has_spans: bool,
	row_filter: Option<&RowFilter>,
	draw_weights: Option<DrawWeights>,
	index: usize,
	shuffle: impl FnOnce(&mut [usize]),
) -> Result<RowGroup> {
	let mut columns: Vec<&str> = REQUIRED_COLUMNS.to_vec();
	if has_spans {
		columns.extend(SPAN_COLUMNS);
	}
	let has_source_id = row_filter.is_some() || file.has_column("source_id");
	if has_source_id {
		columns.push("source_id");
	}
	let has_draw_weight = draw_weights.is_some() && file.has_column(DRAW_WEIGHT_COLUMN);
	if has_draw_weight {
		columns.push(DRAW_WEIGHT_COLUMN);
	}
	let batch = file.read_row_group(index, &columns)?;
	let get = |name: &str| column(&batch, name, path);
	let source_id = if has_source_id {
		Some(StrColumn::new(get("source_id")?, "source_id")?)
	} else {
		None
	};
	let admitted = match (row_filter, &source_id) {
		(Some(filter), Some(ids)) => Some((0..ids.len()).map(|i| filter.admits(ids.get(i))).collect()),
		_ => None,
	};
	let spans = if has_spans {
		Some((
			IntListColumn::new(get("span_starts")?, "span_starts")?,
			IntListColumn::new(get("span_ends")?, "span_ends")?,
			StrListColumn::new(get("span_tags")?, "span_tags")?,
		))
	} else {
		None
	};
	let draw_weights = match draw_weights {
		None => None,
		Some(DrawWeights { bound }) => Some(GroupDrawWeights {
			column: if has_draw_weight {
				Some(F64Column::new(get(DRAW_WEIGHT_COLUMN)?, DRAW_WEIGHT_COLUMN)?)
			} else {
				None
			},
			bound,
		}),
	};
	let mut order: Vec<usize> = (0..batch.num_rows()).collect();
	shuffle(&mut order);
	Ok(RowGroup {
		index,
		raw: StrColumn::new(get("raw")?, "raw")?,
		tokens: StrListColumn::new(get("tokens")?, "tokens")?,
		labels: StrListColumn::new(get("labels")?, "labels")?,
		country: StrColumn::new(get("country")?, "country")?,
		source: StrColumn::new(get("source")?, "source")?,
		source_id,
		spans,
		draw_weights,
		admitted,
		order,
		position: 0,
		taken: 0,
	})
}

/// One visit to a row group that a spread pass reads a few rows at a time.
///
/// The group's row order comes from its own generator, seeded by the pass, so every visit to the group rebuilds the
/// same order and continues from where the previous visit stopped. A pass therefore reads each row once while holding
/// no more than one decoded row group.
pub struct RowGroupVisit {
	path: PathBuf,
	expected_source: Arc<str>,
	group: RowGroup,
	limit: usize,
	drops: RowDrops,
}

impl RowGroupVisit {
	/// Reads row group `index` of `path`, positioned at `position` of the order `order_seed` shuffles, to yield at
	/// most `limit` accepted rows.
	///
	/// The shuffled order starts `rotation` rows in and wraps, so a pass still reads each row once.
	#[allow(clippy::too_many_arguments)]
	pub fn open(
		path: PathBuf,
		expected_source: Arc<str>,
		row_filter: Option<&RowFilter>,
		draw_weights: Option<DrawWeights>,
		index: usize,
		order_seed: i128,
		rotation: usize,
		position: usize,
		limit: usize,
	) -> Result<Self> {
		let file = ParquetFile::open(&path)?;
		let has_spans = span_schema(&file, &path)?;
		let mut group = read_row_group(&file, &path, has_spans, row_filter, draw_weights, index, |order| {
			PyRandom::new(crate::pyrandom::Seed::Int(order_seed)).shuffle(order);
			if !order.is_empty() {
				order.rotate_left(rotation % order.len());
			}
		})?;
		group.position = position.min(group.order.len());
		Ok(Self {
			path,
			expected_source,
			group,
			limit,
			drops: RowDrops::default(),
		})
	}

	/// The next accepted row, or `None` once the visit took its limit or the group is exhausted.
	pub fn next(&mut self, rng: &mut PyRandom, shared: &Shared) -> Result<Option<Row>> {
		FileRows::next_in_group(
			&mut self.group,
			&self.path,
			Some(&*self.expected_source),
			Some(self.limit),
			Some(rng),
			shared,
			&mut self.drops,
		)
	}

	/// How far into the group's order the visit has read.
	pub fn position(&self) -> usize {
		self.group.position
	}

	/// Whether the visit has read every row of the group.
	pub fn exhausted(&self) -> bool {
		self.group.position >= self.group.order.len()
	}
}

impl FileRows {
	pub fn new(
		path: PathBuf,
		expected_source: Option<Arc<str>>,
		row_filter: Option<Arc<RowFilter>>,
		row_group_limit: Option<usize>,
	) -> Self {
		Self {
			path,
			expected_source,
			row_filter,
			row_group_limit,
			draw_weights: None,
			file: None,
			has_spans: false,
			row_groups: Vec::new(),
			next_group: 0,
			current: None,
			start: StartState::Pending,
			stored_order: false,
			drops: RowDrops::default(),
		}
	}

	/// The accepted rows of `source` in `path`, in stored order, drawing nothing from the generator.
	pub fn stored(path: PathBuf, source: Arc<str>, row_filter: Option<Arc<RowFilter>>) -> Self {
		Self {
			stored_order: true,
			..Self::new(path, Some(source), row_filter, None)
		}
	}

	/// The same read, with each row's draw weight over `draw_weights.bound` multiplied into its acceptance draw.
	pub fn with_draw_weights(self, draw_weights: Option<DrawWeights>) -> Self {
		Self { draw_weights, ..self }
	}

	/// The rows of the expected source this read has passed over so far.
	pub fn drops(&self) -> RowDrops {
		self.drops
	}

	fn open(&mut self, rng: &mut PyRandom) -> Result<()> {
		let file = ParquetFile::open(&self.path)?;
		self.has_spans = span_schema(&file, &self.path)?;
		self.row_groups = (0..file.num_row_groups()).collect();
		if !self.stored_order {
			rng.shuffle(&mut self.row_groups);
		}
		self.file = Some(file);
		Ok(())
	}

	fn read_group(&mut self, index: usize, rng: &mut PyRandom) -> Result<RowGroup> {
		let file = self.file.as_ref().expect("started");
		let stored_order = self.stored_order;
		read_row_group(
			file,
			&self.path,
			self.has_spans,
			self.row_filter.as_deref(),
			// A stored-order read draws nothing, so it has no acceptance draw to scale.
			self.draw_weights.filter(|_| !stored_order),
			index,
			|order| {
				if !stored_order {
					rng.shuffle(order);
				}
			},
		)
	}

	/// The next accepted row, or `None` once the file is exhausted.
	pub fn next(&mut self, rng: &mut PyRandom, shared: &Shared) -> Result<Option<Row>> {
		let mut start = std::mem::replace(&mut self.start, StartState::Pending);
		let started = start.ensure(|| self.open(rng));
		self.start = start;
		started?;
		loop {
			shared.check_cancelled()?;
			if self.current.is_none() {
				if self.next_group >= self.row_groups.len() {
					return Ok(None);
				}
				let index = self.row_groups[self.next_group];
				self.next_group += 1;
				self.current = Some(self.read_group(index, rng)?);
			}
			let group = self.current.as_mut().expect("read above");
			let row = Self::next_in_group(
				group,
				&self.path,
				self.expected_source.as_deref(),
				self.row_group_limit,
				(!self.stored_order).then_some(&mut *rng),
				shared,
				&mut self.drops,
			)?;
			match row {
				Some(row) => return Ok(Some(row)),
				None => self.current = None,
			}
		}
	}

	/// The next accepted row of `group`. `rng` draws the country acceptance test; `None` accepts every row of a
	/// positively weighted country, as a stored-order read does.
	fn next_in_group(
		group: &mut RowGroup,
		path: &std::path::Path,
		expected_source: Option<&str>,
		row_group_limit: Option<usize>,
		mut rng: Option<&mut PyRandom>,
		shared: &Shared,
		drops: &mut RowDrops,
	) -> Result<Option<Row>> {
		while group.position < group.order.len() {
			if row_group_limit.is_some_and(|limit| group.taken >= limit) {
				return Ok(None);
			}
			let i = group.order[group.position];
			group.position += 1;
			let source = group.source.get(i);
			if let Some(expected) = expected_source {
				if source != Some(expected) {
					continue;
				}
			}
			if let Some(admitted) = &group.admitted {
				if !admitted[i] {
					drops.filtered += 1;
					continue;
				}
			}
			let country = group.country.get(i);
			let Some(weight) = country.and_then(|c| shared.country_weights.get(c)).filter(|&w| w > 0.0) else {
				drops.country += 1;
				continue;
			};
			if let Some(rng) = rng.as_deref_mut() {
				match &group.draw_weights {
					None => {
						if weight < shared.max_country_weight && rng.random() > weight / shared.max_country_weight {
							continue;
						}
					}
					Some(draw) => {
						let row_weight = match &draw.column {
							Some(column) => draw_weight_at(column, i, path)?,
							None => 1.0,
						};
						let accept = weight / shared.max_country_weight * (row_weight / draw.bound);
						if accept < 1.0 && rng.random() > accept {
							continue;
						}
					}
				}
			}
			let at = |what: &str| {
				Error::Row(format!(
					"{} (row group {}, row {i}): {what}",
					path.display(),
					group.index
				))
			};
			let labels = group.labels.get(i)?.ok_or_else(|| at("null labels"))?;
			if shared.coarse_filter && !shared.active_components_present(&labels) {
				drops.coarse += 1;
				continue;
			}
			let raw = group.raw.get(i).ok_or_else(|| at("null raw"))?.to_owned();
			let tokens = group.tokens.get(i)?.ok_or_else(|| at("null tokens"))?;
			let source = source.ok_or_else(|| at("null source"))?.to_owned();
			let spans = match &group.spans {
				None => None,
				Some((starts, ends, tags)) => {
					let (s, e, t) = (starts.get(i)?, ends.get(i)?, tags.get(i)?);
					let nulls: Vec<&str> = [
						("span_starts", s.is_none()),
						("span_ends", e.is_none()),
						("span_tags", t.is_none()),
					]
					.into_iter()
					.filter_map(|(name, null)| null.then_some(name))
					.collect();
					if !nulls.is_empty() {
						return Err(Error::Row(format!(
							"corrupt row in {} (row-group {}, raw={}): null span column(s) {nulls:?} in a \
							 span-schema file — never a silent fallback to token labels",
							path.display(),
							group.index,
							quote(&raw)
						)));
					}
					let (starts, ends, tags) = (s.expect("checked"), e.expect("checked"), t.expect("checked"));
					// A writer that projects rows without the span triple emits `[]` for all three; those pass the
					// null check and would train as all-`O`.
					if starts.is_empty() && ends.is_empty() && tags.is_empty() && labels.iter().any(|l| l != "O") {
						return Err(Error::Row(format!(
							"corrupt row in {} (row-group {}, raw={}): every span column is EMPTY while the BIO \
							 labels carry a tag — the file declares the span triple and its writer did not \
							 populate it, so this row would train as all-O",
							path.display(),
							group.index,
							quote(&raw)
						)));
					}
					Some(SpanTriple { starts, ends, tags })
				}
			};
			group.taken += 1;
			return Ok(Some(Row {
				raw,
				tokens,
				labels,
				country: country.map(str::to_owned),
				source,
				source_id: group.source_id.as_ref().and_then(|ids| ids.get(i)).map(str::to_owned),
				spans,
			}));
		}
		Ok(None)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::config::Weights;
	use crate::pyrandom::Seed;
	use crate::sampler::CancelToken;

	#[test]
	fn a_file_whose_start_failed_fails_again_rather_than_reading_as_exhausted() {
		let shared = Shared {
			country_weights: Weights(vec![("US".into(), 1.0)]),
			max_country_weight: 1.0,
			coarse_filter: false,
			active_tags: Default::default(),
			source_weights: None,
			epoch_cursor: None,
			cancel: CancelToken::default(),
			observer: None,
		};
		let mut rows = FileRows::new("/nonexistent/train/part-a.parquet".into(), None, None, None);
		let mut rng = PyRandom::new(Seed::Int(7));
		let first = rows.next(&mut rng, &shared).unwrap_err();
		let second = rows.next(&mut rng, &shared).unwrap_err();
		assert_eq!(first, second);
	}
}
