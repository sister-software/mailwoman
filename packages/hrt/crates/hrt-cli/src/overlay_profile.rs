// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The gazetteer overlay profile: the places of a `mailwoman gazetteer build geoparquet` export as two layers drawn
//! over the basemap.
//!
//! A row under `type=boundary` goes to the `boundaries` layer as a polygon, a row under `type=extent` to the
//! `extents` layer as the rectangle the gazetteer stores for the place, and a row under `type=point` to the
//! `points` layer. Each feature keeps the place's id as its feature id and carries the export's columns as
//! attributes, so a style can filter by placetype, source or row set and a click can read the place back.
//!
//! A placetype's minimum zoom keeps a tile's feature count bounded: countries draw from zoom 0 and neighborhoods
//! from zoom 10. A polygon below one pixel is dropped by the renderer's minimum size as in the basemap.

use hrt_osm::SourceFeature;
use hrt_profile::{Collector, CollectorConfig, Emitted, Input, Profile};

/// The overlay profile, built to `max_zoom`.
pub struct OverlayProfile {
	pub max_zoom: u8,
}

/// The zoom an overlay archive is built to unless the caller gives another. A client overzooms past it.
pub const DEFAULT_MAX_ZOOM: u8 = 12;

const BOUNDARIES: u32 = 0;
const POINTS: u32 = 1;
const EXTENTS: u32 = 2;
const LAYERS: [&str; 3] = ["boundaries", "points", "extents"];

/// The columns of the export that become string attributes.
const TEXT_ATTRIBUTES: [&str; 6] = ["name", "placetype", "country", "source", "boundary_source", "rowset"];

/// The columns of the export that become boolean attributes.
const FLAG_ATTRIBUTES: [&str; 3] = ["is_current", "is_deprecated", "is_superseded"];

/// The zooms a placetype's boundary and point first draw at.
fn min_zooms(placetype: &str) -> (i32, i32) {
	match placetype {
		"planet" | "continent" | "empire" | "country" | "dependency" | "disputed" | "marinearea" | "ocean" => (0, 0),
		"macroregion" | "region" => (2, 3),
		"macrocounty" | "county" => (5, 6),
		"localadmin" | "locality" => (7, 9),
		"borough" | "macrohood" => (9, 10),
		"neighbourhood" | "campus" => (10, 11),
		"microhood" | "postalcode" => (11, 12),
		_ => (9, 10),
	}
}

impl Profile for OverlayProfile {
	fn layers(&self) -> &[&'static str] {
		&LAYERS
	}

	fn max_zoom(&self) -> u8 {
		self.max_zoom
	}

	fn process(&self, source: &SourceFeature<'_>) -> Vec<Emitted> {
		let input = Input::new(source);
		let polygon_layer = match input.tag("type") {
			Some("boundary") => Some(BOUNDARIES),
			Some("extent") => Some(EXTENTS),
			Some("point") => None,
			_ => return Vec::new(),
		};
		let (boundary_zoom, point_zoom) = min_zooms(input.tag("placetype").unwrap_or_default());
		let max_zoom = i32::from(self.max_zoom);
		let mut collector = Collector::new(&input, CollectorConfig::new(self.max_zoom));
		let feature = if let Some(layer) = polygon_layer {
			if !input.can_be_polygon() {
				return Vec::new();
			}
			collector
				.polygon(layer)
				.set_zoom_range(boundary_zoom.min(max_zoom), max_zoom)
		} else {
			if !input.is_point() {
				return Vec::new();
			}
			collector.point(POINTS).set_zoom_range(point_zoom.min(max_zoom), max_zoom)
		};
		let id = input.tag("id").and_then(|text| text.parse::<i64>().ok());
		if let Some(id) = id {
			feature.set_id(id);
		}
		feature.set_attr("id", id);
		feature.set_attr("parent_id", input.tag("parent_id").and_then(|text| text.parse::<i64>().ok()));
		for key in TEXT_ATTRIBUTES {
			feature.set_attr(key, input.tag(key).filter(|text| !text.is_empty()));
		}
		for key in FLAG_ATTRIBUTES {
			feature.set_attr(key, input.tag(key).map(|text| text == "true"));
		}
		collector.finish()
	}

	fn metadata(&self) -> String {
		let fields: Vec<String> = ["id", "parent_id"]
			.iter()
			.map(|key| format!(r#""{key}":"Number""#))
			.chain(TEXT_ATTRIBUTES.iter().map(|key| format!(r#""{key}":"String""#)))
			.chain(FLAG_ATTRIBUTES.iter().map(|key| format!(r#""{key}":"Boolean""#)))
			.collect();
		let layers: Vec<String> = LAYERS
			.iter()
			.map(|layer| format!(r#"{{"id":"{layer}","fields":{{{}}}}}"#, fields.join(",")))
			.collect();
		format!(
			r#"{{"name":"hrt gazetteer overlay","format":"pbf","vector_layers":[{}]}}"#,
			layers.join(",")
		)
	}
}
