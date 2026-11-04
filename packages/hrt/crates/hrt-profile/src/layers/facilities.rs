// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from the basemaps fork's layers/Facilities.java (BSD-3-Clause, Protomaps).

//! The `facilities` layer: power plants, data centers, postal depots and telephone exchanges as points, and submarine
//! cables as lines.

use crate::parse::parse_double_or_null;
use crate::{Collector, CollectorConfig, Emitted, Input};

pub const LAYER_NAME: &str = "facilities";

/// The output in megawatts at or above which a power plant draws from [`LARGE_PLANT_MIN_ZOOM`].
const LARGE_PLANT_MW: f64 = 500.0;
const LARGE_PLANT_MIN_ZOOM: i32 = 5;
const PLANT_MIN_ZOOM: i32 = 8;
const DATA_CENTER_MIN_ZOOM: i32 = 9;
const POST_DEPOT_MIN_ZOOM: i32 = 10;
const EXCHANGE_MIN_ZOOM: i32 = 12;
const SUBMARINE_CABLE_MIN_ZOOM: i32 = 2;

/// Whether a way is an undersea telecom or power cable, as the seamark or the cable's location tags record it.
fn is_submarine_cable(input: &Input<'_>) -> bool {
	if input.tag("seamark:type") == Some("cable_submarine") {
		return true;
	}
	let cable = input.tag("communication") == Some("line")
		|| input.tag("telecom") == Some("line")
		|| input.tag("power") == Some("cable");
	cable && (input.has_tag_in("location", &["underwater", "submarine"]) || input.tag("submarine") == Some("yes"))
}

/// The fork's `megawatts`: an output such as `1200 MW`, `450MW` or `3 GW` in megawatts, or `None` without a GW, MW or
/// kW unit.
fn megawatts(value: Option<&str>) -> Option<f64> {
	// Java's `trim` removes characters up to U+0020; `toLowerCase` matters only for the unit letters compared here.
	let text = value?.trim_matches(|c: char| c <= ' ').to_lowercase();
	let (number, scale) = [("gw", 1000.0), ("mw", 1.0), ("kw", 0.001)]
		.into_iter()
		.find_map(|(unit, scale)| text.strip_suffix(unit).map(|number| (number, scale)))?;
	parse_double_or_null(Some(number.trim_matches(|c: char| c <= ' '))).map(|number| number * scale)
}

/// `Facilities.processOsm`.
pub fn process_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	let mut collector = Collector::new(input, config);
	if input.can_be_line() && !input.can_be_polygon() && is_submarine_cable(input) {
		collector
			.line(layer)
			.set_attr("kind", "submarine_cable")
			.set_attr("name", input.tag("name"))
			.set_attr("operator", input.tag("operator"))
			.set_zoom_range(SUBMARINE_CABLE_MIN_ZOOM, 15)
			.set_min_pixel_size(0.0);
		features.extend(collector.finish());
		return;
	}

	let mut output_mw = None;
	let (kind, min_zoom) = if input.tag("power") == Some("plant") {
		output_mw = megawatts(input.tag("plant:output:electricity"));
		let large = output_mw.is_some_and(|output| output >= LARGE_PLANT_MW);
		("power_plant", if large { LARGE_PLANT_MIN_ZOOM } else { PLANT_MIN_ZOOM })
	} else if input.tag("telecom") == Some("data_center") || input.tag("building") == Some("data_center") {
		("data_center", DATA_CENTER_MIN_ZOOM)
	} else if input.tag("amenity") == Some("post_depot") {
		("post_depot", POST_DEPOT_MIN_ZOOM)
	} else if input.tag("telecom") == Some("exchange") {
		("telecom_exchange", EXCHANGE_MIN_ZOOM)
	} else {
		return;
	};

	let feature = if input.is_point() {
		collector.point(layer)
	} else if input.can_be_polygon() {
		collector.point_on_surface(layer)
	} else {
		return;
	};
	feature
		.set_attr("kind", kind)
		.set_attr("name", input.tag("name"))
		.set_attr("operator", input.tag("operator"))
		.set_attr("source", input.tag("plant:source"))
		.set_attr("output_mw", output_mw)
		.set_zoom_range(min_zoom, 15);
	features.extend(collector.finish());
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn outputs_convert_to_megawatts() {
		assert_eq!(megawatts(Some("1200 MW")), Some(1200.0));
		assert_eq!(megawatts(Some("3 GW")), Some(3000.0));
		assert_eq!(megawatts(Some("450MW")), Some(450.0));
		assert_eq!(megawatts(Some("500 kW")), Some(0.5));
		assert_eq!(megawatts(Some("yes")), None);
		assert_eq!(megawatts(None), None);
	}
}
