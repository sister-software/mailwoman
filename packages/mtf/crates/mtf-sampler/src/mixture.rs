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
//!
//! Under `read_order: stored`, [`Stored`] replaces the mixture: the listed train files are read once in stored order
//! with no draw.

use crate::corpus_files::{file_source_counts, files_source_counts, indexed, CorpusFile};
use crate::error::{Error, Result};
use crate::file_rows::{FileRows, RowDrops, RowGroupVisit, StartState};
use crate::parquet_file::ParquetFile;
use crate::pyrandom::PyRandom;
use crate::row::Row;
use crate::sampler::{EpochCursor, Event, RunPositions, Shared};
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
	/// The group's order seed and the rotation its order starts at, set when the epoch is placed in its run.
	run_order: Option<(i128, usize)>,
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
		/// The run's table of rows read per group, for an epoch placed in its run.
		positions: Option<RunPositions>,
	},
}

/// Records the rows an unfinished visit read, so the next epoch continues after them.
///
/// An epoch ends at its row limit, usually in the middle of a visit, and a restarted pass replaces the source's
/// rows. Both drop the plan.
impl Drop for SourceRows {
	fn drop(&mut self) {
		if let Some(Plan::Spread {
			units,
			current: Some((at, visit)),
			positions: Some(positions),
			..
		}) = &self.plan
		{
			let unit = &units[*at];
			positions.advance(
				&self.files[unit.file].path,
				unit.group,
				(visit.position() - unit.position) as u64,
			);
		}
	}
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
	fn start(&self, rng: &mut PyRandom, cursor: Option<&EpochCursor>) -> Result<Plan> {
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
					run_order: None,
				});
			}
		}
		// A placed epoch reads each group's run-wide order from where the run's earlier reads of it stopped.
		if let Some(cursor) = cursor {
			for (unit, &rows) in units.iter_mut().zip(&sizes) {
				let read = cursor.positions.get(&self.files[unit.file].path, unit.group);
				let rotation = (read % (rows.max(1) as u64)) as usize;
				let order_seed = (cursor.run_seed << 40) ^ ((unit.file as i128) << 20) ^ unit.group as i128;
				unit.run_order = Some((order_seed, rotation));
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
		// A placed epoch visits the groups in one order for the whole run, from where the run's sweep stopped, so
		// every group gets its visits in turn. The epoch's own shuffle above still draws from the generator, so the
		// draws after it are the same whether or not the epoch is placed.
		let mut next = 0;
		if let Some(cursor) = cursor {
			units.sort_by_key(|unit| (unit.file, unit.group));
			let source_seed = self
				.source
				.bytes()
				.fold(0i128, |hash, byte| (hash * 131 + i128::from(byte)) % (1 << 61));
			PyRandom::new(crate::pyrandom::Seed::Int((cursor.run_seed << 61) ^ source_seed)).shuffle(&mut units);
			next = (cursor.positions.sweep(&self.source) % units.len().max(1) as u64) as usize;
		}
		Ok(Plan::Spread {
			live: units.len(),
			units,
			next,
			seed,
			current: None,
			positions: cursor.map(|c| c.positions.clone()),
		})
	}

	fn next(&mut self, rng: &mut PyRandom, shared: &Shared) -> Result<Option<Row>> {
		if self.plan.is_none() {
			self.plan = Some(self.start(rng, shared.epoch_cursor.as_ref())?);
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
				positions,
			} => Self::next_spread(
				&self.source,
				&self.files,
				units,
				next,
				live,
				*seed,
				current,
				positions.as_ref(),
				rng,
				shared,
			),
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
		positions: Option<&RunPositions>,
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
				if let Some(positions) = positions {
					positions.advance_sweep(source);
				}
				let unit = &units[at];
				if unit.exhausted {
					continue;
				}
				let file = &files[unit.file];
				// Distinct units of one pass seed distinct generators, so each group's order is its own.
				let (order_seed, rotation) = unit.run_order.unwrap_or(((seed << 32) | at as i128, 0));
				*current = Some((
					at,
					RowGroupVisit::open(
						file.path.clone(),
						source.clone(),
						file.filter.as_deref(),
						unit.group,
						order_seed,
						rotation,
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
			if let Some(positions) = positions {
				positions.advance(
					&files[unit.file].path,
					unit.group,
					(visit.position() - unit.position) as u64,
				);
			}
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

/// The train split's files indexed by source, with each kept source's weight.
struct TrainSources {
	/// The positively weighted sources in first-appearance order, each with the files that hold it.
	by_source: Vec<(String, Vec<CorpusFile>)>,
	/// Every source's train rows, zero-weighted sources included.
	source_rows: Vec<(String, u64)>,
	/// The weight of each `by_source` entry.
	weights: Vec<f64>,
}

impl TrainSources {
	/// Indexes `files` by source and applies the configured weights.
	///
	/// Refuses a positive weight whose source has no file, a train source the weights leave unnamed, and weights that
	/// leave no source.
	fn index(files: &[CorpusFile], shared: &Shared) -> Result<Self> {
		let mut by_source: Vec<(String, Vec<CorpusFile>)> = Vec::new();
		let mut source_rows: Vec<(String, u64)> = Vec::new();
		for (file, counted) in files.iter().zip(files_source_counts(files)) {
			let counted = indexed(file, counted)?;
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
		let Some(configured) = &shared.source_weights else {
			let weights = vec![1.0; by_source.len()];
			return Ok(Self {
				by_source,
				source_rows,
				weights,
			});
		};
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
		let weights = by_source
			.iter()
			.map(|(s, _)| configured.get(s).expect("named above"))
			.collect();
		Ok(Self {
			by_source,
			source_rows,
			weights,
		})
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
		let TrainSources {
			by_source,
			source_rows,
			weights,
		} = TrainSources::index(&files, shared)?;
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

/// The train split read once in stored order, for `read_order: stored`.
///
/// Only positively weighted sources are read. They come in the order `source_weights` lists them (first appearance
/// in the manifest when the config sets no weights), so a config states which source trains first. Each source's
/// files come in the order the manifest lists them, each file's row groups ascending and each group's rows as stored.
/// A row is yielded when it passes the row filter, the country weight and the coarse filter, so each such row comes
/// out exactly once, and the rows each check refused are counted in [`Stored::drops`]. Nothing here draws from the
/// generator: there is no source multinomial, no shuffle and no country acceptance draw. The split ends when the
/// files end, and a source that yielded no row then is an error, as it is in the mixture.
pub struct Stored {
	/// Each source's files in listed order, the sources in read order.
	units: Vec<(Arc<str>, CorpusFile)>,
	next_unit: usize,
	current: Option<FileRows>,
	/// The positively weighted sources in read order, with the rows each has yielded.
	realized: Vec<(String, u64)>,
	/// The rows of finished files the checks refused.
	drops: RowDrops,
	done: bool,
}

impl Stored {
	/// Indexes the listed train files by source and keeps each positively weighted source's files.
	///
	/// Every positively weighted source must be in `augment_exclude_sources`, because the emit step draws for a source
	/// it augments, and a stored-order read makes no draw before it.
	pub fn open(files: Vec<CorpusFile>, shared: &Shared, augment_exclude_sources: &[String]) -> Result<Self> {
		let TrainSources { mut by_source, .. } = TrainSources::index(&files, shared)?;
		if let Some(configured) = &shared.source_weights {
			by_source.sort_by_key(|(s, _)| configured.0.iter().position(|(k, _)| k == s));
		}
		let mut augmented: Vec<&str> = by_source
			.iter()
			.map(|(s, _)| s.as_str())
			.filter(|s| !augment_exclude_sources.iter().any(|e| e == s))
			.collect();
		augmented.sort_unstable();
		if !augmented.is_empty() {
			return Err(Error::Input(format!(
				"read_order: stored reads each train row once with no draw, and {} positively weighted source(s) \
				 are absent from augment_exclude_sources, so the emit step would draw for their rows: {}. Add each \
				 one to augment_exclude_sources or give it weight 0.0.",
				augmented.len(),
				augmented.join(", ")
			)));
		}
		// `by_source` lists a source's files in the manifest's order, because the index walks the files in that order.
		let units = by_source
			.iter()
			.flat_map(|(source, listed)| {
				let source: Arc<str> = Arc::from(source.as_str());
				listed.iter().map(move |file| (source.clone(), file.clone()))
			})
			.collect();
		Ok(Self {
			units,
			next_unit: 0,
			current: None,
			realized: by_source.into_iter().map(|(s, _)| (s, 0)).collect(),
			drops: RowDrops::default(),
			done: false,
		})
	}

	/// The next row in stored order. `rng` is handed to the file reader, which draws nothing from it in stored order.
	pub fn next(&mut self, rng: &mut PyRandom, shared: &mut Shared) -> Result<Option<Row>> {
		loop {
			if self.done {
				return Ok(None);
			}
			if self.current.is_none() {
				if self.next_unit >= self.units.len() {
					return self.finish(shared);
				}
				let (source, file) = &self.units[self.next_unit];
				self.next_unit += 1;
				self.current = Some(FileRows::stored(file.path.clone(), source.clone(), file.filter.clone()));
			}
			let reader = self.current.as_mut().expect("set above");
			let Some(row) = reader.next(rng, shared)? else {
				self.drops.add(reader.drops());
				self.current = None;
				continue;
			};
			let (_, count) = self
				.realized
				.iter_mut()
				.find(|(s, _)| *s == row.source)
				.expect("a unit reads only its own source");
			*count += 1;
			return Ok(Some(row));
		}
	}

	/// The rows each positively weighted source has yielded, in read order.
	pub fn realized(&self) -> &[(String, u64)] {
		&self.realized
	}

	/// The rows the checks refused so far, the file being read included.
	pub fn drops(&self) -> RowDrops {
		let mut drops = self.drops;
		if let Some(reader) = &self.current {
			drops.add(reader.drops());
		}
		drops
	}

	fn finish(&mut self, shared: &mut Shared) -> Result<Option<Row>> {
		self.done = true;
		let mut empty: Vec<&str> = self
			.realized
			.iter()
			.filter(|(_, n)| *n == 0)
			.map(|(s, _)| s.as_str())
			.collect();
		empty.sort_unstable();
		if !empty.is_empty() {
			return Err(Error::Input(format!(
				"sources {empty:?} have a positive weight but yielded zero selectable rows in stored order \
				 (country_weights / coarse_filter admit nothing) — fix the recipe or the corpus; a silent drop would \
				 change the training rows"
			)));
		}
		shared.emit(Event::EpochComplete {
			realized: self.realized.clone(),
		});
		Ok(None)
	}
}

/// The rows a split's stream reads before the shuffle buffer.
pub enum Upstream {
	Train(Mixture),
	Stored(Box<Stored>),
	HeldOut(Box<HeldOut>),
}

impl Upstream {
	pub fn next(&mut self, rng: &mut PyRandom, shared: &mut Shared) -> Result<Option<Row>> {
		match self {
			Upstream::Train(m) => m.next(rng, shared),
			Upstream::Stored(s) => s.next(rng, shared),
			Upstream::HeldOut(h) => h.next(rng, shared),
		}
	}
}
