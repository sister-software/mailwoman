// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Reading an Overture GeoParquet theme, such as a synced `theme=buildings/` directory, the way the basemaps fork's
//! `pm:overture_buildings` source reads it.
//!
//! Every `.parquet` file under the root is read, in path order. Each row becomes one [`Record`]:
//! - Its WKB `geometry` column becomes the geometry, converted from longitude and latitude to world coordinates.
//! - Each top-level column of a string, boolean or number type becomes a tag, written as Java's `toString` writes the
//!   value, so `has_parts` reads `true` and a height of 12 reads `12.0`. Null values give no tag.
//! - Each `key=value` directory on the file's path becomes a tag too, as hive partitioning does, including the root
//!   itself when it is a partition such as `theme=buildings/`. The release keeps `theme` and `type` only in the path.
//!
//! The `sources` list gives one tag per dataset, `sources:<dataset>`, holding that dataset's `record_id`, such as
//! `sources:OpenStreetMap=w783697382@1`. A dataset's entry for the whole feature, with no `property`, wins over its
//! entries for single properties. Other struct and list columns, such as `names` and `bbox`, give no tags.
//!
//! With map bounds, a row group whose `bbox` statistics lie outside them is skipped, and so is each row whose `bbox`
//! lies outside them.
//!
//! Row groups are read in parallel on rayon's threads, so `each` runs on several threads at once and sees rows out of
//! order. Each record's id is its row's position across the whole input, counted from 1 in path order, which does not
//! depend on the order rows are read in.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use arrow_array::cast::AsArray;
use arrow_array::types::{
	Float32Type, Float64Type, Int16Type, Int32Type, Int64Type, Int8Type, UInt16Type, UInt32Type, UInt64Type, UInt8Type,
};
use arrow_array::{Array, ArrayRef, RecordBatch, StructArray};
use arrow_schema::DataType;
use hrt_osm::Tags;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ParquetRecordBatchReaderBuilder};
use parquet::arrow::ProjectionMask;
use parquet::file::metadata::RowGroupMetaData;
use parquet::file::statistics::Statistics;
use rayon::prelude::*;

use crate::java_text::double_to_string;
use crate::wkb::parse_wkb;
use crate::{lon_lat_to_world, Record};

const GEOMETRY: &str = "geometry";
const BBOX: &str = "bbox";
const SOURCES: &str = "sources";

/// The `sources:<dataset>` tags of a row: each dataset's `record_id`, preferring its entry with no `property`.
fn source_tags(sources: &ArrayRef, row: usize) -> Vec<(String, String)> {
	if sources.is_null(row) {
		return Vec::new();
	}
	let entries = match sources.data_type() {
		DataType::List(_) => sources.as_list::<i32>().value(row),
		DataType::LargeList(_) => sources.as_list::<i64>().value(row),
		_ => return Vec::new(),
	};
	let Some(entries) = entries.as_struct_opt() else {
		return Vec::new();
	};
	let (Some(dataset), Some(record_id)) = (entries.column_by_name("dataset"), entries.column_by_name("record_id"))
	else {
		return Vec::new();
	};
	let property = entries.column_by_name("property");
	let mut tags: Vec<(String, String, bool)> = Vec::new();
	for entry in 0..entries.len() {
		let (Some(dataset), Some(record_id)) = (cell_text(dataset, entry), cell_text(record_id, entry)) else {
			continue;
		};
		let whole = property.is_none_or(|property| cell_text(property, entry).is_none_or(|text| text.is_empty()));
		let key = format!("{SOURCES}:{dataset}");
		match tags.iter_mut().find(|(existing, _, _)| *existing == key) {
			Some(found) if whole && !found.2 => *found = (key, record_id, true),
			Some(_) => {}
			None => tags.push((key, record_id, whole)),
		}
	}
	tags.into_iter().map(|(key, value, _)| (key, value)).collect()
}

fn parquet_error(error: impl std::error::Error + Send + Sync + 'static) -> io::Error {
	io::Error::other(error)
}

/// Every `.parquet` file at or under `root`, in path order.
pub fn parquet_files(root: &Path) -> io::Result<Vec<PathBuf>> {
	if root.is_file() {
		return Ok(vec![root.to_path_buf()]);
	}
	let mut files = Vec::new();
	let mut directories = vec![root.to_path_buf()];
	while let Some(directory) = directories.pop() {
		for entry in std::fs::read_dir(&directory)? {
			let path = entry?.path();
			if path.is_dir() {
				directories.push(path);
			} else if path.extension().is_some_and(|extension| extension == "parquet") {
				files.push(path);
			}
		}
	}
	files.sort();
	Ok(files)
}

/// The `key=value` directory names on `file`'s path, as hive partitioning reads them.
///
/// The root given to [`read`] can itself be a partition, such as a synced `theme=buildings/` directory, so every
/// directory on the path counts, not only those below the root.
fn hive_tags(file: &Path) -> Vec<(String, String)> {
	let Some(parent) = file.parent() else {
		return Vec::new();
	};
	parent
		.components()
		.filter_map(|component| {
			let text = component.as_os_str().to_str()?;
			let (key, value) = text.split_once('=')?;
			Some((key.to_owned(), value.to_owned()))
		})
		.collect()
}

/// One row group to read, with the id of its first row.
struct Unit {
	file: usize,
	row_group: usize,
	first_id: i64,
}

/// A value's minimum and maximum from a float or double column's statistics.
fn min_max(statistics: Option<&Statistics>) -> Option<(f64, f64)> {
	match statistics? {
		Statistics::Float(values) => Some((f64::from(*values.min_opt()?), f64::from(*values.max_opt()?))),
		Statistics::Double(values) => Some((*values.min_opt()?, *values.max_opt()?)),
		_ => None,
	}
}

/// Whether a row group's `bbox` statistics may meet `[west, south, east, north]`. A row group without them is kept.
fn row_group_meets(row_group: &RowGroupMetaData, [west, south, east, north]: [f64; 4]) -> bool {
	let column = |name: &str| {
		row_group
			.columns()
			.iter()
			.find(|column| column.column_path().string() == name)
			.and_then(|column| min_max(column.statistics()))
	};
	let (Some((xmin, _)), Some((_, xmax)), Some((ymin, _)), Some((_, ymax))) = (
		column("bbox.xmin"),
		column("bbox.xmax"),
		column("bbox.ymin"),
		column("bbox.ymax"),
	) else {
		return true;
	};
	xmin <= east && xmax >= west && ymin <= north && ymax >= south
}

/// A number from a float or double array, or `None` where it is null.
fn number_at(array: &dyn Array, row: usize) -> Option<f64> {
	if array.is_null(row) {
		return None;
	}
	match array.data_type() {
		DataType::Float32 => Some(f64::from(array.as_primitive::<Float32Type>().value(row))),
		DataType::Float64 => Some(array.as_primitive::<Float64Type>().value(row)),
		_ => None,
	}
}

/// The `bbox` struct's `[xmin, ymin, xmax, ymax]` for a row, or `None` when the row or a field lacks one.
fn row_bbox(bbox: &StructArray, row: usize) -> Option<[f64; 4]> {
	if bbox.is_null(row) {
		return None;
	}
	let field = |name: &str| number_at(bbox.column_by_name(name)?.as_ref(), row);
	Some([field("xmin")?, field("ymin")?, field("xmax")?, field("ymax")?])
}

/// A cell of a tag column as Java's `toString` writes it, or `None` for a null or a type that gives no tag.
fn cell_text(array: &ArrayRef, row: usize) -> Option<String> {
	if array.is_null(row) {
		return None;
	}
	Some(match array.data_type() {
		DataType::Utf8 => array.as_string::<i32>().value(row).to_owned(),
		DataType::LargeUtf8 => array.as_string::<i64>().value(row).to_owned(),
		DataType::Utf8View => array.as_string_view().value(row).to_owned(),
		DataType::Boolean => array.as_boolean().value(row).to_string(),
		DataType::Int8 => array.as_primitive::<Int8Type>().value(row).to_string(),
		DataType::Int16 => array.as_primitive::<Int16Type>().value(row).to_string(),
		DataType::Int32 => array.as_primitive::<Int32Type>().value(row).to_string(),
		DataType::Int64 => array.as_primitive::<Int64Type>().value(row).to_string(),
		DataType::UInt8 => array.as_primitive::<UInt8Type>().value(row).to_string(),
		DataType::UInt16 => array.as_primitive::<UInt16Type>().value(row).to_string(),
		DataType::UInt32 => array.as_primitive::<UInt32Type>().value(row).to_string(),
		DataType::UInt64 => array.as_primitive::<UInt64Type>().value(row).to_string(),
		DataType::Float32 => array.as_primitive::<Float32Type>().value(row).to_string(),
		DataType::Float64 => double_to_string(array.as_primitive::<Float64Type>().value(row)),
		_ => return None,
	})
}

/// Whether a column of this type becomes a tag.
fn is_tag_type(data_type: &DataType) -> bool {
	matches!(
		data_type,
		DataType::Utf8
			| DataType::LargeUtf8
			| DataType::Utf8View
			| DataType::Boolean
			| DataType::Int8
			| DataType::Int16
			| DataType::Int32
			| DataType::Int64
			| DataType::UInt8
			| DataType::UInt16
			| DataType::UInt32
			| DataType::UInt64
			| DataType::Float32
			| DataType::Float64
	)
}

/// The WKB bytes of a row's geometry, or `None` where it is null.
fn wkb_at(array: &ArrayRef, row: usize) -> Option<&[u8]> {
	if array.is_null(row) {
		return None;
	}
	match array.data_type() {
		DataType::Binary => Some(array.as_binary::<i32>().value(row)),
		DataType::LargeBinary => Some(array.as_binary::<i64>().value(row)),
		DataType::BinaryView => Some(array.as_binary_view().value(row)),
		_ => None,
	}
}

struct Opened {
	path: PathBuf,
	metadata: ArrowReaderMetadata,
	hive: Vec<(String, String)>,
	/// The file's stem, the record's source layer when the path gives no `type`.
	layer: String,
}

fn read_batch(
	batch: &RecordBatch,
	opened: &Opened,
	first_id: i64,
	bounds: Option<[f64; 4]>,
	each: &(impl Fn(Record) + Sync),
) -> io::Result<()> {
	let schema = batch.schema();
	let geometry = batch
		.column_by_name(GEOMETRY)
		.ok_or_else(|| io::Error::other(format!("{} has no geometry column", opened.path.display())))?;
	let bbox = batch.column_by_name(BBOX).and_then(|column| column.as_struct_opt());
	let sources = batch.column_by_name(SOURCES);
	let tag_columns: Vec<(&str, &ArrayRef)> = schema
		.fields()
		.iter()
		.zip(batch.columns())
		.filter(|(field, _)| field.name() != GEOMETRY && is_tag_type(field.data_type()))
		.map(|(field, column)| (field.name().as_str(), column))
		.collect();
	for row in 0..batch.num_rows() {
		if let (Some([west, south, east, north]), Some(bbox)) = (bounds, bbox) {
			if let Some([xmin, ymin, xmax, ymax]) = row_bbox(bbox, row) {
				if xmin > east || xmax < west || ymin > north || ymax < south {
					continue;
				}
			}
		}
		let Some(wkb) = wkb_at(geometry, row) else {
			continue;
		};
		let parsed = parse_wkb(wkb)
			.map_err(|error| io::Error::other(format!("{} row {row}: {}", opened.path.display(), error.0)))?;
		let mut tags = Vec::with_capacity(opened.hive.len() + tag_columns.len());
		tags.extend(opened.hive.iter().cloned());
		for (name, column) in &tag_columns {
			if let Some(text) = cell_text(column, row) {
				tags.push(((*name).to_owned(), text));
			}
		}
		if let Some(sources) = sources {
			tags.extend(source_tags(sources, row));
		}
		each(Record {
			id: first_id + row as i64,
			layer: opened.layer.clone(),
			tags: Tags(tags),
			geometry: lon_lat_to_world(&parsed),
		});
	}
	Ok(())
}

/// Reads every row of the GeoParquet files under `root`, keeping those whose `bbox` meets `bounds`
/// (`[west, south, east, north]` degrees) when given, and returns the number of rows in the files read.
pub fn read(root: &Path, bounds: Option<[f64; 4]>, each: impl Fn(Record) + Sync) -> io::Result<u64> {
	let mut opened = Vec::new();
	for path in parquet_files(root)? {
		let metadata = ArrowReaderMetadata::load(&File::open(&path)?, Default::default()).map_err(parquet_error)?;
		let hive = hive_tags(&path);
		let layer = hive
			.iter()
			.find(|(key, _)| key == "type")
			.map(|(_, value)| value.clone())
			.or_else(|| path.file_stem().and_then(|stem| stem.to_str()).map(str::to_owned))
			.unwrap_or_default();
		opened.push(Opened {
			path,
			metadata,
			hive,
			layer,
		});
	}
	let mut units = Vec::new();
	let mut next_id = 1i64;
	for (file, opened) in opened.iter().enumerate() {
		for (row_group, meta) in opened.metadata.metadata().row_groups().iter().enumerate() {
			if bounds.is_none_or(|bounds| row_group_meets(meta, bounds)) {
				units.push(Unit {
					file,
					row_group,
					first_id: next_id,
				});
			}
			next_id += meta.num_rows();
		}
	}
	units
		.par_iter()
		.with_max_len(1)
		.try_for_each(|unit| -> io::Result<()> {
			let opened = &opened[unit.file];
			let arrow_schema = opened.metadata.schema();
			let roots: Vec<usize> = arrow_schema
				.fields()
				.iter()
				.enumerate()
				.filter(|(_, field)| {
					field.name() == GEOMETRY
						|| field.name() == BBOX
						|| field.name() == SOURCES
						|| is_tag_type(field.data_type())
				})
				.map(|(index, _)| index)
				.collect();
			let mask = ProjectionMask::roots(opened.metadata.parquet_schema(), roots);
			let reader =
				ParquetRecordBatchReaderBuilder::new_with_metadata(File::open(&opened.path)?, opened.metadata.clone())
					.with_row_groups(vec![unit.row_group])
					.with_projection(mask)
					.with_batch_size(8192)
					.build()
					.map_err(parquet_error)?;
			let mut first_id = unit.first_id;
			for batch in reader {
				let batch = batch.map_err(parquet_error)?;
				read_batch(&batch, opened, first_id, bounds, &each)?;
				first_id += batch.num_rows() as i64;
			}
			Ok(())
		})?;
	Ok((next_id - 1) as u64)
}

#[cfg(test)]
mod tests {
	use super::*;
	use arrow_array::{BinaryArray, BooleanArray, Float32Array, Float64Array, Int32Array, StringArray};
	use arrow_schema::{Field, Fields, Schema};
	use parquet::arrow::ArrowWriter;
	use parquet::file::properties::WriterProperties;
	use std::sync::Arc;

	fn square_wkb(x: f64, y: f64) -> Vec<u8> {
		let mut bytes = vec![1u8];
		bytes.extend_from_slice(&3u32.to_le_bytes());
		bytes.extend_from_slice(&1u32.to_le_bytes());
		bytes.extend_from_slice(&5u32.to_le_bytes());
		for (dx, dy) in [(0.0, 0.0), (0.001, 0.0), (0.001, 0.001), (0.0, 0.001), (0.0, 0.0)] {
			bytes.extend_from_slice(&(x + dx).to_le_bytes());
			bytes.extend_from_slice(&(y + dy).to_le_bytes());
		}
		bytes
	}

	/// Writes rows at the given longitudes, with latitude 10, to `path` in row groups of two rows.
	fn write_buildings(path: &Path, lons: &[f64]) {
		let bbox_fields = Fields::from(vec![
			Field::new("xmin", DataType::Float32, false),
			Field::new("xmax", DataType::Float32, false),
			Field::new("ymin", DataType::Float32, false),
			Field::new("ymax", DataType::Float32, false),
		]);
		let schema = Arc::new(Schema::new(vec![
			Field::new("id", DataType::Utf8, false),
			Field::new(GEOMETRY, DataType::Binary, false),
			Field::new(BBOX, DataType::Struct(bbox_fields.clone()), false),
			Field::new("height", DataType::Float64, true),
			Field::new("num_floors", DataType::Int32, true),
			Field::new("has_parts", DataType::Boolean, true),
		]));
		let floats = |values: Vec<f32>| Arc::new(Float32Array::from(values)) as ArrayRef;
		let bbox = StructArray::new(
			bbox_fields,
			vec![
				floats(lons.iter().map(|&x| x as f32).collect()),
				floats(lons.iter().map(|&x| (x + 0.001) as f32).collect()),
				floats(vec![10.0; lons.len()]),
				floats(vec![10.001; lons.len()]),
			],
			None,
		);
		let wkb: Vec<Vec<u8>> = lons.iter().map(|&x| square_wkb(x, 10.0)).collect();
		let columns: Vec<ArrayRef> = vec![
			Arc::new(StringArray::from(
				(0..lons.len()).map(|index| format!("id-{index}")).collect::<Vec<_>>(),
			)),
			Arc::new(BinaryArray::from(wkb.iter().map(Vec::as_slice).collect::<Vec<_>>())),
			Arc::new(bbox),
			Arc::new(Float64Array::from(
				(0..lons.len())
					.map(|index| (index % 2 == 0).then_some(12.0))
					.collect::<Vec<_>>(),
			)),
			Arc::new(Int32Array::from(vec![Some(4); lons.len()])),
			Arc::new(BooleanArray::from(vec![Some(true); lons.len()])),
		];
		let batch = RecordBatch::try_new(schema.clone(), columns).unwrap();
		let properties = WriterProperties::builder().set_max_row_group_row_count(Some(2)).build();
		let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema, Some(properties)).unwrap();
		writer.write(&batch).unwrap();
		writer.close().unwrap();
	}

	#[test]
	fn rows_become_records_with_hive_and_column_tags() {
		let dir = tempfile::tempdir().unwrap();
		let typed = dir.path().join("theme=buildings").join("type=building");
		std::fs::create_dir_all(&typed).unwrap();
		write_buildings(&typed.join("part-0.parquet"), &[1.0, 2.0, 3.0]);
		let records = std::sync::Mutex::new(Vec::new());
		// The root is the theme's own directory, as a build reads a synced `theme=buildings/`; its `theme` still counts.
		let root = dir.path().join("theme=buildings");
		let rows = read(&root, None, |record| records.lock().unwrap().push(record)).unwrap();
		let mut records = records.into_inner().unwrap();
		records.sort_by_key(|record| record.id);
		assert_eq!(rows, 3);
		assert_eq!(records.iter().map(|record| record.id).collect::<Vec<_>>(), [1, 2, 3]);
		let first = &records[0];
		assert_eq!(first.layer, "building");
		let tag = |record: &Record, key: &str| {
			record
				.tags
				.0
				.iter()
				.find(|(name, _)| name == key)
				.map(|(_, value)| value.clone())
		};
		assert_eq!(tag(first, "theme").as_deref(), Some("buildings"));
		assert_eq!(tag(first, "type").as_deref(), Some("building"));
		assert_eq!(tag(first, "id").as_deref(), Some("id-0"));
		assert_eq!(tag(first, "height").as_deref(), Some("12.0"));
		assert_eq!(tag(first, "num_floors").as_deref(), Some("4"));
		assert_eq!(tag(first, "has_parts").as_deref(), Some("true"));
		assert_eq!(tag(&records[1], "height"), None);
		assert_eq!(tag(first, "bbox"), None);
	}

	#[test]
	fn sources_give_one_record_id_per_dataset_preferring_the_whole_feature_entry() {
		let fields = Fields::from(vec![
			Field::new("property", DataType::Utf8, true),
			Field::new("dataset", DataType::Utf8, true),
			Field::new("record_id", DataType::Utf8, true),
		]);
		let text = |values: Vec<Option<&str>>| Arc::new(StringArray::from(values)) as ArrayRef;
		// Row 0: OSM gives the height first and the whole feature second; Esri gives the whole feature.
		// Row 1: no entries.
		let entries = StructArray::new(
			fields.clone(),
			vec![
				text(vec![Some("/properties/height"), Some(""), None]),
				text(vec![
					Some("OpenStreetMap"),
					Some("OpenStreetMap"),
					Some("Esri Community Maps"),
				]),
				text(vec![Some("w2@1"), Some("w1@3"), Some("{ABC}")]),
			],
			None,
		);
		let list: ArrayRef = Arc::new(arrow_array::ListArray::new(
			Arc::new(Field::new("element", DataType::Struct(fields), true)),
			arrow_buffer::OffsetBuffer::new(vec![0, 3, 3].into()),
			Arc::new(entries),
			None,
		));
		assert_eq!(
			source_tags(&list, 0),
			[
				("sources:OpenStreetMap".to_owned(), "w1@3".to_owned()),
				("sources:Esri Community Maps".to_owned(), "{ABC}".to_owned()),
			]
		);
		assert!(source_tags(&list, 1).is_empty());
	}

	#[test]
	fn bounds_skip_row_groups_and_rows_outside_them_and_keep_ids() {
		let dir = tempfile::tempdir().unwrap();
		write_buildings(&dir.path().join("a.parquet"), &[1.0, 2.0, 50.0, 51.0, 3.0]);
		let ids = std::sync::Mutex::new(Vec::new());
		let rows = read(dir.path(), Some([0.5, 9.0, 10.0, 11.0]), |record| {
			ids.lock().unwrap().push(record.id)
		})
		.unwrap();
		let mut ids = ids.into_inner().unwrap();
		ids.sort_unstable();
		assert_eq!(rows, 5);
		assert_eq!(ids, [1, 2, 5]);
	}
}
