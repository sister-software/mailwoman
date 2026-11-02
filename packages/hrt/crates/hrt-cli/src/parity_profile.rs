// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The fixed profile of `packages/hrt/parity/RenderDump.java`, for building archives the Java build can be compared
//! against.
//!
//! Each tagged node goes to layer "p" as a point, each way or multipolygon that can be a polygon to layer "a", and each
//! remaining way to layer "l" as a line, with Planetiler's default settings for zooms 0 to 14 and no attributes.

use hrt_osm::SourceFeature;
use hrt_render::{Feature, Geom, ZoomSettings, MAX_ZOOM};

use crate::pipeline::{Emitted, Profile};

/// The parity profile.
pub struct ParityProfile;

const LAYERS: [&str; 3] = ["p", "a", "l"];
const MAX_RENDER_ZOOM: u8 = 14;

/// Planetiler's defaults: below the rendering maximum, a 1 pixel minimum size and 0.1 pixel tolerance; at it, 1/16
/// of a pixel for both; points have no minimum size; every zoom has a 4 pixel buffer.
pub fn default_zooms(point: bool, max_render_zoom: u8) -> [ZoomSettings; MAX_ZOOM as usize + 1] {
	std::array::from_fn(|zoom| {
		let at_max = zoom == max_render_zoom as usize;
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

impl Profile for ParityProfile {
	fn layers(&self) -> &[&'static str] {
		&LAYERS
	}

	fn max_zoom(&self) -> u8 {
		MAX_RENDER_ZOOM
	}

	fn process(&self, source: &SourceFeature<'_>) -> Vec<Emitted> {
		// The source size is WithGeometry.size(): the square root of the polygon area, else the line length.
		let found = if source.is_point() {
			if source.tags.is_empty() {
				return Vec::new();
			}
			source
				.world_geometry()
				.ok()
				.map(|geometry| (0, Geom::from(&geometry), 0.0))
		} else if source.can_be_polygon() {
			source.polygon().ok().map(|geometry| {
				let geometry = Geom::from(&geometry);
				let size = geometry.area().abs().sqrt();
				(1, geometry, size)
			})
		} else if source.can_be_line() {
			source.line().ok().map(|line| {
				let geometry = Geom::from(&hrt_osm::Geometry::LineString(line));
				let size = geometry.length();
				(2, geometry, size)
			})
		} else {
			None
		};
		let Some((layer, geometry, source_size)) = found else {
			return Vec::new();
		};
		let point = geometry.is_puntal();
		vec![Emitted {
			feature: Feature {
				layer,
				id: source.kind.feature_id(source.id, 10),
				geometry,
				min_zoom: 0,
				max_zoom: MAX_RENDER_ZOOM,
				sort_key: 0,
				zooms: default_zooms(point, MAX_RENDER_ZOOM),
				has_label_grid: false,
				source_size,
			},
			attributes: Vec::new(),
		}]
	}

	fn metadata(&self) -> String {
		r#"{"name":"hrt parity profile","format":"pbf","vector_layers":[{"id":"a","fields":{}},{"id":"l","fields":{}},{"id":"p","fields":{}}]}"#
			.to_owned()
	}
}
