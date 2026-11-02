// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The fork's `Clip` tile post-processor: every layer of every tile is clipped to a polygon.
//!
//! The polygon is buffered by a fraction of its larger envelope side, then sliced into tiles at each zoom twice. The
//! first slicing, with no tile buffer, gives the tiles the polygon touches or fills; a tile outside them is emptied.
//! The second, with the tile buffer, gives the polygon's piece on each tile its edge crosses. Features on such a tile
//! are intersected with that piece, and a tile the polygon fills keeps its features unchanged.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use geos::Geom as _;
use hrt_osm::coords::{world_x, world_y};
use hrt_render::commands::encode_geometry;
use hrt_render::geom::{Geom, Line, Polygon, Seq};
use hrt_render::groups::{extract_groups, reassemble_polygons};
use hrt_render::snap::{fix_polygon, from_geos, reverse, snap_and_fix_polygon, to_geos, SnapCounts};
use hrt_render::tiled::{slice_into_tiles, TileExtents, Tiled};

use crate::merge::decode;
use crate::{TileFeature, TileLayers};

/// The fork's `Clip.DEFAULT_BUFFER`: the default buffer, in pixels of a 256-pixel tile.
pub const DEFAULT_BUFFER: f64 = 4.0;

/// A clipping polygon that could not be read or sliced.
#[derive(Debug)]
pub struct ClipError(pub String);

impl fmt::Display for ClipError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.0)
	}
}

impl std::error::Error for ClipError {}

struct ClipZoom {
	covered: Tiled,
	boundary: Tiled,
}

/// The clip of a build to one polygon, for zooms `min_zoom` through `max_zoom`.
pub struct Clip {
	zooms: BTreeMap<u8, ClipZoom>,
	/// Features whose clipped geometry could not be repaired and were dropped, as the fork logs them.
	pub failures: AtomicU64,
}

fn ring(value: &serde_json::Value) -> Result<Seq, ClipError> {
	let points = value
		.as_array()
		.ok_or_else(|| ClipError("a ring is not an array".into()))?;
	points
		.iter()
		.map(|point| match point.as_array().map(Vec::as_slice) {
			Some([longitude, latitude, ..]) => match (longitude.as_f64(), latitude.as_f64()) {
				(Some(longitude), Some(latitude)) => Ok([world_x(longitude), world_y(latitude)]),
				_ => Err(ClipError("a position is not numeric".into())),
			},
			_ => Err(ClipError("a position has fewer than two numbers".into())),
		})
		.collect()
}

fn polygon(value: &serde_json::Value) -> Result<Polygon, ClipError> {
	let rings = value
		.as_array()
		.ok_or_else(|| ClipError("a polygon is not an array of rings".into()))?;
	let mut rings = rings.iter().map(ring);
	let shell = rings.next().transpose()?.unwrap_or_default();
	Ok(Polygon {
		shell,
		holes: rings.collect::<Result<_, _>>()?,
	})
}

/// Reads the first geometry of a GeoJSON feature collection, feature or geometry, in world coordinates.
fn first_geometry(value: &serde_json::Value) -> Result<Geom, ClipError> {
	let kind = value.get("type").and_then(serde_json::Value::as_str);
	match kind {
		Some("FeatureCollection") => {
			let first = value
				.get("features")
				.and_then(serde_json::Value::as_array)
				.and_then(|features| features.first())
				.ok_or_else(|| ClipError("Empty clipping geometry".into()))?;
			first_geometry(first)
		}
		Some("Feature") => first_geometry(
			value
				.get("geometry")
				.ok_or_else(|| ClipError("a feature has no geometry".into()))?,
		),
		Some("Polygon") => Ok(Geom::Polygon(polygon(&value["coordinates"])?)),
		Some("MultiPolygon") => Ok(Geom::MultiPolygon(
			value["coordinates"]
				.as_array()
				.ok_or_else(|| ClipError("a multipolygon is not an array".into()))?
				.iter()
				.map(polygon)
				.collect::<Result<_, _>>()?,
		)),
		other => Err(ClipError(format!(
			"the clipping geometry must be a Polygon or MultiPolygon, found {other:?}"
		))),
	}
}

/// Returns the parts a feature is split into: each member of a multi-part or collection result becomes its own feature,
/// as `Clip.addToFeatures` does.
fn parts(geom: Geom) -> Vec<Geom> {
	match geom {
		Geom::MultiPoint(points) => points.into_iter().map(Geom::Point).collect(),
		Geom::MultiLineString(lines) => lines
			.into_iter()
			.map(|Line { seq, .. }| Geom::LineString(seq))
			.collect(),
		Geom::MultiPolygon(polygons) => polygons.into_iter().map(Geom::Polygon).collect(),
		Geom::Collection(members) => members,
		single => vec![single],
	}
}

impl Clip {
	/// Builds the clip of `input`, in world coordinates, buffered by `clip_buffer` pixels of a 256-pixel tile as a
	/// fraction of its larger envelope side, as the fork's `Clip` constructor does with `doBuffer` set.
	pub fn new(min_zoom: u8, max_zoom: u8, clip_buffer: f64, input: &Geom) -> Result<Self, ClipError> {
		let boundary_buffer = clip_buffer / 256.0;
		let [min_x, min_y, max_x, max_y] = input
			.envelope()
			.ok_or_else(|| ClipError("Empty clipping geometry".into()))?;
		let buffer_amount = (max_x - min_x).max(max_y - min_y) * boundary_buffer;
		let geos_error = |error: geos::Error| ClipError(format!("could not buffer the clipping geometry: {error}"));
		let buffered = to_geos(input)
			.and_then(|geometry| geometry.buffer(buffer_amount, 8))
			.map_err(geos_error)?;
		let clip_geometry = from_geos(&buffered).map_err(geos_error)?;
		let mut zooms = BTreeMap::new();
		for z in min_zoom..=max_zoom {
			let extents = TileExtents::world(z);
			let scaled = clip_geometry.scaled(f64::from(1u32 << z));
			let groups = extract_groups(&scaled, 0.0);
			let area = scaled.is_polygonal();
			let slice = |buffer: f64| {
				slice_into_tiles(&groups, buffer, area, z, extents)
					.map_err(|error| ClipError(format!("Error clipping at z{z}: {error:?}")))
			};
			zooms.insert(
				z,
				ClipZoom {
					covered: slice(0.0)?,
					boundary: slice(boundary_buffer)?,
				},
			);
		}
		Ok(Clip {
			zooms,
			failures: AtomicU64::new(0),
		})
	}

	/// Reads the first geometry of the GeoJSON file at `path` and builds its clip, as `Clip.fromGeoJSONFile` does.
	pub fn from_geojson_file(min_zoom: u8, max_zoom: u8, clip_buffer: f64, path: &Path) -> Result<Self, ClipError> {
		let text = std::fs::read_to_string(path)
			.map_err(|error| ClipError(format!("could not read {}: {error}", path.display())))?;
		let value: serde_json::Value = serde_json::from_str(&text)
			.map_err(|error| ClipError(format!("could not parse {}: {error}", path.display())))?;
		Clip::new(min_zoom, max_zoom, clip_buffer, &first_geometry(&value)?)
	}

	/// Clips one feature to `clip`, returning its parts, or `Err` when GEOS could not intersect or repair it.
	fn clip_feature(feature: &TileFeature, clip: &geos::Geometry) -> geos::GResult<Vec<TileFeature>> {
		let decoded = to_geos(&decode(&feature.geometry))?;
		let clipped = from_geos(&decoded.intersection(clip)?)?;
		if clipped.is_empty() {
			return Ok(Vec::new());
		}
		let fixed = if clipped.is_polygonal() {
			let snapped = snap_and_fix_polygon(&clipped, &mut SnapCounts::default())
				.map_err(|error| geos::Error::GenericError(error.0))?;
			reverse(&snapped)
		} else {
			clipped
		};
		if fixed.is_empty() {
			return Ok(Vec::new());
		}
		Ok(parts(fixed)
			.into_iter()
			.map(|part| TileFeature {
				id: feature.id,
				geometry: encode_geometry(&part, 0),
				attributes: feature.attributes.clone(),
			})
			.collect())
	}

	/// Clips a tile's layers, as `Clip.postProcessTile` does.
	pub fn post_process_tile(&self, z: u8, x: u32, y: u32, layers: TileLayers) -> TileLayers {
		let Some(zoom) = self.zooms.get(&z) else {
			return Vec::new();
		};
		let (x, y) = (x as i32, y as i32);
		if !zoom.covered.covers(x, y) {
			return Vec::new();
		}
		let Some(groups) = zoom.boundary.tiles.get(&(x, y)) else {
			return layers;
		};
		let clip = reassemble_polygons(groups)
			.map_err(|_| "reassemble_polygon_failed".to_owned())
			.and_then(|polygon| fix_polygon(&polygon).map_err(|error| error.to_string()))
			.and_then(|polygon| to_geos(&polygon).map_err(|error| error.to_string()));
		let clip = match clip {
			Ok(clip) => clip,
			Err(error) => panic!("the clipping polygon of tile {z}/{x}/{y} could not be rebuilt: {error}"),
		};
		let mut output = Vec::new();
		for (name, features) in layers {
			let mut clipped = Vec::new();
			for feature in &features {
				match Clip::clip_feature(feature, &clip) {
					Ok(parts) => clipped.extend(parts),
					Err(_) => {
						self.failures.fetch_add(1, Ordering::Relaxed);
					}
				}
			}
			if !clipped.is_empty() {
				output.push((name, clipped));
			}
		}
		output
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use hrt_e::Value;

	fn square(min: f64, max: f64) -> Geom {
		Geom::Polygon(Polygon {
			shell: vec![[min, min], [max, min], [max, max], [min, max], [min, min]],
			holes: Vec::new(),
		})
	}

	fn feature(geom: &Geom) -> TileFeature {
		TileFeature {
			id: 7,
			geometry: encode_geometry(geom, 0),
			attributes: vec![("kind".into(), Value::String("x".into()))],
		}
	}

	#[test]
	fn tiles_outside_the_polygon_are_emptied_and_inside_ones_kept() {
		// A square over world tiles x 2..6, y 2..6 at zoom 3, with no buffer.
		let clip = Clip::new(3, 3, 0.0, &square(0.25, 0.75)).unwrap();
		let layers: TileLayers = vec![("earth", vec![feature(&square(10.0, 20.0))])];
		assert!(clip.post_process_tile(3, 0, 0, layers.clone()).is_empty());
		let kept = clip.post_process_tile(3, 3, 3, layers.clone());
		assert_eq!(kept[0].1[0].geometry, layers[0].1[0].geometry);
		assert!(
			clip.post_process_tile(2, 1, 1, layers).is_empty(),
			"z2 is outside the clip's zooms"
		);
	}

	#[test]
	fn a_feature_crossing_the_edge_is_clipped_to_it() {
		// The polygon's west and north edges run through the middle of tile (4, 4) at zoom 3.
		let clip = Clip::new(3, 3, 0.0, &square(4.5 / 8.0, 6.0 / 8.0)).unwrap();
		let line = Geom::LineString(vec![[0.0, 200.0], [256.0, 200.0]]);
		let out = clip.post_process_tile(3, 4, 4, vec![("roads", vec![feature(&line)])]);
		let decoded = decode(&out[0].1[0].geometry);
		assert_eq!(decoded, Geom::LineString(vec![[128.0, 200.0], [256.0, 200.0]]));
		assert_eq!(out[0].1[0].id, 7);
	}

	#[test]
	fn a_feature_wholly_outside_the_piece_drops_its_layer() {
		let clip = Clip::new(3, 3, 0.0, &square(4.5 / 8.0, 6.0 / 8.0)).unwrap();
		let point = Geom::Point([10.0, 10.0]);
		assert!(clip
			.post_process_tile(3, 4, 4, vec![("pois", vec![feature(&point)])])
			.is_empty());
	}

	#[test]
	fn a_polygon_split_in_two_becomes_two_features() {
		// A U-shaped clip: two prongs over tile (4, 4) at zoom 3, joined south of it.
		let tile = |value: f64| value / 8.0;
		let u = Geom::Polygon(Polygon {
			shell: vec![
				[tile(4.1), tile(4.0)],
				[tile(4.4), tile(4.0)],
				[tile(4.4), tile(5.5)],
				[tile(4.6), tile(5.5)],
				[tile(4.6), tile(4.0)],
				[tile(4.9), tile(4.0)],
				[tile(4.9), tile(6.0)],
				[tile(4.1), tile(6.0)],
				[tile(4.1), tile(4.0)],
			],
			holes: Vec::new(),
		});
		let clip = Clip::new(3, 3, 0.0, &u).unwrap();
		let out = clip.post_process_tile(3, 4, 4, vec![("water", vec![feature(&square(0.0, 256.0))])]);
		assert_eq!(out[0].1.len(), 2);
		assert!(out[0].1.iter().all(|part| decode(&part.geometry).is_polygonal()));
	}

	#[test]
	fn geojson_reads_the_first_feature() {
		let value = serde_json::json!({
			"type": "FeatureCollection",
			"features": [{"type": "Feature", "properties": {}, "geometry": {
				"type": "Polygon", "coordinates": [[[0.0, 0.0], [90.0, 0.0], [90.0, 45.0], [0.0, 0.0]]]
			}}]
		});
		let Geom::Polygon(polygon) = first_geometry(&value).unwrap() else {
			panic!("a polygon");
		};
		assert_eq!(polygon.shell[1], [0.75, 0.5]);
		assert!(first_geometry(&serde_json::json!({"type": "LineString", "coordinates": []})).is_err());
	}
}
