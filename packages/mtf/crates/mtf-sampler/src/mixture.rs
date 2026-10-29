// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Sample across sources so the observed mix matches `source_weights`, or stream a held-out split's files.
//!
//! The train mixture is stationary for the whole epoch: each row draws its source from a multinomial over the
//! weights, and an exhausted source restarts with a fresh shuffled pass rather than leaving the mixture. The epoch
//! ends once every source has completed at least one full pass. A held-out split has no mixture to steer, so its
//! files stream one after another in shuffled order, or, with a row limit, each contributes rows in proportion to
//! its size.

use crate::corpus_files::{file_source_counts, files_source_counts, CorpusFile};
use crate::error::{Error, Result};
use crate::file_rows::FileRows;
use crate::parquet_file::ParquetFile;
use crate::pyrandom::PyRandom;
use crate::row::Row;
use crate::sampler::{Event, Shared};
use std::sync::Arc;

/// One source's files, read in a shuffled order, each through its own `FileRows`.
struct SourceRows {
	source: Arc<str>,
	files: Arc<Vec<CorpusFile>>,
	order: Vec<usize>,
	started: bool,
	position: usize,
	current: Option<FileRows>,
}

impl SourceRows {
	fn new(source: Arc<str>, files: Arc<Vec<CorpusFile>>) -> Self {
		Self {
			source,
			files,
			order: Vec::new(),
			started: false,
			position: 0,
			current: None,
		}
	}

	fn next(&mut self, rng: &mut PyRandom, shared: &Shared) -> Result<Option<Row>> {
		if !self.started {
			self.started = true;
			self.order = (0..self.files.len()).collect();
			rng.shuffle(&mut self.order);
		}
		loop {
			if self.current.is_none() {
				if self.position >= self.order.len() {
					return Ok(None);
				}
				let file = &self.files[self.order[self.position]];
				self.position += 1;
				self.current = Some(FileRows::new(
					file.path.clone(),
					Some(self.source.clone()),
					file.filter.clone(),
					None,
				));
			}
			match self.current.as_mut().expect("set above").next(rng, shared)? {
				Some(row) => return Ok(Some(row)),
				None => self.current = None,
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
	pub fn open(files: Vec<CorpusFile>, shared: &Shared) -> Result<Self> {
		let mut by_source: Vec<(String, Vec<CorpusFile>)> = Vec::new();
		for (file, counted) in files.iter().zip(files_source_counts(&files)) {
			let counted =
				counted.map_err(|e| Error::Input(format!("cannot index {} by source: {e}", file.path.display())))?;
			for (source, _) in counted {
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
		Ok(Self {
			sources: by_source
				.into_iter()
				.map(|(s, f)| SourceRows::new(Arc::from(s.as_str()), Arc::new(f)))
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
				let files = self.sources[chosen].files.clone();
				self.sources[chosen] = SourceRows::new(Arc::from(source.as_str()), files);
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
	started: bool,
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
			started: false,
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

	fn start(&mut self, rng: &mut PyRandom) -> Result<()> {
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
		if !self.started {
			self.started = true;
			self.start(rng)?;
		}
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
