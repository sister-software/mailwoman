// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Follows Planetiler 0.10.2's GeoPackageReader (Apache-2.0) and the geopackage-java 6.6 queries it runs (MIT).

//! Reading a GeoPackage, possibly zipped, as Planetiler's `GeoPackageReader` reads it.
//!
//! Feature tables are read in `gpkg_contents` order. With map bounds, a table with an R-tree index keeps the rows whose
//! R-tree box meets the bounds, `minx <= east AND miny <= north AND maxx >= west AND maxy >= south`, read in ascending
//! key order as Planetiler receives them; that order decides the running feature numbers. Other tables are read in row
//! order. Geometry is assumed to be longitude and latitude, as Natural Earth's is.

use std::io;
use std::path::{Path, PathBuf};

use hrt_osm::Tags;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::java_text::double_to_string;
use crate::wkb::{geopackage_wkb, parse_wkb};
use crate::{lon_lat_to_world, Record};

fn sql_error(error: rusqlite::Error) -> io::Error {
	io::Error::other(error)
}

/// Extracts the first `.gpkg` entry of a zip archive into `scratch`, reusing an earlier extraction.
pub fn unzip_geopackage(zipped: &Path, scratch: &Path) -> io::Result<PathBuf> {
	let file = std::fs::File::open(zipped)?;
	let mut archive = zip::ZipArchive::new(file).map_err(io::Error::other)?;
	for index in 0..archive.len() {
		let mut entry = archive.by_index(index).map_err(io::Error::other)?;
		let entry_name = entry.name().map_err(io::Error::other)?.into_owned();
		if !entry_name.ends_with(".gpkg") {
			continue;
		}
		let name = Path::new(&entry_name)
			.file_name()
			.map(PathBuf::from)
			.unwrap_or_else(|| "input.gpkg".into());
		let out = scratch.join(name);
		if out.metadata().map(|meta| meta.len() == entry.size()).unwrap_or(false) {
			return Ok(out);
		}
		let partial = out.with_extension("gpkg.part");
		let mut writer = std::fs::File::create(&partial)?;
		io::copy(&mut entry, &mut writer)?;
		std::fs::rename(&partial, &out)?;
		return Ok(out);
	}
	Err(io::Error::new(io::ErrorKind::NotFound, "no .gpkg file in the archive"))
}

fn value_text(value: ValueRef<'_>) -> Option<String> {
	match value {
		ValueRef::Null => None,
		ValueRef::Integer(number) => Some(number.to_string()),
		ValueRef::Real(number) => Some(double_to_string(number)),
		ValueRef::Text(text) => Some(String::from_utf8_lossy(text).into_owned()),
		ValueRef::Blob(_) => None,
	}
}

struct Table {
	name: String,
	geometry_column: String,
	columns: Vec<String>,
	indexed: bool,
}

fn tables(connection: &Connection) -> io::Result<Vec<Table>> {
	let mut statement = connection
		.prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'")
		.map_err(sql_error)?;
	let names: Vec<String> = statement
		.query_map([], |row| row.get(0))
		.map_err(sql_error)?
		.collect::<Result<_, _>>()
		.map_err(sql_error)?;
	let mut out = Vec::with_capacity(names.len());
	for name in names {
		let geometry_column: String = connection
			.query_row(
				"SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?1",
				[&name],
				|row| row.get(0),
			)
			.map_err(sql_error)?;
		let mut columns_statement = connection
			.prepare(&format!("PRAGMA table_info(\"{name}\")"))
			.map_err(sql_error)?;
		let columns: Vec<String> = columns_statement
			.query_map([], |row| row.get(1))
			.map_err(sql_error)?
			.collect::<Result<_, _>>()
			.map_err(sql_error)?;
		let rtree = format!("rtree_{name}_{geometry_column}");
		let indexed = connection
			.query_row("SELECT count(*) FROM sqlite_master WHERE name = ?1", [&rtree], |row| {
				row.get::<_, i64>(0)
			})
			.map_err(sql_error)?
			> 0;
		out.push(Table {
			name,
			geometry_column,
			columns,
			indexed,
		});
	}
	Ok(out)
}

/// Reads every feature of the GeoPackage at `path`, keeping those an R-tree places within `bounds`
/// (`[west, south, east, north]` degrees) when given.
pub fn read(path: &Path, source_bounds: Option<[f64; 4]>, mut each: impl FnMut(Record)) -> io::Result<u64> {
	let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql_error)?;
	let mut id = 0i64;
	for table in tables(&connection)? {
		let quoted = format!("\"{}\"", table.name);
		let geometry_index = table.columns.iter().position(|column| *column == table.geometry_column);
		let select = format!("SELECT * FROM {quoted}");
		let bounded = match (source_bounds, table.indexed) {
			(Some(bounds), true) => Some(bounds),
			_ => None,
		};
		let mut handle = |row: &rusqlite::Row<'_>| -> io::Result<()> {
			let Some(geometry_index) = geometry_index else {
				return Ok(());
			};
			let blob = match row.get_ref(geometry_index).map_err(sql_error)? {
				ValueRef::Blob(blob) => blob,
				_ => return Ok(()),
			};
			let Some(wkb) = geopackage_wkb(blob).map_err(|error| io::Error::other(error.0))? else {
				return Ok(());
			};
			let geometry = parse_wkb(wkb).map_err(|error| io::Error::other(error.0))?;
			let mut tags = Vec::with_capacity(table.columns.len());
			for (index, column) in table.columns.iter().enumerate() {
				if index == geometry_index {
					continue;
				}
				if let Some(text) = value_text(row.get_ref(index).map_err(sql_error)?) {
					tags.push((column.clone(), text));
				}
			}
			id += 1;
			each(Record {
				id,
				layer: table.name.clone(),
				tags: Tags(tags),
				geometry: lon_lat_to_world(&geometry),
			});
			Ok(())
		};
		match bounded {
			Some([west, south, east, north]) => {
				// The rows come back in ascending key order, the order Planetiler numbers them in: on Luxembourg's
				// bounds its reader yields ne_10m_admin_0_boundary_lines_land fids 67, 69, 70, 76, 77, 147, 207.
				let key = table.columns.first().cloned().unwrap_or_else(|| "fid".into());
				let rtree = format!("\"rtree_{}_{}\"", table.name, table.geometry_column);
				let mut statement = connection
					.prepare(&format!(
						"{select} WHERE \"{key}\" IN (SELECT id FROM {rtree} \
						 WHERE minx <= ?1 AND miny <= ?2 AND maxx >= ?3 AND maxy >= ?4) ORDER BY \"{key}\""
					))
					.map_err(sql_error)?;
				let mut rows = statement.query([east, north, west, south]).map_err(sql_error)?;
				while let Some(row) = rows.next().map_err(sql_error)? {
					handle(row)?;
				}
			}
			None => {
				let mut statement = connection.prepare(&select).map_err(sql_error)?;
				let mut rows = statement.query([]).map_err(sql_error)?;
				while let Some(row) = rows.next().map_err(sql_error)? {
					handle(row)?;
				}
			}
		}
	}
	Ok(id as u64)
}
