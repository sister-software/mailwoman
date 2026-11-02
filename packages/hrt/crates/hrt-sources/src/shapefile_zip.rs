// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Follows Planetiler 0.10.2's ShapefileReader (Apache-2.0).

//! Reading a zipped shapefile as Planetiler's `ShapefileReader` reads it.
//!
//! Each `.shp` in the archive is read in file order with its `.dbf` attributes, numbered from 1 per shapefile. With map
//! bounds, a feature is kept when its bounding box meets the bounds converted to the file's projection, as GeoTools'
//! bbox filter keeps it. A file in EPSG:3857 is converted to longitude and latitude with the spherical Mercator inverse,
//! then to world coordinates, in two steps as Planetiler does through GeoTools; the result can differ from a direct
//! conversion in the last bit, which the parity contract's one-unit vertex tolerance covers.

use std::f64::consts::PI;
use std::io;
use std::path::{Path, PathBuf};

use geo_types::{Coord, Geometry};
use hrt_osm::Tags;
use shapefile::dbase::FieldValue;

use crate::java_text::double_to_string;
use crate::{lon_lat_to_world, map_coords, Record};

const EARTH_RADIUS: f64 = 6_378_137.0;

/// Extracts every shapefile component in a zip archive into `scratch`, returning the `.shp` paths in archive order.
pub fn unzip_shapefiles(zipped: &Path, scratch: &Path) -> io::Result<Vec<PathBuf>> {
	let file = std::fs::File::open(zipped)?;
	let mut archive = zip::ZipArchive::new(file).map_err(io::Error::other)?;
	let mut shapefiles = Vec::new();
	for index in 0..archive.len() {
		let mut entry = archive.by_index(index).map_err(io::Error::other)?;
		let name = entry.name().map_err(io::Error::other)?.into_owned();
		let lower = name.to_lowercase();
		if ![".shp", ".shx", ".dbf", ".prj", ".cpg"]
			.iter()
			.any(|suffix| lower.ends_with(suffix))
		{
			continue;
		}
		let Some(file_name) = Path::new(&name).file_name() else {
			continue;
		};
		let out = scratch.join(file_name);
		if !out.metadata().map(|meta| meta.len() == entry.size()).unwrap_or(false) {
			let partial = scratch.join(format!("{}.part", file_name.to_string_lossy()));
			let mut writer = std::fs::File::create(&partial)?;
			io::copy(&mut entry, &mut writer)?;
			std::fs::rename(&partial, &out)?;
		}
		if lower.ends_with(".shp") {
			shapefiles.push(out);
		}
	}
	Ok(shapefiles)
}

fn spherical_mercator_to_lon_lat(Coord { x, y }: Coord) -> Coord {
	Coord {
		x: (x / EARTH_RADIUS).to_degrees(),
		y: (PI / 2.0 - 2.0 * (-y / EARTH_RADIUS).exp().atan()).to_degrees(),
	}
}

fn lon_lat_to_spherical_mercator(lon: f64, lat: f64) -> (f64, f64) {
	(
		EARTH_RADIUS * lon.to_radians(),
		EARTH_RADIUS * (PI / 4.0 + lat.to_radians() / 2.0).tan().ln(),
	)
}

fn field_text(value: &FieldValue) -> Option<String> {
	match value {
		FieldValue::Character(text) => text.clone(),
		FieldValue::Numeric(number) => number.map(|n| {
			// GeoTools reads a numeric field with no decimals as a whole number and one with decimals as a double.
			if n.fract() == 0.0 && n.abs() < 9.0e15 {
				(n as i64).to_string()
			} else {
				double_to_string(n)
			}
		}),
		FieldValue::Float(number) => number.map(|n| double_to_string(f64::from(n))),
		FieldValue::Integer(number) => Some(number.to_string()),
		FieldValue::Double(number) => Some(double_to_string(*number)),
		FieldValue::Logical(flag) => flag.map(|b| b.to_string()),
		other => Some(format!("{other}")),
	}
}

/// Reads the shapefile at `path`, keeping features whose bounding box meets `source_bounds`
/// (`[west, south, east, north]` degrees) when given.
pub fn read(path: &Path, source_bounds: Option<[f64; 4]>, mut each: impl FnMut(Record)) -> io::Result<u64> {
	let layer = path
		.file_stem()
		.map(|stem| stem.to_string_lossy().into_owned())
		.unwrap_or_default();
	let projection = std::fs::read_to_string(path.with_extension("prj")).unwrap_or_default();
	let mercator = projection.contains("Mercator") || projection.contains("3857");
	let bounds = source_bounds.map(|[west, south, east, north]| {
		if mercator {
			let (min_x, min_y) = lon_lat_to_spherical_mercator(west, south);
			let (max_x, max_y) = lon_lat_to_spherical_mercator(east, north);
			[min_x, min_y, max_x, max_y]
		} else {
			[west, south, east, north]
		}
	});

	let field_order: Vec<String> = shapefile::dbase::Reader::from_path(path.with_extension("dbf"))
		.map(|reader| reader.fields().iter().map(|field| field.name().to_owned()).collect())
		.unwrap_or_default();
	let mut reader = shapefile::Reader::from_path(path).map_err(io::Error::other)?;
	let mut id = 0i64;
	for item in reader.iter_shapes_and_records() {
		let (shape, record) = item.map_err(io::Error::other)?;
		if let Some([min_x, min_y, max_x, max_y]) = bounds {
			let Some(bbox) = shape_bbox(&shape) else {
				continue;
			};
			if bbox[0] > max_x || bbox[2] < min_x || bbox[1] > max_y || bbox[3] < min_y {
				continue;
			}
		}
		let Ok(mut geometry) = Geometry::try_from(shape) else {
			continue;
		};
		if mercator {
			map_coords(&mut geometry, &spherical_mercator_to_lon_lat);
		}
		let mut tags = Vec::new();
		for name in &field_order {
			if let Some(text) = record.get(name).and_then(field_text) {
				tags.push((name.clone(), text));
			}
		}
		id += 1;
		each(Record {
			id,
			layer: layer.clone(),
			tags: Tags(tags),
			geometry: lon_lat_to_world(&geometry),
		});
	}
	Ok(id as u64)
}

fn shape_bbox(shape: &shapefile::Shape) -> Option<[f64; 4]> {
	use shapefile::Shape;
	let points: Vec<(f64, f64)> = match shape {
		Shape::Point(point) => vec![(point.x, point.y)],
		Shape::Polyline(line) => line.parts().iter().flatten().map(|p| (p.x, p.y)).collect(),
		Shape::Polygon(polygon) => polygon
			.rings()
			.iter()
			.flat_map(|ring| ring.points())
			.map(|p| (p.x, p.y))
			.collect(),
		Shape::Multipoint(points) => points.points().iter().map(|p| (p.x, p.y)).collect(),
		_ => return None,
	};
	if points.is_empty() {
		return None;
	}
	let mut bbox = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
	for (x, y) in points {
		bbox = [bbox[0].min(x), bbox[1].min(y), bbox[2].max(x), bbox[3].max(y)];
	}
	Some(bbox)
}
