// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Encode a batch of sampled rows into the packed arrays a training step reads.
//!
//! The blocks run in a fixed order because one reads another's output: the gazetteer's near-postcode
//! suppression reads the anchor confidence the anchor block already fitted. Every channel lands on the pieces
//! the labels use and is fitted to `max_length`, so the batch packs into `[rows, max_length]` and
//! `[rows, max_length, dim]` arrays.

use crate::anchor::{AnchorLookup, AnchorPainter};
use crate::channel::{Channel, Piece};
use crate::code_units::{self, CodeUnit};
use crate::error::{quote, Error};
use crate::gazetteer::{self, Lexicon, COUNTRY_FEATURE_DIM};
use crate::labels::{char_labels_from_tokens, whitespace_spans, LabelTable, Spans};

/// Where the anchor channel takes its postcode ranges from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorMode {
	/// The row's gold postcode labels: its `postcode` spans, or its `B-`/`I-postcode` tokens.
	Gold,
	/// The postcode-shaped ranges a shape finder detects in the raw text, as inference paints them.
	Shaped,
}

/// The settings every row of a run is encoded under.
#[derive(Debug, Clone)]
pub struct EncoderConfig {
	pub max_length: usize,
	pub pad_id: i64,
	pub anchor_mode: AnchorMode,
	pub gazetteer_choreography: bool,
	pub code_units: bool,
}

/// Every lexicon and table a run's channels read, loaded once.
pub struct Lexicons {
	pub labels: LabelTable,
	pub locales: Vec<String>,
	pub anchor: Option<AnchorLookup>,
	pub gazetteer: Option<Lexicon>,
	pub country: Option<Lexicon>,
	pub street_type: Option<Lexicon>,
	pub locality_surface: Option<Lexicon>,
}

/// The span finders a configuration may need, which the `finders` feature implements with regexes.
pub trait Finders: Sync {
	/// The postcode-shaped character ranges in `raw`, in start order.
	fn shaped_spans(&self, raw: &str) -> Result<Vec<(usize, usize)>, Error>;
	/// The code units of `raw` with their acceptance counts.
	fn code_units(&self, raw: &[char]) -> Result<Vec<CodeUnit>, Error>;
}

/// One sampled row: its text, its whitespace tokens and BIO labels, and its span triple when it has one.
pub struct RowInput<'a> {
	pub raw: &'a str,
	pub tokens: &'a [String],
	pub labels: &'a [String],
	pub spans: Option<Spans<'a>>,
}

/// The channel names, in the order the encoder writes them.
pub const CHANNEL_NAMES: [&str; 6] = [
	"anchor",
	"gazetteer",
	"country",
	"street_type",
	"locality_surface",
	"code_unit",
];

/// One channel packed over the batch: features `[rows * max_length * dim]` and confidence `[rows * max_length]`.
pub struct PackedChannel {
	pub name: &'static str,
	pub dim: usize,
	pub features: Vec<f32>,
	pub confidence: Vec<f32>,
}

/// A batch packed row-major: each of `input_ids`, `attention_mask` and `labels` holds `rows * max_length` values.
pub struct EncodedBatch {
	pub rows: usize,
	pub max_length: usize,
	pub input_ids: Vec<i64>,
	pub attention_mask: Vec<i64>,
	pub labels: Vec<i64>,
	pub channels: Vec<PackedChannel>,
}

/// The encoder for one configuration.
pub struct Encoder<'a> {
	pub config: &'a EncoderConfig,
	pub lexicons: &'a Lexicons,
	pub finders: Option<&'a dyn Finders>,
	/// The anchor table's posterior keys mapped to locale slots, computed once.
	slots: Vec<Option<usize>>,
}

/// One row's channels before packing, in `CHANNEL_NAMES` order with `None` for an unconfigured channel.
type RowChannels = [Option<Channel>; 6];

/// One row's `input_ids`, `attention_mask`, `labels` and channels.
type EncodedRow = (Vec<i64>, Vec<i64>, Vec<i64>, RowChannels);

impl<'a> Encoder<'a> {
	/// Prepares an encoder, refusing a configuration that needs a finder it was not given.
	pub fn new(
		config: &'a EncoderConfig,
		lexicons: &'a Lexicons,
		finders: Option<&'a dyn Finders>,
	) -> Result<Self, Error> {
		let shaped = lexicons.anchor.is_some() && config.anchor_mode == AnchorMode::Shaped;
		if finders.is_none() && (shaped || config.code_units) {
			return Err(Error::Input(
				"the shaped anchor and the code-unit channel need span finders, which this encoder lacks".into(),
			));
		}
		let slots = lexicons
			.anchor
			.as_ref()
			.map(|a| a.locale_slots(&lexicons.locales))
			.unwrap_or_default();
		Ok(Self {
			config,
			lexicons,
			finders,
			slots,
		})
	}

	/// The channels this configuration emits, with their widths, in packing order.
	pub fn channel_dims(&self) -> Vec<(&'static str, usize)> {
		let l = self.lexicons;
		let dims = [
			l.anchor.as_ref().map(|_| l.locales.len() + 2),
			l.gazetteer.as_ref().map(|g| g.feature_dim),
			l.country.as_ref().map(|_| COUNTRY_FEATURE_DIM),
			l.street_type.as_ref().map(|g| g.feature_dim),
			l.locality_surface.as_ref().map(|g| g.feature_dim),
			self.config.code_units.then_some(code_units::CODE_UNIT_FEATURE_DIM),
		];
		CHANNEL_NAMES
			.iter()
			.zip(dims)
			.filter_map(|(&name, dim)| dim.map(|d| (name, d)))
			.collect()
	}

	fn finders(&self) -> &dyn Finders {
		self.finders
			.expect("Encoder::new refuses a configuration that needs finders without them")
	}

	/// The postcode ranges the anchor paints for a row.
	fn anchor_ranges(
		&self,
		row: &RowInput,
		raw: &[char],
		span_ranges: Option<&[(usize, usize)]>,
	) -> Result<Vec<(usize, usize)>, Error> {
		if self.config.anchor_mode == AnchorMode::Shaped {
			return self.finders().shaped_spans(row.raw);
		}
		if let (Some(spans), Some(ranges)) = (&row.spans, span_ranges) {
			return Ok(ranges
				.iter()
				.zip(spans.tags)
				.filter(|(_, tag)| tag.as_str() == "postcode")
				.map(|(&r, _)| r)
				.collect());
		}
		let tokens: Vec<Vec<char>> = row.tokens.iter().map(|t| t.chars().collect()).collect();
		let token_spans = whitespace_spans(raw, &tokens)?;
		let labels = row.labels;
		let mut out = Vec::new();
		let mut i = 0;
		while i < labels.len() {
			if labels[i].starts_with('B') && labels[i].ends_with("-postcode") {
				let mut j = i + 1;
				while j < labels.len() && labels[j] == "I-postcode" {
					j += 1;
				}
				let span = |k: usize| {
					token_spans
						.get(k)
						.copied()
						.ok_or_else(|| Error::Row(format!("label {k} has no token in {}", quote(raw))))
				};
				out.push((span(i)?.0, span(j - 1)?.1));
				i = j;
			} else {
				i += 1;
			}
		}
		Ok(out)
	}

	/// One row's ids, mask, labels and channels, each fitted to `max_length`.
	fn encode_row(&self, row: &RowInput, pieces: &[Piece]) -> Result<EncodedRow, Error> {
		let raw: Vec<char> = row.raw.chars().collect();
		let max_length = self.config.max_length;
		let table = &self.lexicons.labels;

		let span_ranges = match &row.spans {
			Some(spans) => Some(spans.validated(&raw)?),
			None => None,
		};
		let char_labels = match (&row.spans, &span_ranges) {
			(Some(spans), Some(ranges)) => spans.char_labels(&raw, ranges, table),
			_ => {
				let tokens: Vec<Vec<char>> = row.tokens.iter().map(|t| t.chars().collect()).collect();
				char_labels_from_tokens(&raw, &tokens, row.labels, table)?
			}
		};
		let mut label_ids = table.project(&raw, &char_labels, pieces);
		let mut ids: Vec<i64> = pieces.iter().map(|p| p.id as i64).collect();
		ids.truncate(max_length);
		label_ids.truncate(max_length);
		let mut attention = vec![1i64; ids.len()];
		ids.resize(max_length, self.config.pad_id);
		attention.resize(max_length, 0);
		label_ids.resize(max_length, table.ignore_index);

		let mut channels: RowChannels = Default::default();
		let fit = |mut c: Channel| {
			c.fit(max_length);
			c
		};
		let l = self.lexicons;
		if let Some(lookup) = &l.anchor {
			let painter = AnchorPainter {
				lookup,
				slots: &self.slots,
				locales: l.locales.len(),
			};
			let ranges = self.anchor_ranges(row, &raw, span_ranges.as_deref())?;
			channels[0] = Some(fit(painter.paint(&raw, &ranges, pieces)));
		}
		if let Some(lexicon) = &l.gazetteer {
			let mut channel = gazetteer::paint(&raw, pieces, lexicon);
			if self.config.gazetteer_choreography {
				if let Some(anchor) = &channels[0] {
					gazetteer::suppress_near_postcode(&mut channel, &anchor.confidence, 1);
				}
			}
			channels[1] = Some(fit(channel));
		}
		if let Some(lexicon) = &l.country {
			channels[2] = Some(fit(gazetteer::country(&raw, pieces, lexicon)));
		}
		if let Some(lexicon) = &l.street_type {
			channels[3] = Some(fit(gazetteer::paint(&raw, pieces, lexicon)));
		}
		if let Some(lexicon) = &l.locality_surface {
			channels[4] = Some(fit(gazetteer::paint(&raw, pieces, lexicon)));
		}
		if self.config.code_units {
			let units = self.finders().code_units(&raw)?;
			channels[5] = Some(fit(code_units::channel(
				&raw,
				&code_units::piece_ranges(pieces),
				&units,
			)));
		}
		Ok((ids, attention, label_ids, channels))
	}

	/// Encodes a batch. `pieces_of` tokenizes one row's text; an error names the row's batch index.
	pub fn encode_rows<F>(&self, rows: &[RowInput], mut pieces_of: F) -> Result<EncodedBatch, Error>
	where
		F: FnMut(usize, &str) -> Result<Vec<Piece>, Error>,
	{
		let max_length = self.config.max_length;
		let n = rows.len();
		let mut batch = EncodedBatch {
			rows: n,
			max_length,
			input_ids: Vec::with_capacity(n * max_length),
			attention_mask: Vec::with_capacity(n * max_length),
			labels: Vec::with_capacity(n * max_length),
			channels: self
				.channel_dims()
				.into_iter()
				.map(|(name, dim)| PackedChannel {
					name,
					dim,
					features: Vec::with_capacity(n * max_length * dim),
					confidence: Vec::with_capacity(n * max_length),
				})
				.collect(),
		};
		for (index, row) in rows.iter().enumerate() {
			let pieces = pieces_of(index, row.raw).map_err(|e| e.at_row(index))?;
			let (ids, attention, labels, channels) = self.encode_row(row, &pieces).map_err(|e| e.at_row(index))?;
			batch.input_ids.extend_from_slice(&ids);
			batch.attention_mask.extend_from_slice(&attention);
			batch.labels.extend_from_slice(&labels);
			let mut packed = batch.channels.iter_mut();
			for channel in channels.into_iter().flatten() {
				let target = packed.next().expect("channel_dims lists every painted channel");
				target.features.extend(channel.features.iter().map(|&v| v as f32));
				target.confidence.extend(channel.confidence.iter().map(|&v| v as f32));
			}
		}
		Ok(batch)
	}
}

/// The span triple of a row when all three parts are present, `None` when none is, and an error otherwise.
///
/// A partial triple means a corpus writer emitted two of three columns, and falling back to the token path
/// would encode the row against labels the writer had already replaced.
pub fn require_whole_triple<'a>(
	starts: Option<&'a [i64]>,
	ends: Option<&'a [i64]>,
	tags: Option<&'a [String]>,
	raw: &str,
) -> Result<Option<Spans<'a>>, Error> {
	match (starts, ends, tags) {
		(None, None, None) => Ok(None),
		(Some(starts), Some(ends), Some(tags)) => Ok(Some(Spans { starts, ends, tags })),
		(s, e, t) => Err(Error::Row(format!(
			"span_starts/span_ends/span_tags must be supplied together (got starts={} ends={} tags={}) in {raw:?}",
			s.is_some(),
			e.is_some(),
			t.is_some()
		))),
	}
}
