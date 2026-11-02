// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's CountryCoder (BSD-3-Clause, Protomaps).

//! The country a feature lies in, from the country-coder border polygons the fork bundles as `borders.json`.
//!
//! A feature's country is the first border polygon that contains its whole longitude and latitude geometry. The Java
//! code takes the first candidate in its R-tree's query order; this port takes the first in file order, which differs
//! only where two border polygons overlap.

use std::io;
use std::path::Path;

use geos::{Geom as _, Geometry};
use hrt_render::snap::to_geos;
use hrt_render::Geom;

struct Border {
	country: String,
	bounds: [f64; 4],
	shape: Geometry,
}

/// The border polygons, searched by bounding box and then by containment.
pub struct CountryCoder {
	borders: Vec<Border>,
}

fn polygon_rings(value: &serde_json::Value) -> Option<Vec<Vec<[f64; 2]>>> {
	value
		.as_array()?
		.iter()
		.map(|ring| {
			ring.as_array()?
				.iter()
				.map(|point| {
					let point = point.as_array()?;
					Some([point.first()?.as_f64()?, point.get(1)?.as_f64()?])
				})
				.collect::<Option<Vec<_>>>()
		})
		.collect()
}

fn bounds_of(rings: &[Vec<Vec<[f64; 2]>>]) -> [f64; 4] {
	let mut bounds = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
	for &[x, y] in rings.iter().flatten().flatten() {
		bounds = [bounds[0].min(x), bounds[1].min(y), bounds[2].max(x), bounds[3].max(y)];
	}
	bounds
}

impl CountryCoder {
	/// Reads country-coder GeoJSON: each feature's `iso1A2`, else `country`, names its country, and features with
	/// neither or with no geometry are skipped.
	pub fn from_geojson(text: &str) -> io::Result<Self> {
		let document: serde_json::Value = serde_json::from_str(text).map_err(io::Error::other)?;
		let mut borders = Vec::new();
		for feature in document["features"].as_array().into_iter().flatten() {
			let properties = &feature["properties"];
			let country = properties["iso1A2"]
				.as_str()
				.or_else(|| properties["country"].as_str())
				.unwrap_or_default()
				.to_owned();
			if country.trim().is_empty() {
				continue;
			}
			let Some(polygons) = feature["geometry"]["coordinates"]
				.as_array()
				.and_then(|polygons| polygons.iter().map(polygon_rings).collect::<Option<Vec<_>>>())
			else {
				continue;
			};
			if polygons.is_empty() {
				continue;
			}
			let geom = Geom::MultiPolygon(
				polygons
					.iter()
					.map(|rings| hrt_render::Polygon {
						shell: rings[0].clone(),
						holes: rings[1..].to_vec(),
					})
					.collect(),
			);
			let shape = to_geos(&geom).map_err(io::Error::other)?;
			borders.push(Border {
				country,
				bounds: bounds_of(&polygons),
				shape,
			});
		}
		Ok(CountryCoder { borders })
	}

	pub fn from_path(path: &Path) -> io::Result<Self> {
		Self::from_geojson(&std::fs::read_to_string(path)?)
	}

	/// Returns the country code of the first border polygon containing `geometry`, in longitude and latitude.
	pub fn country_code(&self, geometry: &Geom) -> Option<&str> {
		let [min_x, min_y, max_x, max_y] = geometry.envelope()?;
		let candidates: Vec<&Border> = self
			.borders
			.iter()
			.filter(|border| {
				!(border.bounds[0] > max_x
					|| border.bounds[2] < min_x
					|| border.bounds[1] > max_y
					|| border.bounds[3] < min_y)
			})
			.collect();
		if candidates.is_empty() {
			return None;
		}
		let shape = to_geos(geometry).ok()?;
		candidates
			.into_iter()
			.find(|border| border.shape.contains(&shape).unwrap_or(false))
			.map(|border| border.country.as_str())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_line_inside_a_border_gets_its_country() {
		let coder = CountryCoder::from_geojson(
			r#"{"type":"FeatureCollection","features":[
				{"type":"Feature","properties":{"iso1A2":"US","nameEn":"US"},"geometry":{"type":"MultiPolygon","coordinates":[[[[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]]]]}},
				{"type":"Feature","properties":{"nameEn":"Nowhere"},"geometry":{"type":"MultiPolygon","coordinates":[[[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]]]]}}
			]}"#,
		)
		.unwrap();
		assert_eq!(
			coder.country_code(&Geom::LineString(vec![[0.0, 0.0], [1.0, 1.0]])),
			Some("US")
		);
		assert_eq!(
			coder.country_code(&Geom::LineString(vec![[0.0, 0.0], [15.0, 1.0]])),
			None
		);
	}
}
