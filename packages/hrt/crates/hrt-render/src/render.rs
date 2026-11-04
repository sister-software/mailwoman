// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Planetiler 0.10.2's FeatureRenderer (Apache-2.0, Copyright Michael Barry).

//! Turning one profile feature into the encoded pieces it contributes to each tile, zoom by zoom.

use crate::commands::{encode_fill, encode_geometry, VectorGeometry};
use crate::geom::{Geom, GeometryType, Xy};
use crate::groups::{extract_groups, reassemble_lines, reassemble_points, reassemble_polygons};
use crate::simplify::douglas_peucker;
use crate::snap::{fix_polygon, reverse, snap_and_fix_polygon, SnapCounts};
use crate::tiled::{slice_into_tiles, slice_points, TileExtents, Tiled};

/// The highest zoom Planetiler renders.
pub const MAX_ZOOM: u8 = 16;

/// A feature's settings at one zoom, in tile pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZoomSettings {
	pub buffer_pixels: f64,
	/// The minimum length of a line, or the square root of the minimum area of a polygon, to emit.
	pub min_pixel_size: f64,
	pub pixel_tolerance: f64,
	/// The size of the grid squares that limit how many points are kept, or 0 for no grid.
	pub label_grid_pixel_size: f64,
	pub label_grid_limit: i32,
}

/// A feature a profile emits, with its geometry in world coordinates.
#[derive(Clone, Debug)]
pub struct Feature {
	pub layer: u32,
	pub id: i64,
	pub geometry: Geom,
	pub min_zoom: u8,
	pub max_zoom: u8,
	pub sort_key: i32,
	/// The settings for each zoom from 0 through [`MAX_ZOOM`].
	pub zooms: [ZoomSettings; MAX_ZOOM as usize + 1],
	/// Whether any zoom sets a label grid.
	pub has_label_grid: bool,
	/// The source feature's size in world units: its length, or the square root of its area.
	pub source_size: f64,
}

impl Feature {
	/// Returns the geometry type the feature was created with, which decides polygon handling at every zoom.
	pub fn geometry_type(&self) -> GeometryType {
		self.geometry.geometry_type()
	}
}

/// A label-grid square a point falls in and the number of points the square keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Group {
	pub id: i64,
	pub limit: i32,
}

/// One feature's encoded geometry on one tile.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderedFeature {
	pub z: u8,
	pub x: i32,
	pub y: i32,
	pub layer: u32,
	pub id: i64,
	pub geometry: VectorGeometry,
	pub sort_key: i32,
	pub group: Option<Group>,
}

/// Build-wide settings the renderer reads.
#[derive(Clone, Copy, Debug)]
pub struct RenderConfig {
	pub max_zoom: u8,
	/// The build's bounds in world coordinates, `[min x, min y, max x, max y]`; tiles outside them are not emitted.
	pub world_bounds: [f64; 4],
}

impl RenderConfig {
	/// A configuration covering the whole world.
	pub fn world(max_zoom: u8) -> Self {
		RenderConfig {
			max_zoom,
			world_bounds: [0.0, 0.0, 1.0, 1.0],
		}
	}

	fn extents(&self, zoom: u8) -> TileExtents {
		TileExtents::from_world_bounds(zoom, self.world_bounds)
	}
}

/// Counts of the failures Planetiler logs as data errors while rendering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderCounts {
	pub snap: SnapCounts,
	/// Zooms omitted because the polygon could not be sliced even after `buffer(0)`.
	pub slice_failures: u64,
	/// Tiles omitted because their pieces could not be rebuilt or snapped.
	pub write_failures: u64,
}

impl RenderCounts {
	/// Adds another renderer's counts to these, as when worker threads report back.
	pub fn add(&mut self, other: &RenderCounts) {
		self.snap.reduced += other.snap.reduced;
		self.snap.fix_input += other.snap.fix_input;
		self.snap.fix_input2 += other.snap.fix_input2;
		self.snap.fix_input3 += other.snap.fix_input3;
		self.slice_failures += other.slice_failures;
		self.write_failures += other.write_failures;
	}
}

fn wrap_double(value: f64, max: f64) -> f64 {
	let mut value = value % max;
	if value < 0.0 {
		value += max;
	}
	value
}

fn label_grid_id(tiles: i32, grid: f64, [x, y]: Xy) -> i64 {
	let a = (wrap_double(x, f64::from(tiles)) / grid).floor() as i32;
	let b = (y / grid).floor() as i32;
	(i64::from(a) << 32) | (i64::from(b) & 0xffff_ffff)
}

/// Renders features, sending each tile piece to `emit`.
pub struct Renderer<'a> {
	pub config: RenderConfig,
	pub counts: RenderCounts,
	emit: &'a mut dyn FnMut(RenderedFeature),
}

impl<'a> Renderer<'a> {
	pub fn new(config: RenderConfig, emit: &'a mut dyn FnMut(RenderedFeature)) -> Self {
		Renderer {
			config,
			counts: RenderCounts::default(),
			emit,
		}
	}

	/// Renders `feature` at each of its zooms, from the highest to the lowest.
	pub fn render(&mut self, feature: &Feature) {
		let geometry = &feature.geometry;
		if geometry.is_empty() {
			return;
		}
		let simple_line_length = if geometry.is_lineal() && geometry.num_geometries() == 1 {
			geometry.length()
		} else {
			-1.0
		};
		for zoom in (feature.min_zoom..=feature.max_zoom).rev() {
			let scale = f64::from(1u32 << zoom);
			let settings = feature.zooms[zoom as usize];
			let min_size = settings.min_pixel_size;
			if min_size > 0.0 {
				if geometry.is_puntal() {
					let source_pixels = feature.source_size * f64::from(256u32 << zoom);
					if source_pixels < min_size {
						continue;
					}
				} else if simple_line_length >= 0.0 && simple_line_length * scale * 256.0 < min_size {
					continue;
				}
			}
			let mut geom = geometry.scaled(scale);
			if !geom.is_puntal() {
				geom = douglas_peucker(&geom, settings.pixel_tolerance / 256.0);
			}
			self.render_geometry(zoom, &geom, feature, settings);
		}
	}

	fn render_geometry(&mut self, zoom: u8, geom: &Geom, feature: &Feature, settings: ZoomSettings) {
		if geom.is_empty() {
			return;
		}
		match geom {
			Geom::Point(point) => self.render_points(zoom, feature, settings, &[*point]),
			Geom::MultiPoint(points) => {
				if feature.has_label_grid {
					for point in points {
						self.render_points(zoom, feature, settings, &[*point]);
					}
				} else {
					self.render_points(zoom, feature, settings, points);
				}
			}
			Geom::Collection(parts) => {
				for part in parts {
					self.render_geometry(zoom, part, feature, settings);
				}
			}
			_ => self.render_line_or_polygon(zoom, geom, feature, settings),
		}
	}

	fn render_points(&mut self, zoom: u8, feature: &Feature, settings: ZoomSettings, points: &[Xy]) {
		let tiles_at_zoom = 1i32 << zoom;
		let mut group = None;
		if feature.has_label_grid && points.len() == 1 {
			let grid = settings.label_grid_pixel_size / 256.0;
			if grid >= 1.0 / 4096.0 {
				group = Some(Group {
					id: label_grid_id(tiles_at_zoom, grid, points[0]),
					limit: settings.label_grid_limit,
				});
			}
		}
		let tiled = slice_points(self.config.extents(zoom), settings.buffer_pixels / 256.0, zoom, points);
		for (&(x, y), groups) in &tiled.tiles {
			let geom = reassemble_points(groups);
			(self.emit)(RenderedFeature {
				z: zoom,
				x,
				y,
				layer: feature.layer,
				id: feature.id,
				geometry: encode_geometry(&geom, 0),
				sort_key: feature.sort_key,
				group,
			});
		}
	}

	fn render_line_or_polygon(&mut self, zoom: u8, geom: &Geom, feature: &Feature, settings: ZoomSettings) {
		let area = geom.is_polygonal();
		let mut min_size = settings.min_pixel_size / 256.0;
		if area {
			min_size *= min_size;
		}
		let buffer = settings.buffer_pixels / 256.0;
		let extents = self.config.extents(zoom);
		let sliced = match slice_into_tiles(&extract_groups(geom, min_size), buffer, area, zoom, extents) {
			Ok(sliced) => sliced,
			Err(_) => {
				let retried = fix_polygon(geom).ok().and_then(|fixed| {
					slice_into_tiles(&extract_groups(&fixed, min_size), buffer, area, zoom, extents).ok()
				});
				match retried {
					Some(sliced) => sliced,
					None => {
						self.counts.slice_failures += 1;
						return;
					}
				}
			}
		};
		self.write_tile_features(zoom, feature, &sliced, settings);
	}

	fn write_tile_features(&mut self, zoom: u8, feature: &Feature, sliced: &Tiled, settings: ZoomSettings) {
		let polygon = feature.geometry_type() == GeometryType::Polygon;
		for (&(x, y), groups) in &sliced.tiles {
			let (geom, scale) = if polygon {
				let snapped = reassemble_polygons(groups)
					.ok()
					.and_then(|geom| snap_and_fix_polygon(&geom, &mut self.counts.snap).ok());
				match snapped {
					Some(geom) => (reverse(&geom), 0),
					None => {
						self.counts.write_failures += 1;
						continue;
					}
				}
			} else {
				// Lines keep extra precision until line merging, so rounding cannot create false shared endpoints.
				let scale = (u32::from(self.config.max_zoom.max(14)) - u32::from(zoom)).min(31 - 14);
				(reassemble_lines(groups), scale)
			};
			if geom.is_empty() {
				continue;
			}
			(self.emit)(RenderedFeature {
				z: zoom,
				x,
				y,
				layer: feature.layer,
				id: feature.id,
				geometry: encode_geometry(&geom, scale),
				sort_key: feature.sort_key,
				group: None,
			});
		}
		if polygon {
			let fill = encode_fill(settings.buffer_pixels);
			for (x, y) in sliced.filled_tiles() {
				(self.emit)(RenderedFeature {
					z: zoom,
					x,
					y,
					layer: feature.layer,
					id: feature.id,
					geometry: fill.clone(),
					sort_key: feature.sort_key,
					group: None,
				});
			}
		}
	}
}
