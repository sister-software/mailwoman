// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Prints every tile piece hrt-render produces for the fixed profile of `packages/hrt/parity/RenderDump.java`, in the
//! same line format.
//!
//! Usage: `cargo run --release -p hrt-render --example render-dump -- <input.osm.pbf> > rust.txt`
//!
//! The profile sends each tagged node to layer "p" as a point, each way or multipolygon that can be a polygon to layer
//! "a", and each remaining way to layer "l" as a line, with Planetiler's default settings for zooms 0 to 14.

use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use hrt_osm::{pass1, pass2, SourceFeature};
use hrt_render::geom::Seq;
use hrt_render::{Feature, Geom, GeometryType, Polygon, RenderConfig, RenderCounts, Renderer, ZoomSettings, MAX_ZOOM};

const LAYERS: [&str; 3] = ["p", "a", "l"];
const MAX_RENDER_ZOOM: u8 = 14;

fn seq(line: &geo::LineString) -> Seq {
	line.0.iter().map(|c| [c.x, c.y]).collect()
}

fn polygon(shape: &geo::Polygon) -> Polygon {
	Polygon {
		shell: seq(shape.exterior()),
		holes: shape.interiors().iter().map(seq).collect(),
	}
}

fn convert(geometry: &geo::Geometry) -> Geom {
	match geometry {
		geo::Geometry::Point(point) => Geom::Point([point.x(), point.y()]),
		geo::Geometry::LineString(line) => Geom::LineString(seq(line)),
		geo::Geometry::Polygon(shape) => Geom::Polygon(polygon(shape)),
		geo::Geometry::MultiPolygon(shapes) => Geom::MultiPolygon(shapes.0.iter().map(polygon).collect()),
		other => panic!("unexpected source geometry {other:?}"),
	}
}

/// Planetiler's defaults: below the rendering maximum, 1 pixel minimum size and 0.1 pixel tolerance; at it, 1/16 of a
/// pixel for both; points have no minimum size; every zoom has a 4 pixel buffer.
fn default_zooms(point: bool) -> [ZoomSettings; MAX_ZOOM as usize + 1] {
	std::array::from_fn(|zoom| {
		let at_max = zoom == MAX_RENDER_ZOOM as usize;
		ZoomSettings {
			buffer_pixels: 4.0,
			min_pixel_size: if point {
				0.0
			} else if at_max {
				256.0 / 4096.0
			} else {
				1.0
			},
			pixel_tolerance: if at_max { 256.0 / 4096.0 } else { 0.1 },
			label_grid_pixel_size: 0.0,
			label_grid_limit: 0,
		}
	})
}

fn profile(source: &SourceFeature<'_>) -> Option<Feature> {
	// The source size is WithGeometry.size(): the square root of the polygon area, else the line length.
	let (layer, geometry, source_size) = if source.is_point() {
		if source.tags.is_empty() {
			return None;
		}
		(0, convert(&source.world_geometry().ok()?), 0.0)
	} else if source.can_be_polygon() {
		let geometry = convert(&source.polygon().ok()?);
		let size = geometry.area().abs().sqrt();
		(1, geometry, size)
	} else if source.can_be_line() {
		let geometry = Geom::LineString(seq(&source.line().ok()?));
		let size = geometry.length();
		(2, geometry, size)
	} else {
		return None;
	};
	let point = geometry.geometry_type() == GeometryType::Point;
	Some(Feature {
		layer,
		id: source.kind.feature_id(source.id, 10),
		geometry,
		min_zoom: 0,
		max_zoom: MAX_RENDER_ZOOM,
		sort_key: 0,
		zooms: default_zooms(point),
		has_label_grid: false,
		source_size,
	})
}

fn type_name(geom_type: GeometryType) -> &'static str {
	match geom_type {
		GeometryType::Unknown => "UNKNOWN",
		GeometryType::Point => "POINT",
		GeometryType::Line => "LINE",
		GeometryType::Polygon => "POLYGON",
	}
}

fn main() {
	let input = PathBuf::from(std::env::args().nth(1).expect("usage: render-dump <input.osm.pbf>"));
	let state = pass1(&input, |_| true).unwrap();
	let out = Mutex::new(BufWriter::new(std::io::stdout()));
	let totals = Mutex::new(RenderCounts::default());
	pass2(&input, &state, |source| {
		let Some(feature) = profile(source) else {
			return;
		};
		let mut text = String::new();
		let mut emit = |rendered: hrt_render::RenderedFeature| {
			let group = rendered
				.group
				.map_or("-".to_owned(), |g| format!("{}:{}", g.id, g.limit));
			let commands = rendered
				.geometry
				.commands
				.iter()
				.map(u32::to_string)
				.collect::<Vec<_>>()
				.join(",");
			text.push_str(&format!(
				"{}/{}/{} {} {} {} {} s{} g{} {}\n",
				rendered.z,
				rendered.x,
				rendered.y,
				LAYERS[rendered.layer as usize],
				rendered.id,
				type_name(rendered.geometry.geom_type),
				rendered.geometry.scale,
				rendered.sort_key,
				group,
				commands
			));
		};
		let mut renderer = Renderer::new(
			RenderConfig {
				max_zoom: MAX_RENDER_ZOOM,
			},
			&mut emit,
		);
		renderer.render(&feature);
		let counts = renderer.counts;
		out.lock().unwrap().write_all(text.as_bytes()).unwrap();
		totals.lock().unwrap().add(&counts);
	})
	.unwrap();
	out.into_inner().unwrap().flush().unwrap();
	eprintln!("{:?}", totals.into_inner().unwrap());
}
