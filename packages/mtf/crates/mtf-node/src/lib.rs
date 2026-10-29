// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The `mtf-node` addon: `mtf-sampler`'s streams and `mtf-channels`' encoders for Node.
//!
//! `Sampler` streams one split's rows in the order the trainer reads them, `TrainingBatches` the train split's
//! batches without end, and `RawRows` the rows before the shuffle buffer with the emit step on the same generator,
//! which the audits count. Each stream hands rows out in chunks the caller sizes, so a consumer holds one chunk at a
//! time. `RowEncoder` and `CharEncoder` encode a batch into typed arrays that own their buffers. The sampler's events
//! (`row_emitted`, `row_skipped`, `source_restarted`, `epoch_complete`) are collected for the kinds a caller asks for
//! and handed out by `takeEvents`.

#![deny(clippy::all)]

use mtf_channels::anchor::AnchorLookup;
use mtf_channels::encoder::{require_whole_triple, CHANNEL_NAMES};
use mtf_channels::finders::{PostcodeShapes, PostcodeSyntax, RegexFinders};
use mtf_channels::gazetteer::Lexicon;
use mtf_channels::label_schema::LabelSchema;
use mtf_channels::{AnchorMode, Encoder, EncoderConfig, Finders, Lexicons, Piece, RowInput};
use mtf_core::Processor;
use mtf_sampler::batch::encode_pieces;
use mtf_sampler::char_path::CharEncoder as RustCharEncoder;
use mtf_sampler::source_reps::{derive_source_weights as derive, DerivedReps};
use mtf_sampler::split_columns::{ColumnValues, SplitColumns as RustSplitColumns};
use mtf_sampler::{
	CancelToken, CharConfig, Event, Observer, RawRows as RustRawRows, Row, Sampler as RustSampler, SamplerConfig,
	SkipReason, SpanTriple, TrainingBatches as RustTrainingBatches, Weights,
};
use napi::bindgen_prelude::{BigInt64Array, Float32Array};
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

fn sampler_error(error: mtf_sampler::Error) -> Error {
	let status = match error {
		mtf_sampler::Error::Cancelled => Status::Cancelled,
		_ => Status::GenericFailure,
	};
	Error::new(status, error.to_string())
}

fn channel_error(error: mtf_channels::Error) -> Error {
	Error::new(Status::GenericFailure, error.to_string())
}

fn input(message: impl Into<String>) -> Error {
	Error::new(Status::InvalidArg, message.into())
}

fn read(path: &str) -> Result<String> {
	std::fs::read_to_string(path).map_err(|e| input(format!("cannot read {path}: {e}")))
}

fn config(json: &str) -> Result<SamplerConfig> {
	SamplerConfig::from_json(json).map_err(sampler_error)
}

fn count(value: Option<i64>, name: &str) -> Result<Option<u64>> {
	value
		.map(|v| u64::try_from(v).map_err(|_| input(format!("{name} must be zero or positive, got {v}"))))
		.transpose()
}

/// One sampled row. The span triple is present when the row's file stores one.
#[napi(object)]
#[derive(Clone)]
pub struct SampledRow {
	pub raw: String,
	pub tokens: Vec<String>,
	pub labels: Vec<String>,
	pub country: Option<String>,
	pub source: String,
	pub span_starts: Option<Vec<i64>>,
	pub span_ends: Option<Vec<i64>>,
	pub span_tags: Option<Vec<String>>,
}

impl From<Row> for SampledRow {
	fn from(row: Row) -> Self {
		let (span_starts, span_ends, span_tags) = match row.spans {
			Some(SpanTriple { starts, ends, tags }) => (Some(starts), Some(ends), Some(tags)),
			None => (None, None, None),
		};
		Self {
			raw: row.raw,
			tokens: row.tokens,
			labels: row.labels,
			country: row.country,
			source: row.source,
			span_starts,
			span_ends,
			span_tags,
		}
	}
}

fn to_row(row: SampledRow, index: usize) -> Result<Row> {
	let spans = match (row.span_starts, row.span_ends, row.span_tags) {
		(None, None, None) => None,
		(Some(starts), Some(ends), Some(tags)) => Some(SpanTriple { starts, ends, tags }),
		_ => {
			return Err(input(format!(
				"row {index}: spanStarts/spanEnds/spanTags must be supplied together"
			)))
		}
	};
	Ok(Row {
		raw: row.raw,
		tokens: row.tokens,
		labels: row.labels,
		country: row.country,
		source: row.source,
		spans,
	})
}

fn rows_out(rows: Vec<Row>) -> Vec<SampledRow> {
	rows.into_iter().map(SampledRow::from).collect()
}

/// A count per source.
#[napi(object)]
pub struct SourceCount {
	pub source: String,
	pub count: i64,
}

fn source_counts(pairs: Vec<(String, u64)>) -> Vec<SourceCount> {
	pairs
		.into_iter()
		.map(|(source, n)| SourceCount {
			source,
			count: n as i64,
		})
		.collect()
}

/// A count per postcode-move outcome.
#[napi(object)]
pub struct OutcomeCount {
	pub outcome: String,
	pub count: i64,
}

fn outcome_counts(pairs: Vec<(&'static str, u64)>) -> Vec<OutcomeCount> {
	pairs
		.into_iter()
		.map(|(outcome, n)| OutcomeCount {
			outcome: outcome.to_string(),
			count: n as i64,
		})
		.collect()
}

/// One sampler event. `kind` is `row_emitted`, `row_skipped`, `source_restarted` or `epoch_complete`, and the other
/// fields are the ones that kind carries.
#[napi(object)]
pub struct SamplerEvent {
	pub kind: String,
	pub index: Option<i64>,
	pub source: Option<String>,
	pub country: Option<String>,
	pub reason: Option<String>,
	pub raw: Option<String>,
	pub passes: Option<i64>,
	pub realized: Option<Vec<SourceCount>>,
}

fn event_kind(event: &Event) -> &'static str {
	match event {
		Event::RowEmitted { .. } => "row_emitted",
		Event::RowSkipped { .. } => "row_skipped",
		Event::SourceRestarted { .. } => "source_restarted",
		Event::EpochComplete { .. } => "epoch_complete",
	}
}

const EVENT_KINDS: [&str; 4] = ["row_emitted", "row_skipped", "source_restarted", "epoch_complete"];

fn event_out(event: Event) -> SamplerEvent {
	let mut out = SamplerEvent {
		kind: event_kind(&event).to_string(),
		index: None,
		source: None,
		country: None,
		reason: None,
		raw: None,
		passes: None,
		realized: None,
	};
	match event {
		Event::RowEmitted { index, source, country } => {
			out.index = Some(index as i64);
			out.source = Some(source);
			out.country = country;
		}
		Event::RowSkipped { reason, source, raw } => {
			out.reason = Some(
				match reason {
					SkipReason::AstralOffsets => "astral_offsets",
				}
				.to_string(),
			);
			out.source = Some(source);
			out.raw = Some(raw);
		}
		Event::SourceRestarted { source, passes } => {
			out.source = Some(source);
			out.passes = Some(passes as i64);
		}
		Event::EpochComplete { realized } => out.realized = Some(source_counts(realized)),
	}
	out
}

/// Collects the events of the kinds it was asked for, until `takeEvents` drains them.
#[derive(Clone, Default)]
struct Collector {
	kinds: Arc<Vec<&'static str>>,
	events: Arc<Mutex<Vec<Event>>>,
}

impl Observer for Collector {
	fn event(&mut self, event: &Event) {
		if self.kinds.contains(&event_kind(event)) {
			self.events
				.lock()
				.expect("the collector lock is never poisoned")
				.push(event.clone());
		}
	}
}

impl Collector {
	fn new(kinds: Option<Vec<String>>) -> Result<Option<Self>> {
		let Some(kinds) = kinds.filter(|k| !k.is_empty()) else {
			return Ok(None);
		};
		let mut picked = Vec::with_capacity(kinds.len());
		for kind in &kinds {
			let known = EVENT_KINDS.iter().find(|k| **k == kind.as_str()).ok_or_else(|| {
				input(format!(
					"unknown sampler event kind {kind:?}; expected one of {EVENT_KINDS:?}"
				))
			})?;
			picked.push(*known);
		}
		Ok(Some(Self {
			kinds: Arc::new(picked),
			events: Arc::default(),
		}))
	}

	fn take(&self) -> Vec<SamplerEvent> {
		let drained = std::mem::take(&mut *self.events.lock().expect("the collector lock is never poisoned"));
		drained.into_iter().map(event_out).collect()
	}
}

/// What opening a stream takes beyond the config, split and seed.
#[napi(object)]
pub struct StreamOptions {
	/// Caps the rows the stream emits, counted before the astral skip.
	pub row_limit: Option<i64>,
	/// The event kinds to collect for `takeEvents`. None collects nothing.
	pub events: Option<Vec<String>>,
}

fn stream_options(options: Option<StreamOptions>) -> Result<(Option<u64>, Option<Collector>)> {
	match options {
		None => Ok((None, None)),
		Some(o) => Ok((count(o.row_limit, "rowLimit")?, Collector::new(o.events)?)),
	}
}

fn boxed(collector: &Option<Collector>) -> Option<Box<dyn Observer>> {
	collector.clone().map(|c| Box::new(c) as Box<dyn Observer>)
}

/// One split's sampled rows, in the order the trainer reads them.
#[napi]
pub struct Sampler {
	inner: RustSampler,
	cancel: CancelToken,
	collector: Option<Collector>,
}

#[napi]
impl Sampler {
	/// Opens `split` with a generator seeded as `random.Random(seed)`. `config` is the sampler's JSON configuration.
	#[napi(constructor)]
	pub fn new(config: String, split: String, seed: i64, options: Option<StreamOptions>) -> Result<Self> {
		let parsed = self::config(&config)?;
		let (row_limit, collector) = stream_options(options)?;
		let cancel = CancelToken::default();
		let inner = RustSampler::open_with(
			&parsed,
			&split,
			i128::from(seed),
			row_limit,
			cancel.clone(),
			boxed(&collector),
		)
		.map_err(sampler_error)?;
		Ok(Self {
			inner,
			cancel,
			collector,
		})
	}

	/// The next `count` rows, fewer at exhaustion, and an empty array once no row remains.
	#[napi]
	pub fn next_rows(&mut self, count: u32) -> Result<Vec<SampledRow>> {
		Ok(rows_out(
			self.inner
				.next_batch(count as usize)
				.map_err(sampler_error)?
				.unwrap_or_default(),
		))
	}

	/// The events collected since the last call.
	#[napi]
	pub fn take_events(&self) -> Vec<SamplerEvent> {
		self.collector.as_ref().map(Collector::take).unwrap_or_default()
	}

	/// Stops the stream; the next read fails with the `Cancelled` status.
	#[napi]
	pub fn cancel(&self) {
		self.cancel.cancel();
	}

	/// The rows yielded so far.
	#[napi(getter)]
	pub fn yielded(&self) -> i64 {
		self.inner.yielded() as i64
	}

	/// The rows skipped so far because a span end runs past the code-point length.
	#[napi(getter)]
	pub fn astral_skipped(&self) -> i64 {
		self.inner.astral_skipped() as i64
	}

	/// Each postcode-move draw so far, as `moved` or under its skip reason.
	#[napi(getter)]
	pub fn postcode_move_outcomes(&self) -> Vec<OutcomeCount> {
		outcome_counts(self.inner.postcode_move_outcomes())
	}
}

/// The train split's batches without end, reopened with `seed + epoch` for epochs 1, 2, ….
#[napi]
pub struct TrainingBatches {
	inner: RustTrainingBatches,
	cancel: CancelToken,
}

#[napi]
impl TrainingBatches {
	/// `skipBatches` batches are sampled and dropped first, so a resumed run continues where it stopped.
	#[napi(constructor)]
	pub fn new(
		config: String,
		batch_size: u32,
		seed: i64,
		row_limit: Option<i64>,
		skip_batches: Option<i64>,
	) -> Result<Self> {
		if batch_size == 0 {
			return Err(input("batchSize must be positive"));
		}
		let cancel = CancelToken::default();
		Ok(Self {
			inner: RustTrainingBatches::new(
				self::config(&config)?,
				batch_size as usize,
				i128::from(seed),
				count(row_limit, "rowLimit")?,
				count(skip_batches, "skipBatches")?.unwrap_or(0),
				cancel.clone(),
			),
			cancel,
		})
	}

	/// The next batch the trainer reads.
	#[napi]
	pub fn next_batch(&mut self) -> Result<Vec<SampledRow>> {
		Ok(rows_out(self.inner.next_batch().map_err(sampler_error)?))
	}

	/// The epoch the last batch came from, counted from 1.
	#[napi(getter)]
	pub fn epoch(&self) -> i64 {
		self.inner.epoch() as i64
	}

	#[napi]
	pub fn cancel(&self) {
		self.cancel.cancel();
	}
}

/// One upstream row and the rows the emit step made of it, the drawn row first when it passes through.
#[napi(object)]
pub struct EmittedDraw {
	pub drawn: SampledRow,
	pub emitted: Vec<SampledRow>,
}

/// A split's rows before the shuffle buffer, with the emit step on the same generator: what the audits count.
#[napi]
pub struct RawRows {
	inner: RustRawRows,
	cancel: CancelToken,
	collector: Option<Collector>,
}

#[napi]
impl RawRows {
	#[napi(constructor)]
	pub fn new(config: String, split: String, seed: i64, options: Option<StreamOptions>) -> Result<Self> {
		let parsed = self::config(&config)?;
		let (row_limit, collector) = stream_options(options)?;
		let cancel = CancelToken::default();
		let inner = RustRawRows::open(
			&parsed,
			&split,
			i128::from(seed),
			row_limit,
			cancel.clone(),
			boxed(&collector),
		)
		.map_err(sampler_error)?;
		Ok(Self {
			inner,
			cancel,
			collector,
		})
	}

	/// The next `count` upstream rows, fewer at exhaustion.
	#[napi]
	pub fn next_raw(&mut self, count: u32) -> Result<Vec<SampledRow>> {
		let mut out = Vec::with_capacity(count as usize);
		while out.len() < count as usize {
			match self.inner.next_raw().map_err(sampler_error)? {
				Some(row) => out.push(SampledRow::from(row)),
				None => break,
			}
		}
		Ok(out)
	}

	/// The next `count` upstream rows, each with what the emit step made of it, fewer at exhaustion.
	#[napi]
	pub fn next_emitted(&mut self, count: u32) -> Result<Vec<EmittedDraw>> {
		let mut out = Vec::with_capacity(count as usize);
		while out.len() < count as usize {
			match self.inner.next_emitted().map_err(sampler_error)? {
				Some((drawn, emitted)) => out.push(EmittedDraw {
					drawn: SampledRow::from(drawn),
					emitted: rows_out(emitted),
				}),
				None => break,
			}
		}
		Ok(out)
	}

	#[napi]
	pub fn take_events(&self) -> Vec<SamplerEvent> {
		self.collector.as_ref().map(Collector::take).unwrap_or_default()
	}

	#[napi]
	pub fn cancel(&self) {
		self.cancel.cancel();
	}

	/// The upstream rows drawn so far.
	#[napi(getter)]
	pub fn drawn(&self) -> i64 {
		self.inner.drawn() as i64
	}

	#[napi(getter)]
	pub fn postcode_move_outcomes(&self) -> Vec<OutcomeCount> {
		outcome_counts(self.inner.postcode_move_outcomes())
	}
}

/// What a row encoder reads. Every lexicon path left unset leaves its channel off.
#[napi(object)]
pub struct RowEncoderOptions {
	/// The SentencePiece model the rows are tokenized with.
	pub tokenizer_model_path: String,
	/// `packages/neural/data/label-schema.v1.json`.
	pub label_schema_path: String,
	/// The label set the labels are encoded against. The SentencePiece path encodes `stage3`.
	pub label_set: Option<String>,
	pub max_length: u32,
	pub pad_id: Option<i64>,
	pub postcode_shapes_path: String,
	pub postcode_syntax_path: String,
	pub anchor_lookup_path: Option<String>,
	/// `gold` or `shaped`.
	pub anchor_paint_mode: Option<String>,
	pub gazetteer_lexicon_path: Option<String>,
	pub gazetteer_choreography: Option<bool>,
	pub country_lexicon_path: Option<String>,
	pub street_type_lexicon_path: Option<String>,
	pub locality_surface_lexicon_path: Option<String>,
	pub code_units: Option<bool>,
}

/// One configured channel of an encoded batch: `features` `[B, L, dim]` and `confidence` `[B, L]`, float32.
#[napi(object, object_from_js = false)]
pub struct EncodedChannel {
	pub name: String,
	pub dim: u32,
	pub features: Float32Array,
	pub confidence: Float32Array,
}

/// An encoded batch: `inputIds`, `attentionMask` and `labels` int64 `[B, L]` in row-major order.
#[napi(object, object_from_js = false)]
pub struct EncodedRows {
	pub rows: u32,
	pub max_length: u32,
	pub input_ids: BigInt64Array,
	pub attention_mask: BigInt64Array,
	pub labels: BigInt64Array,
	pub channels: Vec<EncodedChannel>,
}

fn lexicon(path: Option<&str>) -> Result<Option<Lexicon>> {
	path.map(|p| Lexicon::from_json(&read(p)?, p).map_err(channel_error))
		.transpose()
}

fn optional_path(path: &Option<String>) -> Option<&str> {
	path.as_deref().filter(|p| !p.is_empty())
}

/// A run's row encoder: the tokenizer, the label table, the lexicons and the span finders.
#[napi]
pub struct RowEncoder {
	processor: Arc<Processor>,
	config: EncoderConfig,
	lexicons: Lexicons,
	finders: RegexFinders,
}

impl RowEncoder {
	fn encoder(&self) -> Result<Encoder<'_>> {
		Encoder::new(&self.config, &self.lexicons, Some(&self.finders as &dyn Finders)).map_err(channel_error)
	}
}

#[napi]
impl RowEncoder {
	#[napi(constructor)]
	pub fn new(options: RowEncoderOptions) -> Result<Self> {
		let model = std::fs::read(&options.tokenizer_model_path)
			.map_err(|e| input(format!("cannot read {}: {e}", options.tokenizer_model_path)))?;
		let processor =
			Processor::from_model_proto(&model).map_err(|e| input(format!("{}: {e}", options.tokenizer_model_path)))?;
		let anchor_mode = match options.anchor_paint_mode.as_deref().unwrap_or("gold") {
			"gold" => AnchorMode::Gold,
			"shaped" => AnchorMode::Shaped,
			other => {
				return Err(input(format!(
					"anchorPaintMode {other:?} is not \"gold\" or \"shaped\""
				)))
			}
		};
		let schema = LabelSchema::from_json(&read(&options.label_schema_path)?).map_err(channel_error)?;
		let set = options.label_set.as_deref().unwrap_or("stage3");
		let labels = schema.label_table(set).map_err(channel_error)?;
		let anchor = optional_path(&options.anchor_lookup_path)
			.map(|path| AnchorLookup::from_json(&read(path)?, path).map_err(channel_error))
			.transpose()?;
		let finders = RegexFinders {
			shapes: PostcodeShapes::from_record(&read(&options.postcode_shapes_path)?, &options.postcode_shapes_path)
				.map_err(channel_error)?,
			syntax: PostcodeSyntax::from_json(&read(&options.postcode_syntax_path)?, &options.postcode_syntax_path)
				.map_err(channel_error)?,
		};
		let pad_id = options.pad_id.unwrap_or_else(|| processor.special_ids().pad);
		let encoder = Self {
			processor: Arc::new(processor),
			config: EncoderConfig {
				max_length: options.max_length as usize,
				pad_id,
				anchor_mode,
				gazetteer_choreography: options.gazetteer_choreography.unwrap_or(false),
				code_units: options.code_units.unwrap_or(false),
			},
			lexicons: Lexicons {
				labels,
				locales: schema.locale_countries.clone(),
				anchor,
				gazetteer: lexicon(optional_path(&options.gazetteer_lexicon_path))?,
				country: lexicon(optional_path(&options.country_lexicon_path))?,
				street_type: lexicon(optional_path(&options.street_type_lexicon_path))?,
				locality_surface: lexicon(optional_path(&options.locality_surface_lexicon_path))?,
			},
			finders,
		};
		encoder.encoder()?;
		Ok(encoder)
	}

	/// The batch's arrays.
	#[napi]
	pub fn encode_batch(&self, rows: Vec<SampledRow>) -> Result<EncodedRows> {
		let owned = rows
			.into_iter()
			.enumerate()
			.map(|(i, r)| to_row(r, i))
			.collect::<Result<Vec<_>>>()?;
		let encoder = self.encoder()?;
		let inputs = owned
			.iter()
			.enumerate()
			.map(|(index, row)| {
				let (starts, ends, tags) = match &row.spans {
					Some(s) => (Some(&s.starts[..]), Some(&s.ends[..]), Some(&s.tags[..])),
					None => (None, None, None),
				};
				let spans = require_whole_triple(starts, ends, tags, &row.raw).map_err(|e| e.at_row(index))?;
				Ok(RowInput {
					raw: &row.raw,
					tokens: &row.tokens,
					labels: &row.labels,
					spans,
				})
			})
			.collect::<std::result::Result<Vec<_>, mtf_channels::Error>>()
			.map_err(channel_error)?;
		let batch = encoder
			.encode_rows(&inputs, |_, raw| {
				Ok(encode_pieces(&self.processor, raw)?
					.into_iter()
					.map(|(id, _, begin, end)| Piece { id, begin, end })
					.collect())
			})
			.map_err(channel_error)?;
		Ok(EncodedRows {
			rows: batch.rows as u32,
			max_length: batch.max_length as u32,
			input_ids: BigInt64Array::new(batch.input_ids),
			attention_mask: BigInt64Array::new(batch.attention_mask),
			labels: BigInt64Array::new(batch.labels),
			channels: batch
				.channels
				.into_iter()
				.map(|c| EncodedChannel {
					name: c.name.to_string(),
					dim: c.dim as u32,
					features: Float32Array::new(c.features),
					confidence: Float32Array::new(c.confidence),
				})
				.collect(),
		})
	}

	/// Each configured channel's feature width, in the order `encodeBatch` emits them.
	#[napi(getter)]
	pub fn channel_dims(&self) -> Result<Vec<EncodedChannelDim>> {
		Ok(self
			.encoder()?
			.channel_dims()
			.into_iter()
			.map(|(name, dim)| EncodedChannelDim {
				name: name.to_string(),
				dim: dim as u32,
			})
			.collect())
	}
}

#[napi(object)]
pub struct EncodedChannelDim {
	pub name: String,
	pub dim: u32,
}

/// The character path's settings, as the sampler config's `char` block names them.
#[napi(object)]
pub struct CharEncoderOptions {
	/// `word` or `char`.
	pub mode: String,
	pub vocab_path: String,
	pub max_units: u32,
	pub max_unit_width: u32,
	pub char_ctx: Option<u32>,
	pub label_set: String,
	pub label_schema_path: String,
}

/// A char-path batch: `charIds` int64 `[B, S, W]`, and `attentionMask` and `labels` int64 `[B, S]`.
#[napi(object, object_from_js = false)]
pub struct EncodedChars {
	pub rows: u32,
	pub max_units: u32,
	pub max_unit_width: u32,
	pub char_ids: BigInt64Array,
	pub attention_mask: BigInt64Array,
	pub labels: BigInt64Array,
}

/// The character path's encoder: per-unit character windows for the CharCNN front end.
#[napi]
pub struct CharEncoder {
	inner: RustCharEncoder,
}

#[napi]
impl CharEncoder {
	#[napi(constructor)]
	pub fn new(options: CharEncoderOptions) -> Result<Self> {
		let schema = LabelSchema::from_json(&read(&options.label_schema_path)?).map_err(channel_error)?;
		let config = CharConfig {
			mode: options.mode,
			vocab_path: options.vocab_path.into(),
			max_units: options.max_units as usize,
			max_unit_width: options.max_unit_width as usize,
			char_ctx: options.char_ctx.unwrap_or(0) as usize,
			label_set: options.label_set,
		};
		Ok(Self {
			inner: RustCharEncoder::new(&config, &schema).map_err(sampler_error)?,
		})
	}

	#[napi]
	pub fn encode_batch(&self, rows: Vec<SampledRow>) -> Result<EncodedChars> {
		let rows = rows
			.into_iter()
			.enumerate()
			.map(|(i, r)| to_row(r, i))
			.collect::<Result<Vec<_>>>()?;
		let batch = self.inner.encode_batch(&rows).map_err(sampler_error)?;
		Ok(EncodedChars {
			rows: batch.rows as u32,
			max_units: batch.max_units as u32,
			max_unit_width: batch.max_unit_width as u32,
			char_ids: BigInt64Array::new(batch.char_ids),
			attention_mask: BigInt64Array::new(batch.attention_mask),
			labels: BigInt64Array::new(batch.labels),
		})
	}
}

/// One row group's admitted rows over the requested columns: a string column under `strings`, a list-of-strings
/// column under `lists`.
#[napi(object)]
pub struct SplitColumnChunk {
	pub rows: u32,
	pub strings: HashMap<String, Vec<Option<String>>>,
	pub lists: HashMap<String, Vec<Option<Vec<String>>>>,
}

/// Every row a split holds over a few columns, in file and row order, one row group at a time.
#[napi]
pub struct SplitColumns {
	inner: RustSplitColumns,
}

#[napi]
impl SplitColumns {
	#[napi(constructor)]
	pub fn new(config: String, split: String, columns: Vec<String>) -> Result<Self> {
		Ok(Self {
			inner: RustSplitColumns::open(&self::config(&config)?, &split, &columns).map_err(sampler_error)?,
		})
	}

	/// The files the split lists.
	#[napi(getter)]
	pub fn files(&self) -> u32 {
		self.inner.files() as u32
	}

	/// The next row group's admitted rows, or null after the last file.
	#[napi]
	pub fn next_chunk(&mut self) -> Result<Option<SplitColumnChunk>> {
		let Some(chunk) = self.inner.next_chunk().map_err(sampler_error)? else {
			return Ok(None);
		};
		let mut out = SplitColumnChunk {
			rows: chunk.rows as u32,
			strings: HashMap::new(),
			lists: HashMap::new(),
		};
		for (name, values) in chunk.columns {
			match values {
				ColumnValues::Strings(v) => {
					out.strings.insert(name, v);
				}
				ColumnValues::Lists(v) => {
					out.lists.insert(name, v);
				}
			}
		}
		Ok(Some(out))
	}
}

/// Rows per source across every file of `split`, over the rows each file's filter admits.
#[napi]
pub fn source_row_counts(config: String, split: String) -> Result<Vec<SourceCount>> {
	let parsed = self::config(&config)?;
	Ok(source_counts(
		mtf_sampler::corpus_files::source_row_counts(&parsed, &split).map_err(sampler_error)?,
	))
}

/// A weight per source, in the order the config lists them.
#[napi(object)]
pub struct SourceWeight {
	pub source: String,
	pub weight: f64,
}

/// One `source_reps` target turned into a weight.
#[napi(object)]
pub struct DerivedSourceReps {
	pub source: String,
	pub target_reps_per_row: f64,
	pub rows: i64,
	pub weight: f64,
}

#[napi(object)]
pub struct DerivedSourceWeights {
	pub merged: Vec<SourceWeight>,
	pub derived: Vec<DerivedSourceReps>,
}

fn weights(entries: Vec<SourceWeight>) -> Weights {
	Weights(entries.into_iter().map(|w| (w.source, w.weight)).collect())
}

/// `fixed` with each reps target merged in as a derived weight, and the derivation per target.
#[napi]
pub fn derive_source_weights(
	fixed: Option<Vec<SourceWeight>>,
	source_reps: Vec<SourceWeight>,
	rows_by_source: Vec<SourceCount>,
	samples: i64,
) -> Result<DerivedSourceWeights> {
	let rows: Vec<(String, u64)> = rows_by_source
		.into_iter()
		.map(|c| {
			Ok((
				c.source,
				u64::try_from(c.count).map_err(|_| input("a row count is negative"))?,
			))
		})
		.collect::<Result<_>>()?;
	let samples = u64::try_from(samples).map_err(|_| input("samples must be zero or positive"))?;
	let fixed = fixed.map(weights);
	let (merged, derived) = derive(fixed.as_ref(), &weights(source_reps), &rows, samples).map_err(sampler_error)?;
	Ok(DerivedSourceWeights {
		merged: merged
			.0
			.into_iter()
			.map(|(source, weight)| SourceWeight { source, weight })
			.collect(),
		derived: derived
			.into_iter()
			.map(
				|DerivedReps {
				     source,
				     target_reps_per_row,
				     rows,
				     weight,
				 }| DerivedSourceReps {
					source,
					target_reps_per_row,
					rows: rows as i64,
					weight,
				},
			)
			.collect(),
	})
}

/// The channel names the row encoder may emit, in its block order.
#[napi]
pub fn channel_names() -> Vec<String> {
	CHANNEL_NAMES.iter().map(|s| s.to_string()).collect()
}
