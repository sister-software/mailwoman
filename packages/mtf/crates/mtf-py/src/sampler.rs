// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The sampler's Python classes: `Sampler`, `TrainingBatches` and `CharEncoder`, with the corpus helpers the
//! trainer's launch steps call.
//!
//! Each sampled row reaches Python as a dict with `raw`, `tokens`, `labels`, `country` and `source`, and the span
//! triple when its file stores one, which is the row shape the Python sampler yielded. Sampling runs without the
//! interpreter lock.

use mtf_channels::label_schema::LabelSet;
use mtf_sampler::char_path::CharEncoder as RustCharEncoder;
use mtf_sampler::source_reps::{derive_source_weights as derive, DerivedReps};
use mtf_sampler::{
	CancelToken, CharConfig, Error, Row, Sampler as RustSampler, SamplerConfig, SpanTriple,
	TrainingBatches as RustTrainingBatches, Weights,
};
use numpy::{PyArray1, PyArrayMethods};
use pyo3::exceptions::{PyKeyboardInterrupt, PyOSError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

fn to_py(error: Error) -> PyErr {
	match error {
		Error::Io(_) => PyOSError::new_err(error.to_string()),
		Error::Cancelled => PyKeyboardInterrupt::new_err(error.to_string()),
		_ => PyValueError::new_err(error.to_string()),
	}
}

fn config(json: &str) -> PyResult<SamplerConfig> {
	SamplerConfig::from_json(json).map_err(to_py)
}

fn row_dict<'py>(py: Python<'py>, row: &Row) -> PyResult<Bound<'py, PyDict>> {
	let out = PyDict::new(py);
	out.set_item("raw", &row.raw)?;
	out.set_item("tokens", &row.tokens)?;
	out.set_item("labels", &row.labels)?;
	out.set_item("country", row.country.as_deref())?;
	out.set_item("source", &row.source)?;
	if let Some(spans) = &row.spans {
		out.set_item("span_starts", &spans.starts)?;
		out.set_item("span_ends", &spans.ends)?;
		out.set_item("span_tags", &spans.tags)?;
	}
	Ok(out)
}

fn rows_list<'py>(py: Python<'py>, rows: &[Row]) -> PyResult<Bound<'py, PyList>> {
	let items = rows.iter().map(|r| row_dict(py, r)).collect::<PyResult<Vec<_>>>()?;
	PyList::new(py, items)
}

fn optional<'py, T: FromPyObjectOwned<'py>>(row: &Bound<'py, PyDict>, key: &str) -> PyResult<Option<T>> {
	match row.get_item(key)? {
		None => Ok(None),
		Some(value) if value.is_none() => Ok(None),
		Some(value) => value.extract().map(Some).map_err(Into::into),
	}
}

fn dict_row(row: &Bound<'_, PyDict>, index: usize) -> PyResult<Row> {
	let required = |key: &str| PyValueError::new_err(format!("row {index}: the row has no {key:?}"));
	let starts: Option<Vec<i64>> = optional(row, "span_starts")?;
	let ends: Option<Vec<i64>> = optional(row, "span_ends")?;
	let tags: Option<Vec<String>> = optional(row, "span_tags")?;
	let spans = match (starts, ends, tags) {
		(None, None, None) => None,
		(Some(starts), Some(ends), Some(tags)) => Some(SpanTriple { starts, ends, tags }),
		_ => {
			return Err(PyValueError::new_err(format!(
				"row {index}: span_starts/span_ends/span_tags must be supplied together"
			)))
		}
	};
	Ok(Row {
		raw: optional(row, "raw")?.ok_or_else(|| required("raw"))?,
		tokens: optional(row, "tokens")?.ok_or_else(|| required("tokens"))?,
		labels: optional(row, "labels")?.ok_or_else(|| required("labels"))?,
		country: optional(row, "country")?,
		source: optional(row, "source")?.unwrap_or_default(),
		spans,
	})
}

/// One split's sampled rows, in the order the trainer reads them.
#[pyclass(module = "mailwoman_mtf")]
struct Sampler {
	inner: RustSampler,
	cancel: CancelToken,
}

#[pymethods]
impl Sampler {
	/// Opens `split` with a generator seeded as `random.Random(seed)`. `config` is the sampler's JSON configuration.
	#[new]
	#[pyo3(signature = (config, split, seed, row_limit = None))]
	fn new(py: Python<'_>, config: &str, split: &str, seed: i64, row_limit: Option<u64>) -> PyResult<Self> {
		let parsed = self::config(config)?;
		let cancel = CancelToken::default();
		let inner = py
			.detach(|| RustSampler::open_with(&parsed, split, i128::from(seed), row_limit, cancel.clone(), None))
			.map_err(to_py)?;
		Ok(Self { inner, cancel })
	}

	fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
		slf
	}

	fn __next__<'py>(&mut self, py: Python<'py>) -> PyResult<Option<Bound<'py, PyDict>>> {
		let inner = &mut self.inner;
		match py.detach(|| inner.next_row()).map_err(to_py)? {
			Some(row) => row_dict(py, &row).map(Some),
			None => Ok(None),
		}
	}

	/// The next `count` rows, fewer at exhaustion, and an empty list once no row remains.
	fn next_rows<'py>(&mut self, py: Python<'py>, count: usize) -> PyResult<Bound<'py, PyList>> {
		let inner = &mut self.inner;
		let rows = py
			.detach(|| inner.next_batch(count))
			.map_err(to_py)?
			.unwrap_or_default();
		rows_list(py, &rows)
	}

	/// Stops the stream; the next call raises `KeyboardInterrupt`.
	fn cancel(&self) {
		self.cancel.cancel();
	}

	/// The rows yielded so far.
	#[getter]
	fn yielded(&self) -> u64 {
		self.inner.yielded()
	}

	/// The rows skipped so far because a span end runs past the code-point length.
	#[getter]
	fn astral_skipped(&self) -> u64 {
		self.inner.astral_skipped()
	}

	/// Each postcode-move draw so far, as `moved` or under its skip reason.
	#[getter]
	fn postcode_move_outcomes(&self) -> Vec<(&'static str, u64)> {
		self.inner.postcode_move_outcomes()
	}
}

/// The train split's batches without end, reopened with `seed + epoch` for epochs 1, 2, ….
#[pyclass(module = "mailwoman_mtf")]
struct TrainingBatches {
	inner: RustTrainingBatches,
	cancel: CancelToken,
}

#[pymethods]
impl TrainingBatches {
	/// `skip_batches` batches are sampled and dropped first, so a resumed run continues where it stopped.
	#[new]
	#[pyo3(signature = (config, *, batch_size, seed, row_limit = None, skip_batches = 0))]
	fn new(config: &str, batch_size: usize, seed: i64, row_limit: Option<u64>, skip_batches: u64) -> PyResult<Self> {
		if batch_size == 0 {
			return Err(PyValueError::new_err("batch_size must be positive"));
		}
		let cancel = CancelToken::default();
		Ok(Self {
			inner: RustTrainingBatches::new(
				self::config(config)?,
				batch_size,
				i128::from(seed),
				row_limit,
				skip_batches,
				cancel.clone(),
			),
			cancel,
		})
	}

	fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
		slf
	}

	fn __next__<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
		let inner = &mut self.inner;
		let rows = py.detach(|| inner.next_batch()).map_err(to_py)?;
		rows_list(py, &rows)
	}

	/// The epoch the last batch came from, counted from 1.
	#[getter]
	fn epoch(&self) -> u64 {
		self.inner.epoch()
	}

	fn cancel(&self) {
		self.cancel.cancel();
	}
}

/// The character path's encoder: per-unit character windows for the CharCNN front end.
#[pyclass(frozen, module = "mailwoman_mtf")]
struct CharEncoder {
	inner: RustCharEncoder,
}

#[pymethods]
impl CharEncoder {
	/// `tags` and `bio_labels` are the label set's, in model output order; a label's index is its id.
	#[new]
	#[pyo3(signature = (*, mode, vocab_path, max_units, max_unit_width, char_ctx, label_set, tags, bio_labels, ignore_index))]
	#[allow(clippy::too_many_arguments)]
	fn new(
		mode: String,
		vocab_path: String,
		max_units: usize,
		max_unit_width: usize,
		char_ctx: usize,
		label_set: String,
		tags: Vec<String>,
		bio_labels: Vec<String>,
		ignore_index: i64,
	) -> PyResult<Self> {
		let config = CharConfig {
			mode,
			vocab_path: vocab_path.into(),
			max_units,
			max_unit_width,
			char_ctx,
			label_set,
		};
		let set = LabelSet { tags, bio_labels };
		Ok(Self {
			inner: RustCharEncoder::with_label_set(&config, &set, ignore_index).map_err(to_py)?,
		})
	}

	/// The batch's `char_ids` `[B, S, W]`, `attention_mask` and `labels` `[B, S]`, and an all-zero `input_ids`
	/// `[B, S]` the char-embedding model never reads, each int64.
	fn encode_batch<'py>(&self, py: Python<'py>, rows: &Bound<'py, PyList>) -> PyResult<Bound<'py, PyDict>> {
		let rows = rows
			.iter()
			.enumerate()
			.map(|(i, r)| dict_row(&r.cast_into::<PyDict>()?, i))
			.collect::<PyResult<Vec<_>>>()?;
		let batch = py.detach(|| self.inner.encode_batch(&rows)).map_err(to_py)?;
		let (n, s, w) = (batch.rows, batch.max_units, batch.max_unit_width);
		let out = PyDict::new(py);
		out.set_item("input_ids", PyArray1::from_vec(py, vec![0i64; n * s]).reshape([n, s])?)?;
		out.set_item(
			"attention_mask",
			PyArray1::from_vec(py, batch.attention_mask).reshape([n, s])?,
		)?;
		out.set_item("labels", PyArray1::from_vec(py, batch.labels).reshape([n, s])?)?;
		out.set_item("char_ids", PyArray1::from_vec(py, batch.char_ids).reshape([n, s, w])?)?;
		Ok(out)
	}
}

/// Rows per source across every file of `split`, over the rows each file's filter admits.
#[pyfunction]
fn source_row_counts(py: Python<'_>, config: &str, split: &str) -> PyResult<Vec<(String, u64)>> {
	let parsed = self::config(config)?;
	py.detach(|| mtf_sampler::corpus_files::source_row_counts(&parsed, split))
		.map_err(to_py)
}

/// `fixed` with each reps target merged in as a derived weight, and `(source, reps, rows, weight)` per target.
#[pyfunction]
#[pyo3(signature = (fixed, source_reps, rows_by_source, samples))]
#[allow(clippy::type_complexity)]
fn derive_source_weights(
	fixed: Option<Vec<(String, f64)>>,
	source_reps: Vec<(String, f64)>,
	rows_by_source: Vec<(String, u64)>,
	samples: u64,
) -> PyResult<(Vec<(String, f64)>, Vec<(String, f64, u64, f64)>)> {
	let fixed = fixed.map(Weights);
	let (merged, derived) = derive(fixed.as_ref(), &Weights(source_reps), &rows_by_source, samples).map_err(to_py)?;
	Ok((
		merged.0,
		derived
			.into_iter()
			.map(
				|DerivedReps {
				     source,
				     target_reps_per_row,
				     rows,
				     weight,
				 }| (source, target_reps_per_row, rows, weight),
			)
			.collect(),
	))
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
	m.add_class::<Sampler>()?;
	m.add_class::<TrainingBatches>()?;
	m.add_class::<CharEncoder>()?;
	m.add_function(wrap_pyfunction!(source_row_counts, m)?)?;
	m.add_function(wrap_pyfunction!(derive_source_weights, m)?)?;
	Ok(())
}
