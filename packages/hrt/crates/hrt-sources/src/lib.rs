// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The Hilbert Rust Tiler's inputs other than OpenStreetMap.
//!
//! Each reader yields [`Record`]s in the order Planetiler's matching reader produces them, numbered from 1 across the
//! whole input as Planetiler numbers them, with geometry converted to Web Mercator world coordinates the way
//! Planetiler's `SimpleFeature` converts its longitude and latitude.

pub mod geopackage;
pub mod java_text;
pub mod overture;
pub mod shapefile_zip;
pub mod wkb;

use geo_types::{Coord, Geometry};
use hrt_osm::coords::{world_x, world_y};
use hrt_osm::Tags;

/// One feature from a non-OpenStreetMap input.
#[derive(Clone, Debug)]
pub struct Record {
	/// Planetiler's running feature number for this input, starting at 1.
	pub id: i64,
	/// The table or file the feature came from, Planetiler's source layer.
	pub layer: String,
	pub tags: Tags,
	/// The geometry in world coordinates.
	pub geometry: Geometry,
}

/// Converts a longitude and latitude geometry to world coordinates, vertex by vertex.
pub fn lon_lat_to_world(geometry: &Geometry) -> Geometry {
	let mut out = geometry.clone();
	map_coords(&mut out, &|Coord { x, y }| Coord {
		x: world_x(x),
		y: world_y(y),
	});
	out
}

/// Applies `f` to every coordinate of `geometry` in place.
pub fn map_coords(geometry: &mut Geometry, f: &impl Fn(Coord) -> Coord) {
	let line = |line: &mut geo_types::LineString| line.0.iter_mut().for_each(|c| *c = f(*c));
	let polygon = |polygon: &mut geo_types::Polygon| {
		polygon.exterior_mut(line);
		polygon.interiors_mut(|rings| rings.iter_mut().for_each(line));
	};
	match geometry {
		Geometry::Point(point) => point.0 = f(point.0),
		Geometry::MultiPoint(points) => points.0.iter_mut().for_each(|point| point.0 = f(point.0)),
		Geometry::LineString(l) => line(l),
		Geometry::MultiLineString(lines) => lines.0.iter_mut().for_each(line),
		Geometry::Polygon(p) => polygon(p),
		Geometry::MultiPolygon(polygons) => polygons.0.iter_mut().for_each(polygon),
		Geometry::GeometryCollection(parts) => parts.0.iter_mut().for_each(|part| map_coords(part, f)),
		Geometry::Line(segment) => {
			segment.start = f(segment.start);
			segment.end = f(segment.end);
		}
		Geometry::Rect(_) | Geometry::Triangle(_) => {}
	}
}
