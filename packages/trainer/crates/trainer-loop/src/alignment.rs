//! `data/loader/verify.py`'s `verify_tokenizer_alignment`: the corpus/tokenizer check a supervised run makes before
//! it builds its model.
//!
//! A corpus row stores whitespace tokens beside its `raw` text, and the model reads SentencePiece pieces of `raw`.
//! The check reads the first `sample_size` rows of row group 0 of the first `train` file, without the manifest's row
//! filter, because every row a file stores must hold the invariant whichever split reads it. Each row's tokens must
//! be found in `raw` left to right, and the tokenizer must encode `raw`. A failure names the row and the file.

use crate::{fail, Result};
use mtf_channels::labels::whitespace_spans;
use mtf_core::Processor;
use mtf_sampler::batch::encode_pieces;
use mtf_sampler::columns::{column, StrColumn, StrListColumn};
use mtf_sampler::corpus_files::corpus_split_files;
use mtf_sampler::parquet_file::ParquetFile;
use mtf_sampler::SamplerConfig;

/// The columns every corpus file stores, which the check reads as the loader reads them.
const REQUIRED_COLUMNS: [&str; 5] = ["raw", "tokens", "labels", "country", "source"];

/// How many rows the check reads, `verify_tokenizer_alignment`'s `sample_size`.
pub const SAMPLE_SIZE: usize = 100;

/// Checks the first `sample_size` rows of the first `train` file against `processor`.
pub fn verify_tokenizer_alignment(sampler: &SamplerConfig, processor: &Processor, sample_size: usize) -> Result<()> {
	let files = corpus_split_files(sampler, "train")?;
	let first = files
		.first()
		.ok_or_else(|| fail!("{} lists no train parquet file", sampler.corpus_dir.display()))?;
	let path = &first.path;
	let file = ParquetFile::open(path)?;
	if file.num_row_groups() == 0 {
		return Err(fail!("{} has no row group", path.display()));
	}
	let batch = file.read_row_group(0, &REQUIRED_COLUMNS)?;
	let raw = StrColumn::new(column(&batch, "raw", path)?, "raw")?;
	let tokens = StrListColumn::new(column(&batch, "tokens", path)?, "tokens")?;
	for i in 0..sample_size.min(batch.num_rows()) {
		let text = raw
			.get(i)
			.ok_or_else(|| fail!("corpus row {i} of {} has no raw text", path.display()))?;
		let row_tokens = tokens
			.get(i)?
			.ok_or_else(|| fail!("corpus row {i} of {} has no tokens", path.display()))?;
		let chars: Vec<char> = text.chars().collect();
		let token_chars: Vec<Vec<char>> = row_tokens.iter().map(|t| t.chars().collect()).collect();
		whitespace_spans(&chars, &token_chars).map_err(|e| {
			fail!(
				"corpus tokenizer invariant broken at row {i} of {}: {e}",
				path.display()
			)
		})?;
		// A tokenizer that cannot encode the corpus fails here, before the model is built.
		encode_pieces(processor, text)?;
	}
	Ok(())
}
