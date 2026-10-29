// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Typed views of the Arrow columns a corpus file stores, read one row at a time.
//!
//! A corpus writer may store a string column as `Utf8`, `LargeUtf8` or `Utf8View` and a list column as `List` or
//! `LargeList`; the views accept each, so a row reads the same whatever the writer chose.

use crate::error::{Error, Result};
use arrow_array::cast::AsArray;
use arrow_array::types::{Int32Type, Int64Type};
use arrow_array::{Array, ArrayRef, RecordBatch};
use arrow_schema::DataType;

/// A string column.
#[derive(Clone)]
pub enum StrColumn {
	Utf8(arrow_array::StringArray),
	Large(arrow_array::LargeStringArray),
	View(arrow_array::StringViewArray),
}

impl StrColumn {
	pub fn new(array: &ArrayRef, name: &str) -> Result<Self> {
		match array.data_type() {
			DataType::Utf8 => Ok(Self::Utf8(array.as_string::<i32>().clone())),
			DataType::LargeUtf8 => Ok(Self::Large(array.as_string::<i64>().clone())),
			DataType::Utf8View => Ok(Self::View(array.as_string_view().clone())),
			other => Err(Error::Input(format!(
				"column {name:?} is {other}, expected a string column"
			))),
		}
	}

	pub fn len(&self) -> usize {
		match self {
			Self::Utf8(a) => a.len(),
			Self::Large(a) => a.len(),
			Self::View(a) => a.len(),
		}
	}

	/// The value at `i`, or `None` for a null.
	pub fn get(&self, i: usize) -> Option<&str> {
		match self {
			Self::Utf8(a) => a.is_valid(i).then(|| a.value(i)),
			Self::Large(a) => a.is_valid(i).then(|| a.value(i)),
			Self::View(a) => a.is_valid(i).then(|| a.value(i)),
		}
	}
}

/// The values of a list column, flattened, with each row's offsets.
#[derive(Clone)]
struct ListShape {
	offsets: Vec<usize>,
	nulls: Option<arrow_buffer::NullBuffer>,
}

fn list_shape(array: &ArrayRef, name: &str) -> Result<(ListShape, ArrayRef)> {
	match array.data_type() {
		DataType::List(_) => {
			let list = array.as_list::<i32>();
			let offsets = list.value_offsets().iter().map(|&o| o as usize).collect();
			Ok((
				ListShape {
					offsets,
					nulls: list.nulls().cloned(),
				},
				list.values().clone(),
			))
		}
		DataType::LargeList(_) => {
			let list = array.as_list::<i64>();
			let offsets = list.value_offsets().iter().map(|&o| o as usize).collect();
			Ok((
				ListShape {
					offsets,
					nulls: list.nulls().cloned(),
				},
				list.values().clone(),
			))
		}
		other => Err(Error::Input(format!(
			"column {name:?} is {other}, expected a list column"
		))),
	}
}

impl ListShape {
	fn range(&self, i: usize) -> Option<std::ops::Range<usize>> {
		if self.nulls.as_ref().is_some_and(|n| n.is_null(i)) {
			return None;
		}
		Some(self.offsets[i]..self.offsets[i + 1])
	}
}

/// A list-of-strings column.
#[derive(Clone)]
pub struct StrListColumn {
	shape: ListShape,
	values: StrColumn,
	name: String,
}

impl StrListColumn {
	pub fn new(array: &ArrayRef, name: &str) -> Result<Self> {
		let (shape, values) = list_shape(array, name)?;
		Ok(Self {
			shape,
			values: StrColumn::new(&values, name)?,
			name: name.to_owned(),
		})
	}

	/// The list at `i`, `Ok(None)` for a null list, and an error for a null element.
	pub fn get(&self, i: usize) -> Result<Option<Vec<String>>> {
		let Some(range) = self.shape.range(i) else {
			return Ok(None);
		};
		range
			.map(|j| {
				self.values
					.get(j)
					.map(str::to_owned)
					.ok_or_else(|| Error::Row(format!("column {:?} holds a null element", self.name)))
			})
			.collect::<Result<Vec<_>>>()
			.map(Some)
	}
}

/// A list-of-integers column.
#[derive(Clone)]
pub struct IntListColumn {
	shape: ListShape,
	values: IntValues,
	name: String,
}

#[derive(Clone)]
enum IntValues {
	I32(arrow_array::Int32Array),
	I64(arrow_array::Int64Array),
}

impl IntListColumn {
	pub fn new(array: &ArrayRef, name: &str) -> Result<Self> {
		let (shape, values) = list_shape(array, name)?;
		let values = match values.data_type() {
			DataType::Int32 => IntValues::I32(values.as_primitive::<Int32Type>().clone()),
			DataType::Int64 => IntValues::I64(values.as_primitive::<Int64Type>().clone()),
			other => {
				return Err(Error::Input(format!(
					"column {name:?} holds {other}, expected 32- or 64-bit integers"
				)))
			}
		};
		Ok(Self {
			shape,
			values,
			name: name.to_owned(),
		})
	}

	/// The list at `i`, `Ok(None)` for a null list, and an error for a null element.
	pub fn get(&self, i: usize) -> Result<Option<Vec<i64>>> {
		let Some(range) = self.shape.range(i) else {
			return Ok(None);
		};
		let null = || Error::Row(format!("column {:?} holds a null element", self.name));
		range
			.map(|j| match &self.values {
				IntValues::I32(a) => a.is_valid(j).then(|| i64::from(a.value(j))).ok_or_else(null),
				IntValues::I64(a) => a.is_valid(j).then(|| a.value(j)).ok_or_else(null),
			})
			.collect::<Result<Vec<_>>>()
			.map(Some)
	}
}

/// The column `name` of a batch, or an error naming the file.
pub fn column<'a>(batch: &'a RecordBatch, name: &str, path: &std::path::Path) -> Result<&'a ArrayRef> {
	batch
		.column_by_name(name)
		.ok_or_else(|| Error::Input(format!("{} has no {name:?} column", path.display())))
}
