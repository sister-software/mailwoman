// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The sampler: the rows a split yields, in order, and the batches built from them.
//!
//! Every stage draws from one CPython-compatible generator seeded with the caller's seed: the file order, the row
//! group and row order, the country acceptance test, the source multinomial, the shuffle buffer and each
//! augmentation. Adding, dropping or reordering a draw anywhere reshuffles the corpus a seeded run trains on, so each
//! stage draws exactly where the Python sampler it replaced drew.
//!
//! After the source mixture, a buffer of `shuffle_buffer` rows mixes rows across row groups: it fills, then for each
//! further upstream row it swaps the row in at a random slot and emits the row it replaced, and once the upstream is
//! exhausted it emits what remains in shuffled order. The emit step applies augmentation and the affix relabel on the
//! train split only; a held-out split reads its rows unweighted and unaugmented. Rows whose UTF-16 span offsets run
//! past their code-point length are skipped and reported, and the rest are yielded.

use crate::augment::postcode_move::PostcodeLayouts;
use crate::config::{SamplerConfig, Weights};
use crate::corpus_files::corpus_split_files;
use crate::emit::EmitPolicy;
use crate::error::{Error, Result};
use crate::mixture::{HeldOut, Mixture, Upstream};
use crate::pyrandom::{PyRandom, Seed};
use crate::relabel::AffixRelabelLexicon;
use crate::row::Row;
use crate::source_reps;
use rustc_hash::FxHashSet;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Why a sampled row was not yielded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SkipReason {
	/// A span end runs past the row's code-point length: the corpus stored UTF-16 offsets for an astral-plane row.
	AstralOffsets,
}

/// What the sampler reports while it streams.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
	/// A row was yielded; `index` counts the yielded rows from 0.
	RowEmitted {
		index: u64,
		source: String,
		country: Option<String>,
	},
	/// A row was dropped before it was yielded.
	RowSkipped {
		reason: SkipReason,
		source: String,
		raw: String,
	},
	/// A train source finished a pass and started another; `passes` counts its completed passes.
	SourceRestarted { source: String, passes: u64 },
	/// Every train source completed a pass, which ends the epoch. `realized` lists the draws per source.
	EpochComplete { realized: Vec<(String, u64)> },
}

/// Receives the sampler's events. An observer may travel with its sampler to another thread.
pub trait Observer: Send + Sync {
	fn event(&mut self, event: &Event);
}

/// A flag a caller sets to stop a stream; the stream returns [`Error::Cancelled`] at its next row.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
	pub fn cancel(&self) {
		self.0.store(true, Ordering::Relaxed);
	}

	pub fn is_cancelled(&self) -> bool {
		self.0.load(Ordering::Relaxed)
	}
}

/// What every stage of one stream reads.
pub struct Shared {
	pub country_weights: Weights,
	pub max_country_weight: f64,
	pub coarse_filter: bool,
	pub active_tags: FxHashSet<String>,
	pub source_weights: Option<Weights>,
	pub cancel: CancelToken,
	pub observer: Option<Box<dyn Observer>>,
}

impl Shared {
	pub fn check_cancelled(&self) -> Result<()> {
		if self.cancel.is_cancelled() {
			Err(Error::Cancelled)
		} else {
			Ok(())
		}
	}

	pub fn emit(&mut self, event: Event) {
		if let Some(observer) = self.observer.as_mut() {
			observer.event(&event);
		}
	}

	/// Whether one of a row's labels names an active tag: the tag after the first `-` of each label except `O`.
	pub fn active_components_present(&self, labels: &[String]) -> bool {
		labels.iter().any(|label| {
			label != "O"
				&& label
					.split_once('-')
					.is_some_and(|(_, tag)| self.active_tags.contains(tag))
		})
	}
}

/// The shuffle buffer and emit step over one split's upstream rows.
struct Stream {
	upstream: Upstream,
	buffer: Vec<Row>,
	filled: bool,
	draining: Option<std::vec::IntoIter<Row>>,
	pending: VecDeque<Result<Row>>,
	policy: EmitPolicy,
	shuffle_buffer: usize,
	row_limit: Option<u64>,
	emitted: u64,
	finished: bool,
}

impl Stream {
	fn next(&mut self, rng: &mut PyRandom, shared: &mut Shared) -> Result<Option<Row>> {
		loop {
			if self.finished {
				return Ok(None);
			}
			if let Some(item) = self.pending.pop_front() {
				let row = item?;
				self.emitted += 1;
				if self.row_limit.is_some_and(|limit| self.emitted >= limit) {
					self.finished = true;
					self.pending.clear();
				}
				return Ok(Some(row));
			}
			shared.check_cancelled()?;
			if !self.filled {
				self.filled = true;
				while self.buffer.len() < self.shuffle_buffer {
					match self.upstream.next(rng, shared)? {
						Some(row) => self.buffer.push(row),
						None => break,
					}
				}
			}
			let out = if let Some(drain) = self.draining.as_mut() {
				match drain.next() {
					Some(row) => row,
					None => {
						self.finished = true;
						return Ok(None);
					}
				}
			} else {
				match self.upstream.next(rng, shared)? {
					Some(row) => {
						let j = rng.randbelow(self.buffer.len() as u128) as usize;
						std::mem::replace(&mut self.buffer[j], row)
					}
					None => {
						let mut rest = std::mem::take(&mut self.buffer);
						rng.shuffle(&mut rest);
						self.draining = Some(rest.into_iter());
						continue;
					}
				}
			};
			self.pending.extend(self.policy.emit(out, rng));
		}
	}
}

/// One split's sampled rows, in the order the trainer reads them.
pub struct Sampler {
	rng: PyRandom,
	shared: Shared,
	stream: Stream,
	drop_spans: bool,
	yielded: u64,
	astral_skipped: u64,
}

/// The cap of the source-weight ratio's denominator a held-out stream reads: every country's weight.
fn max_weight(weights: &Weights) -> f64 {
	weights.0.iter().map(|&(_, w)| w).fold(f64::NEG_INFINITY, f64::max)
}

impl Sampler {
	/// Opens `split` of the configured corpus with a generator seeded as `random.Random(seed)`.
	///
	/// `row_limit` caps the rows the stream emits, counted before the astral skip, as the Python stream counted them.
	/// A held-out split also uses it to draw rows from every file in proportion to its size.
	pub fn open(config: &SamplerConfig, split: &str, seed: i128, row_limit: Option<u64>) -> Result<Self> {
		Self::open_with(config, split, seed, row_limit, CancelToken::default(), None)
	}

	pub fn open_with(
		config: &SamplerConfig,
		split: &str,
		seed: i128,
		row_limit: Option<u64>,
		cancel: CancelToken,
		observer: Option<Box<dyn Observer>>,
	) -> Result<Self> {
		let parts = StreamParts::open(config, split, row_limit, cancel, observer, true)?;
		Ok(Self {
			rng: PyRandom::new(Seed::Int(seed)),
			shared: parts.shared,
			stream: Stream {
				upstream: parts.upstream,
				buffer: Vec::new(),
				filled: false,
				draining: None,
				pending: VecDeque::new(),
				policy: parts.policy,
				shuffle_buffer: config.shuffle_buffer,
				row_limit,
				emitted: 0,
				finished: false,
			},
			drop_spans: config.drop_spans,
			yielded: 0,
			astral_skipped: 0,
		})
	}
}

/// What a split's stream is built from: the shared stage settings, the upstream rows and the emit policy.
struct StreamParts {
	shared: Shared,
	upstream: Upstream,
	policy: EmitPolicy,
}

impl StreamParts {
	/// `check_exclusions` refuses an `augment_exclude_sources` entry no train source carries, as the training stream
	/// does. The audits' raw stream leaves the list unchecked, as the Python `_raw_row_stream` did.
	fn open(
		config: &SamplerConfig,
		split: &str,
		row_limit: Option<u64>,
		cancel: CancelToken,
		observer: Option<Box<dyn Observer>>,
		check_exclusions: bool,
	) -> Result<Self> {
		if config.country_weights.is_empty() {
			return Err(Error::Input("country_weights must be non-empty".into()));
		}
		let train = split == "train";
		// The relabel lexicon is read for every split, so a missing file fails a validation stream too.
		let relabel = config
			.affix_relabel_lexicon_path
			.as_deref()
			.map(AffixRelabelLexicon::load)
			.transpose()?
			.map(Arc::new);
		let source_weights = if train {
			source_reps::resolved_source_weights(config)?
		} else {
			None
		};
		if let Some(weights) = source_weights.as_ref().filter(|_| check_exclusions) {
			let mut unmatched: Vec<&str> = config
				.augment_exclude_sources
				.iter()
				.map(String::as_str)
				.filter(|s| !weights.contains(s))
				.collect();
			unmatched.sort_unstable();
			unmatched.dedup();
			if !unmatched.is_empty() {
				return Err(Error::Input(format!(
					"augment_exclude_sources names {} source(s) that no row carries: {}. Each one leaves its \
					 intended rows augmented while the run reports a clean pass. Check for a retired spelling: \
					 `packages/corpus/lib/recipes/sources.ts` maps the retired `synth-` names to their current ones.",
					unmatched.len(),
					unmatched.join(", ")
				)));
			}
		}
		let augment = if train { config.augment } else { Default::default() };
		let layouts = if augment.postcode_move > 0.0 {
			let path = config.postcode_layouts_path.as_deref().ok_or_else(|| {
				Error::Input("augment.postcode_move is positive and no postcode_layouts_path is configured".into())
			})?;
			Some(Arc::new(PostcodeLayouts::load(path)?))
		} else {
			None
		};
		let shared = Shared {
			max_country_weight: max_weight(&config.country_weights),
			country_weights: config.country_weights.clone(),
			coarse_filter: config.coarse_filter,
			active_tags: config.active_tags.iter().cloned().collect(),
			source_weights,
			cancel,
			observer,
		};
		let files = corpus_split_files(config, split)?;
		let upstream = if train {
			Upstream::Train(Mixture::open(files, &shared)?)
		} else {
			Upstream::HeldOut(Box::new(HeldOut::new(files, split, row_limit.map(|n| n as usize))))
		};
		shared.check_cancelled()?;
		Ok(Self {
			shared,
			upstream,
			policy: EmitPolicy {
				augment,
				excluded_sources: config.augment_exclude_sources.clone(),
				relabel: if train { relabel } else { None },
				layouts,
				postcode_move_outcomes: Default::default(),
			},
		})
	}
}

/// A split's rows before the shuffle buffer, with the emit step available on the same generator.
///
/// The audits count what the source mixture draws and what the emit step makes of it. They read the upstream
/// rows directly, as the Python audits read `_raw_row_stream`: no shuffle buffer, no astral skip, and the
/// `augment_exclude_sources` list unchecked. [`RawRows::next_emitted`] draws a row and emits it with the one
/// generator, so a pass that emits consumes the generator as the trainer's emit step does.
pub struct RawRows {
	rng: PyRandom,
	shared: Shared,
	upstream: Upstream,
	policy: EmitPolicy,
	row_limit: Option<u64>,
	drawn: u64,
}

impl RawRows {
	pub fn open(
		config: &SamplerConfig,
		split: &str,
		seed: i128,
		row_limit: Option<u64>,
		cancel: CancelToken,
		observer: Option<Box<dyn Observer>>,
	) -> Result<Self> {
		let parts = StreamParts::open(config, split, row_limit, cancel, observer, false)?;
		Ok(Self {
			rng: PyRandom::new(Seed::Int(seed)),
			shared: parts.shared,
			upstream: parts.upstream,
			policy: parts.policy,
			row_limit,
			drawn: 0,
		})
	}

	/// The next upstream row, or `None` at exhaustion. A held-out split draws to its row limit as the stream does.
	pub fn next_raw(&mut self) -> Result<Option<Row>> {
		self.shared.check_cancelled()?;
		let row = self.upstream.next(&mut self.rng, &mut self.shared)?;
		if row.is_some() {
			self.drawn += 1;
		}
		Ok(row)
	}

	/// The next upstream row and the rows the emit step makes of it, or `None` at exhaustion.
	pub fn next_emitted(&mut self) -> Result<Option<(Row, Vec<Row>)>> {
		let Some(row) = self.next_raw()? else {
			return Ok(None);
		};
		let emitted = self
			.policy
			.emit(row.clone(), &mut self.rng)
			.into_iter()
			.collect::<Result<Vec<_>>>()?;
		Ok(Some((row, emitted)))
	}

	/// The upstream rows drawn so far.
	pub fn drawn(&self) -> u64 {
		self.drawn
	}

	/// The row limit the stream was opened with.
	pub fn row_limit(&self) -> Option<u64> {
		self.row_limit
	}

	/// Each postcode-move draw so far, as moved or under its skip reason.
	pub fn postcode_move_outcomes(&self) -> Vec<(&'static str, u64)> {
		sorted_outcomes(&self.policy)
	}

	/// Takes the observer back, so a caller can read what it collected.
	pub fn take_observer(&mut self) -> Option<Box<dyn Observer>> {
		self.shared.observer.take()
	}
}

fn sorted_outcomes(policy: &EmitPolicy) -> Vec<(&'static str, u64)> {
	let mut out: Vec<(&'static str, u64)> = policy.postcode_move_outcomes.0.iter().map(|(&k, &v)| (k, v)).collect();
	out.sort_unstable();
	out
}

impl Sampler {
	/// The next row, or `None` once the split is exhausted or the row limit is reached.
	pub fn next_row(&mut self) -> Result<Option<Row>> {
		loop {
			let Some(mut row) = self.stream.next(&mut self.rng, &mut self.shared)? else {
				return Ok(None);
			};
			if self.drop_spans {
				row.spans = None;
			}
			let code_points = row.raw.chars().count() as i64;
			if let Some(spans) = &row.spans {
				if spans.ends.iter().max().is_some_and(|&end| end > code_points) {
					self.astral_skipped += 1;
					self.shared.emit(Event::RowSkipped {
						reason: SkipReason::AstralOffsets,
						source: row.source.clone(),
						raw: row.raw.clone(),
					});
					continue;
				}
			}
			self.shared.emit(Event::RowEmitted {
				index: self.yielded,
				source: row.source.clone(),
				country: row.country.clone(),
			});
			self.yielded += 1;
			return Ok(Some(row));
		}
	}

	/// The sampled rows, ending at exhaustion or at the first error.
	pub fn rows(&mut self) -> impl Iterator<Item = Result<Row>> + '_ {
		std::iter::from_fn(move || self.next_row().transpose())
	}

	/// The next `batch_size` rows, fewer at exhaustion, and `None` once no row remains.
	pub fn next_batch(&mut self, batch_size: usize) -> Result<Option<Vec<Row>>> {
		let mut rows = Vec::with_capacity(batch_size);
		while rows.len() < batch_size {
			match self.next_row()? {
				Some(row) => rows.push(row),
				None => break,
			}
		}
		Ok((!rows.is_empty()).then_some(rows))
	}

	/// The rows in batches of `batch_size`, the last one partial.
	pub fn batches(&mut self, batch_size: usize) -> impl Iterator<Item = Result<Vec<Row>>> + '_ {
		std::iter::from_fn(move || self.next_batch(batch_size).transpose())
	}

	/// The rows yielded so far.
	pub fn yielded(&self) -> u64 {
		self.yielded
	}

	/// The rows skipped for UTF-16 span offsets so far.
	pub fn astral_skipped(&self) -> u64 {
		self.astral_skipped
	}

	/// Each postcode-move draw so far, as moved or under its skip reason.
	pub fn postcode_move_outcomes(&self) -> Vec<(&'static str, u64)> {
		sorted_outcomes(&self.stream.policy)
	}

	/// Takes the observer back, so a caller can read what it collected.
	pub fn take_observer(&mut self) -> Option<Box<dyn Observer>> {
		self.shared.observer.take()
	}
}

/// The train split's batches without end, reopening the stream with `seed + epoch` for epochs 1, 2, ….
///
/// A resumed run passes the number of batches its earlier attempts consumed as `skip_batches`. Those batches are
/// sampled in order and dropped, so the stream continues with the batch an uninterrupted run would read next. An
/// epoch that yields no row is an error, because the stream would otherwise spin.
pub struct TrainingBatches {
	config: SamplerConfig,
	batch_size: usize,
	seed: i128,
	row_limit: Option<u64>,
	remaining_skip: u64,
	epoch: u64,
	drawn: u64,
	current: Option<Sampler>,
	cancel: CancelToken,
}

impl TrainingBatches {
	pub fn new(
		config: SamplerConfig,
		batch_size: usize,
		seed: i128,
		row_limit: Option<u64>,
		skip_batches: u64,
		cancel: CancelToken,
	) -> Self {
		Self {
			config,
			batch_size,
			seed,
			row_limit,
			remaining_skip: skip_batches,
			epoch: 0,
			drawn: 0,
			current: None,
			cancel,
		}
	}

	/// The epoch the last batch came from, counted from 1.
	pub fn epoch(&self) -> u64 {
		self.epoch
	}

	/// The next batch the trainer reads.
	pub fn next_batch(&mut self) -> Result<Vec<Row>> {
		loop {
			if self.current.is_none() {
				self.epoch += 1;
				self.drawn = 0;
				let seed = self.seed + i128::from(self.epoch);
				self.current = Some(Sampler::open_with(
					&self.config,
					"train",
					seed,
					self.row_limit,
					self.cancel.clone(),
					None,
				)?);
			}
			match self
				.current
				.as_mut()
				.expect("opened above")
				.next_batch(self.batch_size)?
			{
				Some(rows) => {
					self.drawn += 1;
					if self.remaining_skip > 0 {
						self.remaining_skip -= 1;
						continue;
					}
					return Ok(rows);
				}
				None => {
					if self.drawn == 0 {
						return Err(Error::Input(format!(
							"the train split yielded no rows in epoch {} (seed {})",
							self.epoch,
							self.seed + i128::from(self.epoch)
						)));
					}
					self.current = None;
				}
			}
		}
	}
}
