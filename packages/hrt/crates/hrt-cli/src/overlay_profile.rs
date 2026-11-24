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
///
/// Postcodes outnumber every other placetype: in the Amsterdam tile at zoom 12 they made up 6,501 of 6,768
/// points. A client downloads every layer of a tile, so postcodes go to an archive of their own. With
/// `postcodes_only` the profile writes only postcodes, into the `postcode_boundaries` and `postcode_points`
/// layers. Otherwise it writes every other placetype.
pub struct OverlayProfile {
	pub max_zoom: u8,
	pub postcodes_only: bool,
}

/// The zoom an overlay archive is built to unless the caller gives another. A client overzooms past it.
pub const DEFAULT_MAX_ZOOM: u8 = 12;

const BOUNDARIES: u32 = 0;
const POINTS: u32 = 1;
const EXTENTS: u32 = 2;
const LAYERS: [&str; 3] = ["boundaries", "points", "extents"];
const POSTCODE_LAYERS: [&str; 2] = ["postcode_boundaries", "postcode_points"];

/// The placetype the postcode archive holds and the main archive leaves out.
const POSTCODE_PLACETYPE: &str = "postalcode";

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
		if self.postcodes_only {
			&POSTCODE_LAYERS
		} else {
			&LAYERS
		}
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
		let placetype = input.tag("placetype").unwrap_or_default();
		if (placetype == POSTCODE_PLACETYPE) != self.postcodes_only
			|| (self.postcodes_only && polygon_layer == Some(EXTENTS))
		{
			return Vec::new();
		}
		let (boundary_zoom, point_zoom) = min_zooms(placetype);
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
			collector
				.point(POINTS)
				.set_zoom_range(point_zoom.min(max_zoom), max_zoom)
		};
		let id = input.tag("id").and_then(|text| text.parse::<i64>().ok());
		if let Some(id) = id {
			feature.set_id(id);
		}
		feature.set_attr("id", id);
		feature.set_attr(
			"parent_id",
			input.tag("parent_id").and_then(|text| text.parse::<i64>().ok()),
		);
		for key in TEXT_ATTRIBUTES {
			feature.set_attr(key, input.tag(key).filter(|text| !text.is_empty()));
		}
		for key in FLAG_ATTRIBUTES {
			feature.set_attr(key, input.tag(key).map(|text| text == "true"));
		}
		// The basemap sizes a place label by `population_rank`, so each overlay feature records the same rank.
		let population = input
			.tag("population")
			.and_then(|text| text.parse::<f64>().ok())
			.map(|value| value as i64);
		feature.set_attr("population", population);
		// The basemap's label expressions read `min_zoom`, the zoom where the label first draws.
		feature.set_attr("min_zoom", i64::from(point_zoom.min(max_zoom)));
		// A place with no recorded population ranks as the basemap ranks a population of 0.
		feature.set_attr(
			"population_rank",
			i64::from(hrt_profile::layers::places::population_rank(population.unwrap_or(0))),
		);
		collector.finish()
	}

	fn metadata(&self) -> String {
		let fields: Vec<String> = ["id", "parent_id", "population", "population_rank", "min_zoom"]
			.iter()
			.map(|key| format!(r#""{key}":"Number""#))
			.chain(TEXT_ATTRIBUTES.iter().map(|key| format!(r#""{key}":"String""#)))
			.chain(FLAG_ATTRIBUTES.iter().map(|key| format!(r#""{key}":"Boolean""#)))
			.collect();
		let layers: Vec<String> = self
			.layers()
			.iter()
			.map(|layer| format!(r#"{{"id":"{layer}","fields":{{{}}}}}"#, fields.join(",")))
			.collect();
		format!(
			r#"{{"name":"hrt gazetteer overlay","format":"pbf","vector_layers":[{}]}}"#,
			layers.join(",")
		)
	}
}
