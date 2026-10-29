// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Every row a split holds, over a few columns, in file and row order.
//!
//! The sampler draws a split's rows through the mixture and the country filter. An audit that asks what a split
//! contains reads every row instead: each file the manifest lists for the split, in the listing's path order, one
//! row group at a time, keeping the rows the file's `source_id` filter admits.

use crate::columns::{column, IntListColumn, StrColumn, StrListColumn};
use crate::config::SamplerConfig;
use crate::corpus_files::{corpus_split_files, CorpusFile};
use crate::error::{Error, Result};
use crate::parquet_file::ParquetFile;
use arrow_schema::DataType;
use std::collections::HashSet;

/// One column's values over a chunk of admitted rows.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnValues {
	Strings(Vec<Option<String>>),
	Lists(Vec<Option<Vec<String>>>),
	/// A list-of-integers column, such as `span_starts`.
	IntLists(Vec<Option<Vec<i64>>>),
}

/// The values of each requested column over one row group's admitted rows, in the requested order.
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnChunk {
	pub rows: usize,
	pub columns: Vec<(String, ColumnValues)>,
}

/// Keeps the rows whose string column `column`, uppercased, is one of `values`. A null value is not kept.
#[derive(Debug, Clone, PartialEq)]
pub struct KeepRows {
	pub column: String,
	pub values: HashSet<String>,
}

/// The rows of one split over the requested string, list-of-string and list-of-integer columns.
pub struct SplitColumns {
	files: Vec<CorpusFile>,
	columns: Vec<String>,
	keep: Option<KeepRows>,
	file_index: usize,
	current: Option<(ParquetFile, usize)>,
}

impl SplitColumns {
	/// Lists `split` and refuses a split with no file, since an absent split is not a split holding zero rows.
	pub fn open(config: &SamplerConfig, split: &str, columns: &[String]) -> Result<Self> {
		Self::open_keeping(config, split, columns, None)
	}

	/// [`Self::open`], keeping only the rows `keep` admits, so a caller that wants a few countries of a large split
	/// converts only their rows.
	pub fn open_keeping(
		config: &SamplerConfig,
		split: &str,
		columns: &[String],
		keep: Option<KeepRows>,
	) -> Result<Self> {
		let files = corpus_split_files(config, split)?;
		if files.is_empty() {
			return Err(Error::Input(format!(
				"no parquet files resolved for the {split} split of {}",
				config.corpus_dir.display()
			)));
		}
		Ok(Self {
			files,
			columns: columns.to_vec(),
			keep,
			file_index: 0,
			current: None,
		})
	}

	/// The files the split lists.
	pub fn files(&self) -> usize {
		self.files.len()
	}

	/// The next row group's admitted rows, or `None` after the last file.
	pub fn next_chunk(&mut self) -> Result<Option<ColumnChunk>> {
		loop {
			if self.current.is_none() {
				let Some(file) = self.files.get(self.file_index) else {
					return Ok(None);
				};
				self.current = Some((ParquetFile::open(&file.path)?, 0));
			}
			let file = &self.files[self.file_index];
			let (parquet, row_group) = self.current.as_mut().expect("opened above");
			if *row_group >= parquet.num_row_groups() {
				self.current = None;
				self.file_index += 1;
				continue;
			}
			let mut read: Vec<&str> = self.columns.iter().map(String::as_str).collect();
			if file.filter.is_some() && !read.contains(&"source_id") {
				read.push("source_id");
			}
			if let Some(keep) = &self.keep {
				if !read.contains(&keep.column.as_str()) {
					read.push(keep.column.as_str());
				}
			}
			let batch = parquet.read_row_group(*row_group, &read)?;
			*row_group += 1;
			let mut admitted: Vec<usize> = match &file.filter {
				Some(filter) => {
					let ids = StrColumn::new(column(&batch, "source_id", &file.path)?, "source_id")?;
					(0..batch.num_rows()).filter(|&i| filter.admits(ids.get(i))).collect()
				}
				None => (0..batch.num_rows()).collect(),
			};
			if let Some(keep) = &self.keep {
				let values = StrColumn::new(column(&batch, &keep.column, &file.path)?, &keep.column)?;
				admitted.retain(|&i| values.get(i).is_some_and(|v| keep.values.contains(&v.to_uppercase())));
			}
			if admitted.is_empty() {
				continue;
			}
			let mut out = Vec::with_capacity(self.columns.len());
			for name in &self.columns {
				let array = column(&batch, name, &file.path)?;
				let values = match array.data_type() {
					DataType::List(item) | DataType::LargeList(item) if item.data_type().is_integer() => {
						let list = IntListColumn::new(array, name)?;
						ColumnValues::IntLists(admitted.iter().map(|&i| list.get(i)).collect::<Result<_>>()?)
					}
					DataType::List(_) | DataType::LargeList(_) => {
						let list = StrListColumn::new(array, name)?;
						ColumnValues::Lists(admitted.iter().map(|&i| list.get(i)).collect::<Result<_>>()?)
					}
					_ => {
						let strings = StrColumn::new(array, name)?;
						ColumnValues::Strings(admitted.iter().map(|&i| strings.get(i).map(str::to_owned)).collect())
					}
				};
				out.push((name.clone(), values));
			}
			return Ok(Some(ColumnChunk {
				rows: admitted.len(),
				columns: out,
			}));
		}
	}
}
