// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! One parquet file, read by row group or in batches over the named columns.

use crate::error::{Error, Result};
use arrow_array::{RecordBatch, RecordBatchReader};
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder};
use parquet::arrow::ProjectionMask;
use std::fs::File;
use std::path::{Path, PathBuf};

/// An open parquet file and its footer.
pub struct ParquetFile {
	path: PathBuf,
	file: File,
	meta: ArrowReaderMetadata,
}

fn io(path: &Path, e: impl std::fmt::Display) -> Error {
	Error::Io(format!("{}: {e}", path.display()))
}

impl ParquetFile {
	/// Opens the file and reads its footer. A missing path is an error naming it.
	pub fn open(path: &Path) -> Result<Self> {
		let file = File::open(path).map_err(|e| io(path, e))?;
		let meta = ArrowReaderMetadata::load(&file, ArrowReaderOptions::default()).map_err(|e| io(path, e))?;
		Ok(Self {
			path: path.to_owned(),
			file,
			meta,
		})
	}

	pub fn num_row_groups(&self) -> usize {
		self.meta.metadata().num_row_groups()
	}

	/// The row count the footer records.
	pub fn num_rows(&self) -> usize {
		self.meta.metadata().file_metadata().num_rows() as usize
	}

	pub fn has_column(&self, name: &str) -> bool {
		self.meta.schema().fields().iter().any(|f| f.name() == name)
	}

	fn builder(&self, columns: &[&str]) -> Result<ParquetRecordBatchReaderBuilder<File>> {
		let schema = self.meta.schema();
		let mut roots = Vec::with_capacity(columns.len());
		for &name in columns {
			let index = schema
				.fields()
				.iter()
				.position(|f| f.name() == name)
				.ok_or_else(|| Error::Input(format!("{} has no {name:?} column", self.path.display())))?;
			roots.push(index);
		}
		let file = self.file.try_clone().map_err(|e| io(&self.path, e))?;
		let builder = ParquetRecordBatchReaderBuilder::new_with_metadata(file, self.meta.clone());
		let mask = ProjectionMask::roots(builder.parquet_schema(), roots);
		Ok(builder.with_projection(mask))
	}

	/// One row group over `columns`, as a single batch.
	pub fn read_row_group(&self, row_group: usize, columns: &[&str]) -> Result<RecordBatch> {
		let rows = self.meta.metadata().row_group(row_group).num_rows() as usize;
		let reader = self
			.builder(columns)?
			.with_row_groups(vec![row_group])
			.with_batch_size(rows.max(1))
			.build()
			.map_err(|e| io(&self.path, e))?;
		let schema = reader.schema();
		let batches = reader
			.collect::<std::result::Result<Vec<_>, _>>()
			.map_err(|e| io(&self.path, e))?;
		match batches.len() {
			1 => Ok(batches.into_iter().next().expect("one batch")),
			_ => arrow_select::concat::concat_batches(&schema, &batches).map_err(|e| io(&self.path, e)),
		}
	}

	/// Every row over `columns`, in record batches of at most `batch_size` rows.
	pub fn batches(
		&self,
		columns: &[&str],
		batch_size: usize,
	) -> Result<impl Iterator<Item = Result<RecordBatch>> + use<'_>> {
		let reader = self
			.builder(columns)?
			.with_batch_size(batch_size)
			.build()
			.map_err(|e| io(&self.path, e))?;
		Ok(reader.map(move |b| b.map_err(|e| io(&self.path, e))))
	}
}
