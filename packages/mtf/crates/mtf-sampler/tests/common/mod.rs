// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Fixture corpora written the way the corpus writers write them: each parquet file with the `<stem>.RECORD.json`
//! beside it, which the loader verifies a manifest-less file against.

#![allow(dead_code)]

use arrow_array::builder::{Int32Builder, ListBuilder, StringBuilder};
use arrow_array::{ArrayRef, RecordBatch};
use mtf_sampler::corpus_files::file_sha256;
use mtf_sampler::{Row, SamplerConfig, SpanTriple};
use parquet::arrow::ArrowWriter;
use parquet::file::properties::WriterProperties;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Each entry is `(raw, [(token, tag)])`; the spans and BIO labels derive from the pairs, so the fixture cannot
/// store an offset that disagrees with its own text.
pub const TEMPLATES: [(&str, &[(&str, &str)]); 3] = [
	(
		"{n} N Main St, Springfield IL 62704",
		&[
			("{n}", "house_number"),
			("N", "street_prefix"),
			("Main", "street"),
			("St,", "street_suffix"),
			("Springfield", "locality"),
			("IL", "region"),
			("62704", "postcode"),
		],
	),
	(
		"{n} Rue de la Paix, 75002 Paris",
		&[
			("{n}", "house_number"),
			("Rue", "street"),
			("de", "street"),
			("la", "street"),
			("Paix,", "street"),
			("75002", "postcode"),
			("Paris", "locality"),
		],
	),
	(
		"Flat {n}, 12 High Street, London SW1A 2AA",
		&[
			("Flat", "unit"),
			("{n},", "unit"),
			("12", "house_number"),
			("High", "street"),
			("Street,", "street"),
			("London", "locality"),
			("SW1A", "postcode"),
			("2AA", "postcode"),
		],
	),
];

/// One fixture row with its span triple derived from its tokens.
pub fn fixture_row(index: usize, country: &str, source: &str) -> Row {
	let (template, pairs) = TEMPLATES[index % TEMPLATES.len()];
	let number = (100 + index).to_string();
	tagged_row(
		&template.replace("{n}", &number),
		&pairs
			.iter()
			.map(|&(t, g)| (t.replace("{n}", &number), g))
			.collect::<Vec<_>>(),
		country,
		source,
	)
}

/// A row from its text and its `(token, tag)` pairs, with BIO labels and spans derived from them.
pub fn tagged_row(raw: &str, pairs: &[(String, &str)], country: &str, source: &str) -> Row {
	let chars: Vec<char> = raw.chars().collect();
	let mut cursor = 0usize;
	let mut previous: Option<&str> = None;
	let (mut tokens, mut labels, mut starts, mut ends, mut tags) = (vec![], vec![], vec![], vec![], vec![]);
	for (token, tag) in pairs {
		let needle: Vec<char> = token.chars().collect();
		let start = (cursor..=chars.len() - needle.len())
			.find(|&i| chars[i..i + needle.len()] == needle[..])
			.expect("the token is in the text");
		cursor = start + needle.len();
		labels.push(format!("{}-{tag}", if previous == Some(tag) { "I" } else { "B" }));
		tokens.push(token.clone());
		starts.push(start as i64);
		ends.push(cursor as i64);
		tags.push((*tag).to_owned());
		previous = Some(tag);
	}
	Row {
		raw: raw.to_owned(),
		tokens,
		labels,
		country: Some(country.to_owned()),
		source: source.to_owned(),
		spans: Some(SpanTriple { starts, ends, tags }),
	}
}

fn strings(values: impl Iterator<Item = Option<String>>) -> ArrayRef {
	let mut builder = StringBuilder::new();
	for v in values {
		builder.append_option(v);
	}
	Arc::new(builder.finish())
}

fn string_lists(values: impl Iterator<Item = Vec<String>>) -> ArrayRef {
	let mut builder = ListBuilder::new(StringBuilder::new());
	for list in values {
		for v in list {
			builder.values().append_value(v);
		}
		builder.append(true);
	}
	Arc::new(builder.finish())
}

fn int_lists(values: impl Iterator<Item = Vec<i64>>) -> ArrayRef {
	let mut builder = ListBuilder::new(Int32Builder::new());
	for list in values {
		for v in list {
			builder.values().append_value(v as i32);
		}
		builder.append(true);
	}
	Arc::new(builder.finish())
}

/// The options a fixture file is written with.
#[derive(Default, Clone)]
pub struct WriteOptions {
	/// Write the span columns.
	pub without_spans: bool,
	/// A `source_id` per row; the column is written when set.
	pub source_ids: Option<Vec<Option<String>>>,
}

/// Writes `rows` to `path` in row groups of `row_group_size` rows, with the record beside it.
pub fn write_corpus_parquet(rows: &[Row], path: &Path, row_group_size: usize, options: &WriteOptions) -> PathBuf {
	let mut columns: Vec<(&str, ArrayRef)> = vec![
		("raw", strings(rows.iter().map(|r| Some(r.raw.clone())))),
		("tokens", string_lists(rows.iter().map(|r| r.tokens.clone()))),
		("labels", string_lists(rows.iter().map(|r| r.labels.clone()))),
		("country", strings(rows.iter().map(|r| r.country.clone()))),
		("source", strings(rows.iter().map(|r| Some(r.source.clone())))),
	];
	if !options.without_spans {
		let triple = |r: &Row| r.spans.clone().expect("a span row");
		columns.push(("span_starts", int_lists(rows.iter().map(|r| triple(r).starts))));
		columns.push(("span_ends", int_lists(rows.iter().map(|r| triple(r).ends))));
		columns.push(("span_tags", string_lists(rows.iter().map(|r| triple(r).tags))));
	}
	if let Some(ids) = &options.source_ids {
		columns.push(("source_id", strings(ids.iter().cloned())));
	}
	let batch = RecordBatch::try_from_iter(columns).expect("a consistent batch");
	std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
	let file = std::fs::File::create(path).expect("create");
	let props = WriterProperties::builder()
		.set_max_row_group_row_count(Some(row_group_size))
		.build();
	let mut writer = ArrowWriter::try_new(file, batch.schema(), Some(props)).expect("writer");
	writer.write(&batch).expect("write");
	writer.close().expect("close");
	let digest = file_sha256(path).expect("hash");
	let name = path.file_name().unwrap().to_string_lossy();
	let record = path.with_file_name(format!("{}.RECORD.json", name.trim_end_matches(".parquet")));
	std::fs::write(&record, format!(r#"{{"sha256": "{digest}", "rows": {}}}"#, rows.len())).expect("record");
	path.to_owned()
}

/// The loader-split fixture: two sources, three countries, multiple row groups per file, and a mixed-source val file.
pub fn build_reference_corpus(root: &Path) -> PathBuf {
	let corpus = root.join("corpus");
	let countries = ["US", "FR", "GB"];
	let alpha: Vec<Row> = (0..48).map(|i| fixture_row(i, countries[i % 3], "alpha")).collect();
	let beta: Vec<Row> = (0..24)
		.map(|i| fixture_row(i, countries[(i + 1) % 3], "beta"))
		.collect();
	let held_out: Vec<Row> = (0..12)
		.map(|i| fixture_row(i, countries[i % 3], if i % 2 == 1 { "alpha" } else { "beta" }))
		.collect();
	let options = WriteOptions::default();
	write_corpus_parquet(&alpha[..24], &corpus.join("train/part-alpha-0.parquet"), 8, &options);
	write_corpus_parquet(&alpha[24..], &corpus.join("train/part-alpha-1.parquet"), 8, &options);
	write_corpus_parquet(&beta, &corpus.join("train/part-beta-0.parquet"), 8, &options);
	write_corpus_parquet(&held_out, &corpus.join("val/part-val-0.parquet"), 8, &options);
	corpus
}

/// The stage-3 tags, which the coarse filter accepts.
pub const ACTIVE_TAGS: [&str; 16] = [
	"country",
	"region",
	"locality",
	"dependent_locality",
	"postcode",
	"subregion",
	"cedex",
	"venue",
	"street",
	"house_number",
	"street_prefix",
	"street_suffix",
	"unit",
	"po_box",
	"intersection_a",
	"intersection_b",
];

/// A config over `corpus` from a JSON object of further settings.
pub fn config(corpus: &Path, extra: serde_json::Value) -> SamplerConfig {
	let mut value = serde_json::json!({
		"corpus_dir": corpus,
		"country_weights": {"US": 1.0, "FR": 0.6, "GB": 0.25},
		"active_tags": ACTIVE_TAGS,
	});
	for (k, v) in extra.as_object().expect("an object") {
		value[k] = v.clone();
	}
	SamplerConfig::from_json(&value.to_string()).expect("a valid config")
}

/// The path of a file under this crate's `tests/fixtures`.
pub fn fixture(name: &str) -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}
