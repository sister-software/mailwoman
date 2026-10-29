// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Read the filter-accepted rows of one parquet file in shuffled order.
//!
//! The file's row groups are visited in an order shuffled with the caller's generator, and each row group's rows in
//! an order shuffled after it is read. A row is accepted when the file's row filter admits its `source_id`, its
//! source is the one the caller expects, it passes the country-weight acceptance test, and, with the coarse filter
//! on, one of its labels names an active tag. Every draw is made in the order the Python loader made it: the row
//! group order when the file is first read, the row order after each row group is read, and one acceptance draw per
//! row whose country weighs less than the heaviest country.

use crate::columns::{column, IntListColumn, StrColumn, StrListColumn};
use crate::corpus_files::RowFilter;
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

/// One read row group, held until its rows are visited.
struct RowGroup {
	index: usize,
	raw: StrColumn,
	tokens: StrListColumn,
	labels: StrListColumn,
	country: StrColumn,
	source: StrColumn,
	spans: Option<(IntListColumn, IntListColumn, StrListColumn)>,
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
	file: Option<ParquetFile>,
	has_spans: bool,
	row_groups: Vec<usize>,
	next_group: usize,
	current: Option<RowGroup>,
	started: bool,
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
			file: None,
			has_spans: false,
			row_groups: Vec::new(),
			next_group: 0,
			current: None,
			started: false,
		}
	}

	fn start(&mut self, rng: &mut PyRandom) -> Result<()> {
		let file = ParquetFile::open(&self.path)?;
		let present: Vec<&str> = SPAN_COLUMNS.iter().copied().filter(|c| file.has_column(c)).collect();
		if !present.is_empty() && present.len() != SPAN_COLUMNS.len() {
			let missing: Vec<&str> = SPAN_COLUMNS.iter().copied().filter(|c| !file.has_column(c)).collect();
			return Err(Error::Row(format!(
				"corrupt parquet file {}: carries span columns {present:?} but is missing {missing:?} — the #519 \
				 triple is all-or-none per file",
				self.path.display()
			)));
		}
		self.has_spans = !present.is_empty();
		self.row_groups = (0..file.num_row_groups()).collect();
		rng.shuffle(&mut self.row_groups);
		self.file = Some(file);
		Ok(())
	}

	fn read_group(&mut self, index: usize, rng: &mut PyRandom) -> Result<RowGroup> {
		let file = self.file.as_ref().expect("started");
		let mut columns: Vec<&str> = REQUIRED_COLUMNS.to_vec();
		if self.has_spans {
			columns.extend(SPAN_COLUMNS);
		}
		if self.row_filter.is_some() {
			columns.push("source_id");
		}
		let batch = file.read_row_group(index, &columns)?;
		let path = &self.path;
		let get = |name: &str| column(&batch, name, path);
		let admitted = match &self.row_filter {
			Some(filter) => {
				let ids = StrColumn::new(get("source_id")?, "source_id")?;
				Some((0..ids.len()).map(|i| filter.admits(ids.get(i))).collect())
			}
			None => None,
		};
		let spans = if self.has_spans {
			Some((
				IntListColumn::new(get("span_starts")?, "span_starts")?,
				IntListColumn::new(get("span_ends")?, "span_ends")?,
				StrListColumn::new(get("span_tags")?, "span_tags")?,
			))
		} else {
			None
		};
		let mut order: Vec<usize> = (0..batch.num_rows()).collect();
		rng.shuffle(&mut order);
		Ok(RowGroup {
			index,
			raw: StrColumn::new(get("raw")?, "raw")?,
			tokens: StrListColumn::new(get("tokens")?, "tokens")?,
			labels: StrListColumn::new(get("labels")?, "labels")?,
			country: StrColumn::new(get("country")?, "country")?,
			source: StrColumn::new(get("source")?, "source")?,
			spans,
			admitted,
			order,
			position: 0,
			taken: 0,
		})
	}

	/// The next accepted row, or `None` once the file is exhausted.
	pub fn next(&mut self, rng: &mut PyRandom, shared: &Shared) -> Result<Option<Row>> {
		if !self.started {
			self.started = true;
			self.start(rng)?;
		}
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
				rng,
				shared,
			)?;
			match row {
				Some(row) => return Ok(Some(row)),
				None => self.current = None,
			}
		}
	}

	fn next_in_group(
		group: &mut RowGroup,
		path: &std::path::Path,
		expected_source: Option<&str>,
		row_group_limit: Option<usize>,
		rng: &mut PyRandom,
		shared: &Shared,
	) -> Result<Option<Row>> {
		while group.position < group.order.len() {
			if row_group_limit.is_some_and(|limit| group.taken >= limit) {
				return Ok(None);
			}
			let i = group.order[group.position];
			group.position += 1;
			if let Some(admitted) = &group.admitted {
				if !admitted[i] {
					continue;
				}
			}
			let source = group.source.get(i);
			if let Some(expected) = expected_source {
				if source != Some(expected) {
					continue;
				}
			}
			let country = group.country.get(i);
			let Some(weight) = country.and_then(|c| shared.country_weights.get(c)).filter(|&w| w > 0.0) else {
				continue;
			};
			if weight < shared.max_country_weight && rng.random() > weight / shared.max_country_weight {
				continue;
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
				spans,
			}));
		}
		Ok(None)
	}
}
