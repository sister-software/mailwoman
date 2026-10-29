// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The `mailwoman_mtf` Python extension: the mtf tokenizer and the training-row encoder.
//!
//! `Tokenizer` loads a SentencePiece model with `mtf-core` and reports each piece's code-point range, keeping
//! the space a `▁` piece covers. `RowEncoder` holds a run's lexicons and encodes a batch of sampled rows into
//! numpy arrays: `[B, L]` int64 ids, mask and labels, and per configured channel `[B, L, D]` float32 features
//! and `[B, L]` float32 confidence. Each array owns its buffer, so `torch.from_numpy` wraps it without a copy
//! and it stays valid after later calls. `Sampler` and `TrainingBatches` stream sampled rows from `mtf-sampler`, and
//! `CharEncoder` encodes them for the character path; the Python trainer reads its rows through them until the
//! Rust trainer replaces it.

use mtf_channels::anchor::AnchorLookup;
use mtf_channels::code_units;
use mtf_channels::encoder::{require_whole_triple, CHANNEL_NAMES};
use mtf_channels::finders::{PostcodeShapes, PostcodeSyntax, RegexFinders};
use mtf_channels::gazetteer::Lexicon;
use mtf_channels::labels::LabelTable;
use mtf_channels::{AnchorMode, Encoder, EncoderConfig, Error, Finders, Lexicons, Piece, RowInput};
use mtf_core::Processor;
use numpy::{PyArray1, PyArrayMethods};
use pyo3::exceptions::{PyIndexError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use std::collections::HashMap;
use std::sync::Arc;

fn to_py(error: Error) -> PyErr {
	match error {
		Error::Finder(_) => PyRuntimeError::new_err(error.to_string()),
		_ => PyValueError::new_err(error.to_string()),
	}
}

mod sampler;

use mtf_sampler::batch::{encode_pieces, PieceTuple};

/// A SentencePiece unigram model loaded by `mtf-core`.
#[pyclass(frozen, module = "mailwoman_mtf")]
struct Tokenizer {
	processor: Arc<Processor>,
}

#[pymethods]
impl Tokenizer {
	#[new]
	fn new(model: &[u8]) -> PyResult<Self> {
		let processor = Processor::from_model_proto(model).map_err(|e| PyValueError::new_err(e.to_string()))?;
		Ok(Self {
			processor: Arc::new(processor),
		})
	}

	#[getter]
	fn vocab_size(&self) -> usize {
		self.processor.vocab_size()
	}

	#[getter]
	fn pad_id(&self) -> i64 {
		self.processor.special_ids().pad
	}

	#[getter]
	fn unk_id(&self) -> i64 {
		self.processor.special_ids().unk
	}

	#[getter]
	fn bos_id(&self) -> i64 {
		self.processor.special_ids().bos
	}

	#[getter]
	fn eos_id(&self) -> i64 {
		self.processor.special_ids().eos
	}

	/// Each piece of `raw` as `(id, piece, char_begin, char_end)` in code points.
	fn encode(&self, py: Python<'_>, raw: &str) -> PyResult<Vec<PieceTuple>> {
		let processor = self.processor.clone();
		py.detach(|| encode_pieces(&processor, raw)).map_err(to_py)
	}

	/// The text of piece `id`.
	fn id_to_piece(&self, id: i64) -> PyResult<String> {
		u32::try_from(id)
			.ok()
			.and_then(|id| self.processor.piece(id))
			.map(str::to_string)
			.ok_or_else(|| PyIndexError::new_err(format!("piece id {id} is outside the vocabulary")))
	}

	/// The ID of the piece whose text is `piece`, or the unknown piece's ID.
	fn piece_to_id(&self, piece: &str) -> u32 {
		self.processor.piece_to_id(piece)
	}
}

fn read(path: &str) -> PyResult<String> {
	std::fs::read_to_string(path).map_err(|e| PyValueError::new_err(format!("cannot read {path}: {e}")))
}

fn lexicon(path: Option<&str>) -> PyResult<Option<Lexicon>> {
	path.map(|p| Lexicon::from_json(&read(p)?, p).map_err(to_py))
		.transpose()
}

/// One extracted row, owned so the encoding can run without the interpreter lock.
struct OwnedRow {
	raw: String,
	tokens: Vec<String>,
	labels: Vec<String>,
	starts: Option<Vec<i64>>,
	ends: Option<Vec<i64>>,
	tags: Option<Vec<String>>,
}

fn optional<'py, T: FromPyObjectOwned<'py>>(row: &Bound<'py, PyDict>, key: &str) -> PyResult<Option<T>> {
	match row.get_item(key)? {
		None => Ok(None),
		Some(value) if value.is_none() => Ok(None),
		Some(value) => value.extract().map(Some).map_err(Into::into),
	}
}

fn required<'py, T: FromPyObjectOwned<'py>>(row: &Bound<'py, PyDict>, key: &str, index: usize) -> PyResult<T> {
	optional(row, key)?.ok_or_else(|| PyValueError::new_err(format!("row {index}: the row has no {key:?}")))
}

fn owned_rows(rows: &Bound<'_, PyList>) -> PyResult<Vec<OwnedRow>> {
	rows.iter()
		.enumerate()
		.map(|(index, row)| {
			let row = row.cast_into::<PyDict>()?;
			Ok(OwnedRow {
				raw: required(&row, "raw", index)?,
				tokens: required(&row, "tokens", index)?,
				labels: required(&row, "labels", index)?,
				starts: optional(&row, "span_starts")?,
				ends: optional(&row, "span_ends")?,
				tags: optional(&row, "span_tags")?,
			})
		})
		.collect()
}

/// A run's row encoder: the tokenizer, the label table, the lexicons and the span finders.
#[pyclass(frozen, module = "mailwoman_mtf")]
struct RowEncoder {
	processor: Option<Arc<Processor>>,
	config: EncoderConfig,
	lexicons: Lexicons,
	finders: RegexFinders,
}

impl RowEncoder {
	fn encoder(&self) -> PyResult<Encoder<'_>> {
		Encoder::new(&self.config, &self.lexicons, Some(&self.finders as &dyn Finders)).map_err(to_py)
	}
}

#[pymethods]
impl RowEncoder {
	#[new]
	#[pyo3(signature = (
		tokenizer,
		*,
		max_length,
		label_to_id,
		active_tags,
		ignore_index,
		locale_countries,
		postcode_shapes_path,
		postcode_syntax_path,
		pad_id = None,
		anchor_lookup_path = None,
		anchor_paint_mode = "gold",
		gazetteer_lexicon_path = None,
		gazetteer_choreography = false,
		country_lexicon_path = None,
		street_type_lexicon_path = None,
		locality_surface_lexicon_path = None,
		code_units = false,
	))]
	#[allow(clippy::too_many_arguments)]
	fn new(
		py: Python<'_>,
		tokenizer: Option<&Tokenizer>,
		max_length: usize,
		label_to_id: HashMap<String, i64>,
		active_tags: Vec<String>,
		ignore_index: i64,
		locale_countries: Vec<String>,
		postcode_shapes_path: &str,
		postcode_syntax_path: &str,
		pad_id: Option<i64>,
		anchor_lookup_path: Option<&str>,
		anchor_paint_mode: &str,
		gazetteer_lexicon_path: Option<&str>,
		gazetteer_choreography: bool,
		country_lexicon_path: Option<&str>,
		street_type_lexicon_path: Option<&str>,
		locality_surface_lexicon_path: Option<&str>,
		code_units: bool,
	) -> PyResult<Self> {
		let anchor_mode = match anchor_paint_mode {
			"gold" => AnchorMode::Gold,
			"shaped" => AnchorMode::Shaped,
			other => {
				return Err(PyValueError::new_err(format!(
					"anchor_paint_mode {other:?} is not \"gold\" or \"shaped\""
				)))
			}
		};
		let pad_id = match (pad_id, tokenizer) {
			(Some(id), _) => id,
			(None, Some(t)) => t.processor.special_ids().pad,
			(None, None) => return Err(PyValueError::new_err("pad_id is required without a tokenizer")),
		};
		let labels = LabelTable::new(&label_to_id, &active_tags, ignore_index).map_err(to_py)?;
		let anchor_text = anchor_lookup_path.map(read).transpose()?;
		let anchor = match (anchor_text, anchor_lookup_path) {
			(Some(text), Some(path)) => Some(py.detach(|| AnchorLookup::from_json(&text, path)).map_err(to_py)?),
			_ => None,
		};
		let finders = RegexFinders {
			shapes: PostcodeShapes::from_record(&read(postcode_shapes_path)?, postcode_shapes_path).map_err(to_py)?,
			syntax: PostcodeSyntax::from_json(&read(postcode_syntax_path)?, postcode_syntax_path).map_err(to_py)?,
		};
		let encoder = Self {
			processor: tokenizer.map(|t| t.processor.clone()),
			config: EncoderConfig {
				max_length,
				pad_id,
				anchor_mode,
				gazetteer_choreography,
				code_units,
			},
			lexicons: Lexicons {
				labels,
				locales: locale_countries,
				anchor,
				gazetteer: lexicon(gazetteer_lexicon_path)?,
				country: lexicon(country_lexicon_path)?,
				street_type: lexicon(street_type_lexicon_path)?,
				locality_surface: lexicon(locality_surface_lexicon_path)?,
			},
			finders,
		};
		encoder.encoder()?;
		Ok(encoder)
	}

	/// Each configured channel's feature width, in the order `encode_batch` emits them.
	#[getter]
	fn channel_dims(&self) -> PyResult<Vec<(&'static str, usize)>> {
		Ok(self.encoder()?.channel_dims())
	}

	/// The batch's arrays. Each row is a dict with `raw`, `tokens`, `labels` and optionally the span triple.
	///
	/// `pieces`, when given, holds each row's `(id, char_begin, char_end)` pieces in place of the tokenizer's.
	#[pyo3(signature = (rows, pieces = None))]
	fn encode_batch<'py>(
		&self,
		py: Python<'py>,
		rows: &Bound<'py, PyList>,
		pieces: Option<Vec<Vec<(u32, usize, usize)>>>,
	) -> PyResult<Bound<'py, PyDict>> {
		let owned = owned_rows(rows)?;
		if let Some(p) = &pieces {
			if p.len() != owned.len() {
				return Err(PyValueError::new_err(format!(
					"pieces lists {} rows for a batch of {}",
					p.len(),
					owned.len()
				)));
			}
		}
		if pieces.is_none() && self.processor.is_none() {
			return Err(PyValueError::new_err(
				"encode_batch needs pieces when the encoder has no tokenizer",
			));
		}
		let encoder = self.encoder()?;
		let batch = py
			.detach(|| {
				let inputs = owned
					.iter()
					.enumerate()
					.map(|(index, row)| {
						let spans = require_whole_triple(
							row.starts.as_deref(),
							row.ends.as_deref(),
							row.tags.as_deref(),
							&row.raw,
						)
						.map_err(|e| e.at_row(index))?;
						Ok(RowInput {
							raw: &row.raw,
							tokens: &row.tokens,
							labels: &row.labels,
							spans,
						})
					})
					.collect::<Result<Vec<_>, Error>>()?;
				encoder.encode_rows(&inputs, |index, raw| match &pieces {
					Some(p) => Ok(p[index]
						.iter()
						.map(|&(id, begin, end)| Piece { id, begin, end })
						.collect()),
					None => {
						let processor = self.processor.as_ref().expect("checked above");
						Ok(encode_pieces(processor, raw)?
							.into_iter()
							.map(|(id, _, begin, end)| Piece { id, begin, end })
							.collect())
					}
				})
			})
			.map_err(to_py)?;

		let (n, l) = (batch.rows, batch.max_length);
		let out = PyDict::new(py);
		out.set_item("input_ids", PyArray1::from_vec(py, batch.input_ids).reshape([n, l])?)?;
		out.set_item(
			"attention_mask",
			PyArray1::from_vec(py, batch.attention_mask).reshape([n, l])?,
		)?;
		out.set_item("labels", PyArray1::from_vec(py, batch.labels).reshape([n, l])?)?;
		for channel in batch.channels {
			let features = PyArray1::from_vec(py, channel.features).reshape([n, l, channel.dim])?;
			out.set_item(format!("{}_features", channel.name), features)?;
			out.set_item(
				format!("{}_confidence", channel.name),
				PyArray1::from_vec(py, channel.confidence).reshape([n, l])?,
			)?;
		}
		Ok(out)
	}

	/// The postcode-shaped character ranges the shaped anchor paints in `raw`.
	fn shaped_postcode_spans(&self, py: Python<'_>, raw: &str) -> PyResult<Vec<(usize, usize)>> {
		py.detach(|| self.finders.shaped_spans(raw)).map_err(to_py)
	}
}

/// The postcode-shape record compiled with Python's `re` semantics.
#[pyclass(frozen, module = "mailwoman_mtf", name = "PostcodeShapes")]
struct PyPostcodeShapes(PostcodeShapes);

#[pymethods]
impl PyPostcodeShapes {
	#[new]
	fn new(path: &str) -> PyResult<Self> {
		Ok(Self(PostcodeShapes::from_record(&read(path)?, path).map_err(to_py)?))
	}

	/// The compiled shapes' labels, in priority order.
	#[getter]
	fn labels(&self) -> Vec<String> {
		self.0.labels().into_iter().map(str::to_string).collect()
	}

	/// Non-overlapping matches as `(start, end, kind, priority)`, in start order.
	fn collect_matches(&self, text: &str) -> PyResult<Vec<(usize, usize, String, usize)>> {
		Ok(self
			.0
			.collect_matches(text)
			.map_err(to_py)?
			.into_iter()
			.map(|m| (m.start, m.end, m.kind, m.priority))
			.collect())
	}
}

/// Each country's postcode syntax, compiled case-insensitively.
#[pyclass(frozen, module = "mailwoman_mtf", name = "PostcodeSyntax")]
struct PyPostcodeSyntax(PostcodeSyntax);

#[pymethods]
impl PyPostcodeSyntax {
	#[new]
	fn new(path: &str) -> PyResult<Self> {
		Ok(Self(PostcodeSyntax::from_json(&read(path)?, path).map_err(to_py)?))
	}

	/// How many countries' postcode syntax accepts `value`.
	fn accepting(&self, value: &str) -> PyResult<usize> {
		let chars: Vec<char> = value.chars().collect();
		self.0.accepting(&chars).map_err(to_py)
	}
}

/// The `(start, end)` of every code unit in `text`.
#[pyfunction]
fn segment_code_units(text: &str) -> Vec<(usize, usize)> {
	let chars: Vec<char> = text.chars().collect();
	code_units::segment(&chars)
}

#[pymodule]
fn mailwoman_mtf(m: &Bound<'_, PyModule>) -> PyResult<()> {
	m.add_class::<Tokenizer>()?;
	m.add_class::<RowEncoder>()?;
	m.add_class::<PyPostcodeShapes>()?;
	m.add_class::<PyPostcodeSyntax>()?;
	m.add_function(wrap_pyfunction!(segment_code_units, m)?)?;
	sampler::register(m)?;
	m.add("UNICODE_VERSION", mtf_channels::python_text::UNICODE_VERSION)?;
	m.add("CHANNEL_NAMES", CHANNEL_NAMES.to_vec())?;
	m.add("CODE_UNIT_FEATURE_DIM", code_units::CODE_UNIT_FEATURE_DIM)?;
	Ok(())
}
