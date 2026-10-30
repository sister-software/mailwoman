// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Time reading row groups over the columns the sampler reads, one row group at a time.
//!
//! The input is a JSON list of `[path, row_group]` pairs; the output is the milliseconds per row group and the rows
//! read. The deleted Python trainer's pyarrow reader is timed over the same list for the comparison the encoder reference
//! records.
//!
//! Usage: `cargo run --release -p mtf-sampler --example read_profile -- <pairs.json>`

use mtf_sampler::parquet_file::ParquetFile;
use std::time::Instant;

fn main() {
	let path = std::env::args().nth(1).expect("usage: read_profile <pairs.json>");
	let pairs: Vec<(String, usize)> =
		serde_json::from_str(&std::fs::read_to_string(&path).expect("readable pairs")).expect("JSON pairs");
	let columns = [
		"raw",
		"tokens",
		"labels",
		"country",
		"source",
		"span_starts",
		"span_ends",
		"span_tags",
		"source_id",
	];
	let mut rows = 0usize;
	let started = Instant::now();
	for (file, group) in &pairs {
		let parquet = ParquetFile::open(std::path::Path::new(file)).expect("an open file");
		rows += parquet
			.read_row_group(*group, &columns)
			.expect("a row group")
			.num_rows();
	}
	let seconds = started.elapsed().as_secs_f64();
	println!(
		"{{\"row_groups\": {}, \"rows\": {rows}, \"ms_per_row_group\": {:.2}, \"ms_per_1k_rows\": {:.3}}}",
		pairs.len(),
		1e3 * seconds / pairs.len() as f64,
		1e6 * seconds / rows as f64
	);
}
