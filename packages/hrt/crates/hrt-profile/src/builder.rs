// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from Planetiler 0.10.2's FeatureCollector (Apache-2.0, Copyright Michael Barry).

//! Building output features from a source feature, with Planetiler's per-zoom settings and attributes.

use geos::Geom as _;
use hrt_e::Value;
use hrt_render::snap::{from_geos, to_geos};
use hrt_render::{Feature, Geom, ZoomSettings};

use crate::input::Input;

/// Build-wide settings a feature's defaults come from.
#[derive(Clone, Copy, Debug)]
pub struct CollectorConfig {
	pub min_zoom: u8,
	pub max_zoom: u8,
	/// `max(maxzoom, 14)`: the zoom whose minimum size and tolerance use the at-maximum defaults.
	pub render_max_zoom: u8,
}

impl CollectorConfig {
	pub fn new(max_zoom: u8) -> Self {
		CollectorConfig {
			min_zoom: 0,
			max_zoom,
			render_max_zoom: max_zoom.max(14),
		}
	}
}

/// An attribute value, or one that appears only from a minimum zoom.
#[derive(Clone, Debug, PartialEq)]
enum Attr {
	Plain(Value),
	FromZoom(u8, Option<Value>),
}

/// An attribute of an emitted feature, present from `min_zoom` on.
#[derive(Clone, Debug, PartialEq)]
pub struct Attribute {
	pub key: String,
	pub value: Value,
	pub min_zoom: u8,
}

/// One feature a profile emits, with the attributes it writes and the zoom each appears from.
#[derive(Clone, Debug)]
pub struct Emitted {
	pub feature: Feature,
	pub attributes: Vec<Attribute>,
}

impl Emitted {
	/// Returns the attributes present at `zoom`.
	pub fn attributes_at(&self, zoom: u8) -> Vec<(String, Value)> {
		self.attributes
			.iter()
			.filter(|attribute| zoom >= attribute.min_zoom)
			.map(|attribute| (attribute.key.clone(), attribute.value.clone()))
			.collect()
	}
}

/// A feature being built, mirroring `FeatureCollector.Feature`.
#[derive(Clone, Debug)]
pub struct Builder {
	layer: u32,
	geometry: Geom,
	id: i64,
	attrs: Vec<(String, Attr)>,
	must_unwrap: bool,
	min_zoom: u8,
	max_zoom: u8,
	sort_key: i32,
	buffer_pixels: f64,
	min_pixel_size: f64,
	min_pixel_size_at_max_zoom: f64,
	pixel_tolerance: f64,
	pixel_tolerance_at_max_zoom: f64,
	label_grid_size: Option<(u8, f64)>,
	label_grid_limit: Option<(u8, i32)>,
	source_size: f64,
	config: CollectorConfig,
}

/// Values a builder's attribute setters accept.
pub trait IntoAttr {
	fn into_attr(self) -> Option<Value>;
}

impl IntoAttr for &str {
	fn into_attr(self) -> Option<Value> {
		Some(Value::String(self.to_owned()))
	}
}

impl IntoAttr for String {
	fn into_attr(self) -> Option<Value> {
		Some(Value::String(self))
	}
}

impl IntoAttr for i32 {
	/// Integers pass through Planetiler's msgpack as longs and reach the tile as `sint` values.
	fn into_attr(self) -> Option<Value> {
		Some(Value::Int(i64::from(self)))
	}
}

impl IntoAttr for i64 {
	fn into_attr(self) -> Option<Value> {
		Some(Value::Int(self))
	}
}

impl IntoAttr for f64 {
	fn into_attr(self) -> Option<Value> {
		Some(Value::Double(self))
	}
}

impl IntoAttr for bool {
	fn into_attr(self) -> Option<Value> {
		Some(Value::Bool(self))
	}
}

impl<T: IntoAttr> IntoAttr for Option<T> {
	fn into_attr(self) -> Option<Value> {
		self.and_then(IntoAttr::into_attr)
	}
}

impl Builder {
	fn new(layer: u32, geometry: Geom, id: i64, source_size: f64, config: CollectorConfig) -> Self {
		let point = geometry.is_puntal();
		Builder {
			layer,
			geometry,
			id,
			attrs: Vec::new(),
			must_unwrap: false,
			min_zoom: config.min_zoom,
			max_zoom: config.max_zoom,
			sort_key: 0,
			buffer_pixels: 4.0,
			min_pixel_size: if point { 0.0 } else { 1.0 },
			min_pixel_size_at_max_zoom: if point { 0.0 } else { 256.0 / 4096.0 },
			pixel_tolerance: 0.1,
			pixel_tolerance_at_max_zoom: 256.0 / 4096.0,
			label_grid_size: None,
			label_grid_limit: None,
			source_size,
			config,
		}
	}

	fn put(&mut self, key: &str, attr: Attr) {
		match self.attrs.iter_mut().find(|(existing, _)| existing == key) {
			Some((_, slot)) => *slot = attr,
			None => self.attrs.push((key.to_owned(), attr)),
		}
	}

	/// Sets an attribute; a missing value leaves any earlier value in place, as Planetiler's `setAttr` does.
	pub fn set_attr(&mut self, key: &str, value: impl IntoAttr) -> &mut Self {
		if let Some(value) = value.into_attr() {
			self.put(key, Attr::Plain(value));
		}
		self
	}

	/// Sets an attribute present from `min_zoom` on. A missing value still replaces any earlier one.
	pub fn set_attr_with_min_zoom(&mut self, key: &str, value: impl IntoAttr, min_zoom: i32) -> &mut Self {
		self.must_unwrap = true;
		self.put(key, Attr::FromZoom(min_zoom.clamp(0, 255) as u8, value.into_attr()));
		self
	}

	pub fn set_id(&mut self, id: i64) -> &mut Self {
		self.id = id;
		self
	}

	pub fn set_min_zoom(&mut self, zoom: i32) -> &mut Self {
		self.min_zoom = zoom.max(i32::from(self.config.min_zoom)).clamp(0, 255) as u8;
		self
	}

	pub fn set_max_zoom(&mut self, zoom: i32) -> &mut Self {
		self.max_zoom = zoom.min(i32::from(self.config.max_zoom)).clamp(0, 255) as u8;
		self
	}

	pub fn set_zoom_range(&mut self, min: i32, max: i32) -> &mut Self {
		self.set_min_zoom(min).set_max_zoom(max)
	}

	pub fn set_sort_key(&mut self, key: i32) -> &mut Self {
		self.sort_key = key;
		self
	}

	pub fn set_buffer_pixels(&mut self, pixels: f64) -> &mut Self {
		self.buffer_pixels = pixels;
		self
	}

	/// Sets the minimum size below the rendering maximum zoom.
	pub fn set_min_pixel_size(&mut self, pixels: f64) -> &mut Self {
		self.min_pixel_size = pixels;
		self
	}

	/// Sets the simplification tolerance below the rendering maximum zoom.
	pub fn set_pixel_tolerance(&mut self, pixels: f64) -> &mut Self {
		self.pixel_tolerance = pixels;
		self
	}

	pub fn set_pixel_tolerance_at_all_zooms(&mut self, pixels: f64) -> &mut Self {
		self.pixel_tolerance_at_max_zoom = pixels;
		self.pixel_tolerance = pixels;
		self
	}

	/// Planetiler's `setPointLabelGridSizeAndLimit`: the grid applies at zooms up to `max_zoom`.
	pub fn set_point_label_grid_size_and_limit(&mut self, max_zoom: u8, size: f64, limit: i32) -> &mut Self {
		self.label_grid_size = Some((max_zoom, size));
		self.label_grid_limit = Some((max_zoom, limit));
		self
	}

	fn zoom_settings(&self, zoom: u8) -> ZoomSettings {
		let at_max = zoom == self.config.render_max_zoom;
		ZoomSettings {
			buffer_pixels: self.buffer_pixels,
			min_pixel_size: if at_max {
				self.min_pixel_size_at_max_zoom
			} else {
				self.min_pixel_size
			},
			pixel_tolerance: if at_max {
				self.pixel_tolerance_at_max_zoom
			} else {
				self.pixel_tolerance
			},
			label_grid_pixel_size: self
				.label_grid_size
				.filter(|(max, _)| zoom <= *max)
				.map_or(0.0, |(_, size)| size),
			label_grid_limit: self
				.label_grid_limit
				.filter(|(max, _)| zoom <= *max)
				.map_or(0, |(_, limit)| limit),
		}
	}

	fn finish(self) -> Emitted {
		let zooms = std::array::from_fn(|zoom| self.zoom_settings(zoom as u8));
		// Without a zoom-dependent attribute Planetiler writes the map as it stands, empty strings included; with one it
		// unwraps every value and drops the missing and empty ones.
		let attributes = self
			.attrs
			.iter()
			.filter_map(|(key, attr)| {
				let (value, min_zoom) = match attr {
					Attr::Plain(value) => (value.clone(), 0),
					Attr::FromZoom(zoom, value) => (value.clone()?, *zoom),
				};
				if self.must_unwrap && value == Value::String(String::new()) {
					return None;
				}
				Some(Attribute {
					key: key.clone(),
					value,
					min_zoom,
				})
			})
			.collect();
		Emitted {
			feature: Feature {
				layer: self.layer,
				id: self.id,
				geometry: self.geometry,
				min_zoom: self.min_zoom,
				max_zoom: self.max_zoom,
				sort_key: self.sort_key,
				zooms,
				has_label_grid: self.label_grid_size.is_some() || self.label_grid_limit.is_some(),
				source_size: self.source_size,
			},
			attributes,
		}
	}
}

/// Collects the features a layer emits for one source feature, as Planetiler's `FeatureCollector`.
pub struct Collector<'a> {
	input: &'a Input<'a>,
	config: CollectorConfig,
	features: Vec<Builder>,
}

fn source_size(input: &Input<'_>) -> f64 {
	let source = input.source;
	if source.can_be_polygon() {
		source
			.polygon()
			.map_or(0.0, |geometry| Geom::from(&geometry).area().abs().sqrt())
	} else if source.can_be_line() {
		source
			.line()
			.map_or(0.0, |line| Geom::from(&hrt_osm::Geometry::LineString(line)).length())
	} else {
		0.0
	}
}

fn interior_point(geometry: &Geom) -> Option<Geom> {
	let point = to_geos(geometry).ok()?.point_on_surface().ok()?;
	from_geos(&point).ok().filter(|geom| !geom.is_empty())
}

fn centroid(geometry: &Geom) -> Option<Geom> {
	let point = to_geos(geometry).ok()?.get_centroid().ok()?;
	from_geos(&point).ok().filter(|geom| !geom.is_empty())
}

impl<'a> Collector<'a> {
	pub fn new(input: &'a Input<'a>, config: CollectorConfig) -> Self {
		Collector {
			input,
			config,
			features: Vec::new(),
		}
	}

	fn start(&mut self, layer: u32, geometry: Option<Geom>) -> &mut Builder {
		let source = self.input.source;
		// Planetiler's default id: the element id times 10, plus 1, 2 or 3 for a node, way or relation.
		let id = source.kind.feature_id(source.id, 10);
		let builder = Builder::new(
			layer,
			geometry.unwrap_or_else(Geom::empty),
			id,
			source_size(self.input),
			self.config,
		);
		self.features.push(builder);
		self.features.last_mut().unwrap()
	}

	fn polygon_geometry(&self) -> Option<Geom> {
		self.input.source.polygon().ok().map(|geometry| Geom::from(&geometry))
	}

	fn line_geometry(&self) -> Option<Geom> {
		self.input
			.source
			.line()
			.ok()
			.map(|line| Geom::from(&hrt_osm::Geometry::LineString(line)))
	}

	/// A feature with an explicit geometry in world coordinates, as Planetiler's `FeatureCollector.geometry`.
	pub fn geometry(&mut self, layer: u32, geometry: Geom) -> &mut Builder {
		self.start(layer, Some(geometry))
	}

	/// The source as a polygon, or an empty feature when it cannot be one.
	pub fn polygon(&mut self, layer: u32) -> &mut Builder {
		let geometry = self.polygon_geometry();
		self.start(layer, geometry)
	}

	/// The source as a line, or an empty feature when it cannot be one.
	pub fn line(&mut self, layer: u32) -> &mut Builder {
		let geometry = self.line_geometry();
		self.start(layer, geometry)
	}

	/// The source point, or an empty feature when the source is not a point.
	pub fn point(&mut self, layer: u32) -> &mut Builder {
		let geometry = if self.input.is_point() {
			self.input
				.source
				.world_geometry()
				.ok()
				.map(|geometry| Geom::from(&geometry))
		} else {
			None
		};
		self.start(layer, geometry)
	}

	/// The polygon's, else the line's, else the point's interior point, as JTS's `getInteriorPoint` computes it.
	pub fn point_on_surface(&mut self, layer: u32) -> &mut Builder {
		let base = if self.input.can_be_polygon() {
			self.polygon_geometry()
		} else if self.input.can_be_line() {
			self.line_geometry()
		} else {
			self.input
				.source
				.world_geometry()
				.ok()
				.map(|geometry| Geom::from(&geometry))
		};
		let geometry = base.as_ref().and_then(interior_point);
		self.start(layer, geometry)
	}

	/// The polygon's, else the line's, else the point's centroid.
	pub fn centroid(&mut self, layer: u32) -> &mut Builder {
		let base = if self.input.can_be_polygon() {
			self.polygon_geometry()
		} else if self.input.can_be_line() {
			self.line_geometry()
		} else {
			self.input
				.source
				.world_geometry()
				.ok()
				.map(|geometry| Geom::from(&geometry))
		};
		let geometry = base.as_ref().and_then(centroid);
		self.start(layer, geometry)
	}

	/// Returns the features built, dropping those with empty geometry.
	pub fn finish(self) -> Vec<Emitted> {
		self.features
			.into_iter()
			.filter(|builder| !builder.geometry.is_empty())
			.map(Builder::finish)
			.collect()
	}

	/// Returns the area of the source polygon in world units, or 0 when it cannot be one.
	pub fn source_area(&self) -> f64 {
		if self.input.can_be_polygon() {
			self.polygon_geometry().map_or(0.0, |geometry| geometry.area().abs())
		} else {
			0.0
		}
	}
}
