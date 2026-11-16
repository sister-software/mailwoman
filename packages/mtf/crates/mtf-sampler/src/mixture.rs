// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Sample across sources so the observed mix matches `source_weights`, or stream a held-out split's files.
//!
//! The train mixture is stationary for the whole epoch: each row draws its source from a multinomial over the
//! weights, and an exhausted source restarts with a fresh shuffled pass rather than leaving the mixture. The epoch
//! ends once every source has completed at least one full pass.
//!
//! A row-limited epoch reads most sources only in part, and a pass read file by file would draw that part from one
//! row group. A source expected to draw fewer rows than it holds therefore spreads its pass: its row groups are
//! shuffled across all its files, and each visit takes `⌈fraction × group rows⌉` rows from one group before the next
//! group is visited, with the fraction raised so the source's largest group gives at least `MIN_VISIT_ROWS`. One sweep over the groups covers the epoch's expected draws, so each group
//! contributes about its share. A pass still reads each row once, so the source's restart and its zero-row refusal
//! keep their meaning. A held-out split has no mixture to steer, so its
//! files stream one after another in shuffled order, or, with a row limit, each contributes rows in proportion to
//! its size.

use crate::corpus_files::{file_source_counts, files_source_counts, CorpusFile};
use crate::error::{Error, Result};
use crate::file_rows::{FileRows, RowGroupVisit, StartState};
use crate::parquet_file::ParquetFile;
use crate::pyrandom::PyRandom;
use crate::row::Row;
use crate::sampler::{Event, Shared};
use std::sync::Arc;

/// The fewest accepted rows a spread pass takes per visit from a source's largest row group.
///
/// Each visit decodes a whole row group, so this floor caps a spread source's decoded rows per drawn row at the
/// largest group's size over it: about 195 for 50,000-row groups. It raises the fraction taken from every group of
/// the source alike, so the groups stay in proportion. A source whose fraction already takes more visits every
/// group once per epoch.
pub const MIN_VISIT_ROWS: usize = 256;

/// One row group of a spread pass: where it is, how many rows a visit takes, and how far the pass has read it.
struct Unit {
	file: usize,
	group: usize,
	take: usize,
	position: usize,
	exhausted: bool,
}

/// How a source's pass reads its rows.
enum Plan {
	/// File by file and, within a file, row group by row group, each in shuffled order: the read of a source the
	/// epoch reads in full, or of an epoch with no row limit.
	Sequential {
		order: Vec<usize>,
		position: usize,
		current: Option<FileRows>,
	},
	/// Every row group of every file in one shuffled order, visited in sweeps that take a few rows from each, so an
	/// epoch that reads part of the source draws from its row groups in proportion to their size.
	Spread {
		units: Vec<Unit>,
		next: usize,
		live: usize,
		seed: i128,
		current: Option<(usize, RowGroupVisit)>,
	},
}

/// One source's files, read in a shuffled order.
struct SourceRows {
	source: Arc<str>,
	files: Arc<Vec<CorpusFile>>,
	/// The share of the source's rows one epoch is expected to draw, when below 1.
	fraction: Option<f64>,
	plan: Option<Plan>,
}

impl SourceRows {
	fn new(source: Arc<str>, files: Arc<Vec<CorpusFile>>, fraction: Option<f64>) -> Self {
		Self {
			source,
			files,
			fraction,
			plan: None,
		}
	}

	/// The pass's plan, drawn on the source's first row: the file order, or the row-group order and the pass seed.
	fn start(&self, rng: &mut PyRandom) -> Result<Plan> {
		let Some(fraction) = self.fraction else {
			let mut order: Vec<usize> = (0..self.files.len()).collect();
			rng.shuffle(&mut order);
			return Ok(Plan::Sequential {
				order,
				position: 0,
				current: None,
			});
		};
		let mut units = Vec::new();
		let mut sizes = Vec::new();
		for (index, file) in self.files.iter().enumerate() {
			let parquet = ParquetFile::open(&file.path)?;
			for group in 0..parquet.num_row_groups() {
				sizes.push(parquet.row_group_rows(group));
				units.push(Unit {
					file: index,
					group,
					take: 0,
					position: 0,
					exhausted: false,
				});
			}
		}
		// The floor raises the fraction for the whole source, so a short group, such as a file's last, is still
		// visited in proportion to its size.
		let largest = sizes.iter().copied().max().unwrap_or(0).max(1);
		let fraction = fraction.max(MIN_VISIT_ROWS as f64 / largest as f64).min(1.0);
		for (unit, &rows) in units.iter_mut().zip(&sizes) {
			unit.take = ((fraction * rows as f64).ceil() as usize).max(1);
		}
		rng.shuffle(&mut units);
		let seed = rng.getrandbits(64) as i128;
		Ok(Plan::Spread {
			live: units.len(),
			units,
			next: 0,
			seed,
			current: None,
		})
	}

	fn next(&mut self, rng: &mut PyRandom, shared: &Shared) -> Result<Option<Row>> {
		if self.plan.is_none() {
			self.plan = Some(self.start(rng)?);
		}
		match self.plan.as_mut().expect("started above") {
			Plan::Sequential {
				order,
				position,
				current,
			} => Self::next_sequential(&self.source, &self.files, order, position, current, rng, shared),
			Plan::Spread {
				units,
				next,
				live,
				seed,
				current,
			} => Self::next_spread(&self.source, &self.files, units, next, live, *seed, current, rng, shared),
		}
	}

	#[allow(clippy::too_many_arguments)]
	fn next_spread(
		source: &Arc<str>,
		files: &[CorpusFile],
		units: &mut [Unit],
		next: &mut usize,
		live: &mut usize,
		seed: i128,
		current: &mut Option<(usize, RowGroupVisit)>,
		rng: &mut PyRandom,
		shared: &Shared,
	) -> Result<Option<Row>> {
		loop {
			if current.is_none() {
				if *live == 0 {
					return Ok(None);
				}
				shared.check_cancelled()?;
				let at = *next;
				*next = (at + 1) % units.len();
				let unit = &units[at];
				if unit.exhausted {
					continue;
				}
				let file = &files[unit.file];
				// Distinct units of one pass seed distinct generators, so each group's order is its own.
				let order_seed = (seed << 32) | at as i128;
				*current = Some((
					at,
					RowGroupVisit::open(
						file.path.clone(),
						source.clone(),
						file.filter.as_deref(),
						unit.group,
						order_seed,
						unit.position,
						unit.take,
					)?,
				));
			}
			let (at, visit) = current.as_mut().expect("set above");
			if let Some(row) = visit.next(rng, shared)? {
				return Ok(Some(row));
			}
			let unit = &mut units[*at];
			unit.position = visit.position();
			if visit.exhausted() {
				unit.exhausted = true;
				*live -= 1;
			}
			*current = None;
		}
	}

	fn next_sequential(
		source: &Arc<str>,
		files: &[CorpusFile],
		order: &[usize],
		position: &mut usize,
		current: &mut Option<FileRows>,
		rng: &mut PyRandom,
		shared: &Shared,
	) -> Result<Option<Row>> {
		loop {
			if current.is_none() {
				if *position >= order.len() {
					return Ok(None);
				}
				let file = &files[order[*position]];
				*position += 1;
				*current = Some(FileRows::new(
					file.path.clone(),
					Some(source.clone()),
					file.filter.clone(),
					None,
				));
			}
			match current.as_mut().expect("set above").next(rng, shared)? {
				Some(row) => return Ok(Some(row)),
				None => *current = None,
			}
		}
	}
}

/// The source multinomial over one epoch.
pub struct Mixture {
	sources: Vec<SourceRows>,
	cumulative: Vec<f64>,
	total: f64,
	passes: Vec<u64>,
	pass_rows: Vec<u64>,
	realized: Vec<u64>,
	done: bool,
}

impl Mixture {
	/// Indexes the split's files by source and applies the configured weights.
	///
	/// `epoch_rows`, the epoch's row limit, sets each source's expected draws: `epoch_rows × weight / total`. A source
	/// expected to draw fewer rows than it holds reads its pass spread over its row groups; every other source, and
	/// every source of an epoch with no limit, reads its pass file by file.
	pub fn open(files: Vec<CorpusFile>, shared: &Shared, epoch_rows: Option<u64>) -> Result<Self> {
		let mut by_source: Vec<(String, Vec<CorpusFile>)> = Vec::new();
		let mut source_rows: Vec<(String, u64)> = Vec::new();
		for (file, counted) in files.iter().zip(files_source_counts(&files)) {
			let counted =
				counted.map_err(|e| Error::Input(format!("cannot index {} by source: {e}", file.path.display())))?;
			for (source, rows) in counted {
				match source_rows.iter_mut().find(|(s, _)| *s == source) {
					Some((_, total)) => *total += rows,
					None => source_rows.push((source.clone(), rows)),
				}
				match by_source.iter_mut().find(|(s, _)| *s == source) {
					Some((_, listed)) => listed.push(file.clone()),
					None => by_source.push((source, vec![file.clone()])),
				}
			}
		}
		let weights = match &shared.source_weights {
			None => by_source.iter().map(|_| 1.0).collect::<Vec<f64>>(),
			Some(configured) => {
				let mut missing: Vec<&str> = configured
					.0
					.iter()
					.filter(|(s, w)| *w > 0.0 && !by_source.iter().any(|(b, _)| b == s))
					.map(|(s, _)| s.as_str())
					.collect();
				missing.sort_unstable();
				if !missing.is_empty() {
					return Err(Error::Input(format!(
						"positive source_weights entries have no parquet files in the 'train' split: {missing:?}. \
						 Remove the stale weights or rebuild the corpus with those sources."
					)));
				}
				let mut unnamed: Vec<&(String, Vec<CorpusFile>)> =
					by_source.iter().filter(|(s, _)| !configured.contains(s)).collect();
				unnamed.sort_by(|a, b| a.0.cmp(&b.0));
				if !unnamed.is_empty() {
					let detail = unnamed
						.iter()
						.map(|(s, f)| format!("{s} ({} parquet files)", f.len()))
						.collect::<Vec<_>>()
						.join(", ");
					return Err(Error::Input(format!(
						"{} source(s) in the 'train' split are absent from source_weights and would be dropped \
						 without a trace: {detail}. Name each one — give it a weight to train on it, or 0.0 to \
						 decline it deliberately. Check for a superseded generation still holding the weight (a \
						 `-vNN` sibling of the same name).",
						unnamed.len()
					)));
				}
				by_source.retain(|(s, _)| configured.get(s).unwrap_or(0.0) > 0.0);
				if by_source.is_empty() {
					return Err(Error::Input(
						"no parquet files remain after applying source_weights — every file's source is missing \
						 from or zero-weighted in source_weights"
							.into(),
					));
				}
				by_source
					.iter()
					.map(|(s, _)| configured.get(s).expect("named above"))
					.collect()
			}
		};
		let mut cumulative = Vec::with_capacity(weights.len());
		let mut total = 0.0f64;
		for w in &weights {
			total += w;
			cumulative.push(total);
		}
		let n = by_source.len();
		let fraction = |source: &str, weight: f64| -> Option<f64> {
			let limit = epoch_rows? as f64;
			let rows = source_rows.iter().find(|(s, _)| s == source).map(|&(_, n)| n)?;
			let share = limit * weight / total / rows as f64;
			(rows > 0 && share < 1.0).then_some(share)
		};
		Ok(Self {
			sources: by_source
				.into_iter()
				.zip(&weights)
				.map(|((s, f), &w)| {
					let share = fraction(&s, w);
					SourceRows::new(Arc::from(s.as_str()), Arc::new(f), share)
				})
				.collect(),
			cumulative,
			total,
			passes: vec![0; n],
			pass_rows: vec![0; n],
			realized: vec![0; n],
			done: false,
		})
	}

	/// The sources in mixture order with their realized draws so far.
	pub fn realized(&self) -> Vec<(String, u64)> {
		self.sources
			.iter()
			.zip(&self.realized)
			.map(|(s, &n)| (s.source.to_string(), n))
			.collect()
	}

	pub fn next(&mut self, rng: &mut PyRandom, shared: &mut Shared) -> Result<Option<Row>> {
		if self.done {
			return Ok(None);
		}
		let r = rng.random() * self.total;
		let chosen = self
			.cumulative
			.iter()
			.position(|&c| r < c)
			.unwrap_or(self.sources.len() - 1);
		let row = match self.sources[chosen].next(rng, shared)? {
			Some(row) => row,
			None => {
				let source = self.sources[chosen].source.to_string();
				if self.pass_rows[chosen] == 0 {
					return Err(Error::Input(format!(
						"source {source:?} has a positive weight but yielded zero selectable rows in a full pass \
						 (country_weights / coarse_filter admit nothing) — fix the recipe or the corpus; a silent drop \
						 would change the training mixture"
					)));
				}
				self.passes[chosen] += 1;
				if self.passes.iter().all(|&p| p >= 1) {
					self.done = true;
					shared.emit(Event::EpochComplete {
						realized: self.realized(),
					});
					return Ok(None);
				}
				shared.emit(Event::SourceRestarted {
					source: source.clone(),
					passes: self.passes[chosen],
				});
				self.pass_rows[chosen] = 0;
				let (files, fraction) = (self.sources[chosen].files.clone(), self.sources[chosen].fraction);
				self.sources[chosen] = SourceRows::new(Arc::from(source.as_str()), files, fraction);
				self.sources[chosen].next(rng, shared)?.ok_or_else(|| {
					Error::Input(format!(
						"source {source:?} yielded rows in an earlier pass and none in its restarted pass"
					))
				})?
			}
		};
		self.pass_rows[chosen] += 1;
		self.realized[chosen] += 1;
		Ok(Some(row))
	}
}

/// A held-out split's files streamed one after another in shuffled order, without source bucketing.
///
/// A mixed-source validation file loses its later sources' rows when the sampler buckets a file by its first row, so
/// a held-out split reads every source of every file. With a row limit, each file contributes about
/// `row_limit × rows / split rows` rows, spread over its row groups.
pub struct HeldOut {
	files: Vec<CorpusFile>,
	row_limit: Option<usize>,
	split: String,
	start: StartState,
	quotas: Vec<Option<usize>>,
	next_file: usize,
	current: Option<(FileRows, Option<usize>)>,
}

impl HeldOut {
	pub fn new(files: Vec<CorpusFile>, split: &str, row_limit: Option<usize>) -> Self {
		Self {
			files,
			row_limit,
			split: split.to_owned(),
			start: StartState::Pending,
			quotas: Vec::new(),
			next_file: 0,
			current: None,
		}
	}

	/// The rows of one file the split reads: the footer count, or the filtered count for a filtered file.
	fn split_rows(file: &CorpusFile) -> Result<u64> {
		match &file.filter {
			None => Ok(ParquetFile::open(&file.path)?.num_rows() as u64),
			Some(_) => Ok(file_source_counts(file)?.iter().map(|(_, n)| n).sum()),
		}
	}

	fn plan(&mut self, rng: &mut PyRandom) -> Result<()> {
		rng.shuffle(&mut self.files);
		self.quotas = match self.row_limit {
			None => vec![None; self.files.len()],
			Some(limit) => {
				// Count the filtered files four at a time; `split_rows` then reads the cached counts.
				let filtered: Vec<CorpusFile> = self.files.iter().filter(|f| f.filter.is_some()).cloned().collect();
				files_source_counts(&filtered);
				let rows = self.files.iter().map(Self::split_rows).collect::<Result<Vec<u64>>>()?;
				let total: u64 = rows.iter().sum();
				if total == 0 {
					vec![Some(0); self.files.len()]
				} else {
					rows.iter()
						.map(|&n| {
							let share = (limit as u64 * n) as f64 / total as f64;
							let whole = share.floor();
							let extra = usize::from(rng.random() < share - whole);
							Some(whole as usize + extra)
						})
						.collect()
				}
			}
		};
		Ok(())
	}

	pub fn next(&mut self, rng: &mut PyRandom, shared: &Shared) -> Result<Option<Row>> {
		let mut start = std::mem::replace(&mut self.start, StartState::Pending);
		let started = start.ensure(|| self.plan(rng));
		self.start = start;
		started?;
		loop {
			if self.current.is_none() {
				if self.next_file >= self.files.len() {
					return Ok(None);
				}
				let file = self.files[self.next_file].clone();
				let quota = self.quotas[self.next_file];
				self.next_file += 1;
				if quota == Some(0) {
					continue;
				}
				// A label-less golden file used as a held-out file has a non-string `source`.
				let unfiltered = CorpusFile {
					path: file.path.clone(),
					filter: None,
				};
				file_source_counts(&unfiltered).map_err(|e| {
					Error::Input(format!(
						"parquet file {} has no `source` field ({e}) — likely a --golden (label-less) file used as \
						 a {:?} file. Rebuild it WITHOUT --golden so rows carry source + labels.",
						file.path.display(),
						self.split
					))
				})?;
				let limit = match quota {
					None => None,
					Some(q) => {
						let groups = ParquetFile::open(&file.path)?.num_row_groups().max(1);
						Some(q.div_ceil(groups))
					}
				};
				self.current = Some((FileRows::new(file.path, None, file.filter, limit), quota));
			}
			let (rows, remaining) = self.current.as_mut().expect("set above");
			if *remaining == Some(0) {
				self.current = None;
				continue;
			}
			match rows.next(rng, shared)? {
				Some(row) => {
					if let Some(left) = remaining.as_mut() {
						*left -= 1;
					}
					return Ok(Some(row));
				}
				None => self.current = None,
			}
		}
	}
}

/// The rows a split's stream reads before the shuffle buffer.
pub enum Upstream {
	Train(Mixture),
	HeldOut(Box<HeldOut>),
}

impl Upstream {
	pub fn next(&mut self, rng: &mut PyRandom, shared: &mut Shared) -> Result<Option<Row>> {
		match self {
			Upstream::Train(m) => m.next(rng, shared),
			Upstream::HeldOut(h) => h.next(rng, shared),
		}
	}
}
