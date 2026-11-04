// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from the basemaps fork's layers/Infrastructure.java (BSD-3-Clause, Protomaps).

//! The `infrastructure` layer: power, telecom, emergency, barrier, road-network, water-network and street-furniture
//! features, with the model class a 3D renderer places at a street-furniture point.

use crate::{feature_id, Builder, Collector, CollectorConfig, Emitted, Input};

pub const LAYER_NAME: &str = "infrastructure";

/// The keys checked in order, each with its kept values and their minimum zooms; the first key with a kept value
/// classifies the feature.
const KEPT: [(&str, &[(&str, i32)]); 8] = [
	(
		"power",
		&[
			("line", 12),
			("minor_line", 14),
			("tower", 14),
			("pole", 15),
			("portal", 15),
			("substation", 13),
			("plant", 12),
			("generator", 15),
			("transformer", 15),
		],
	),
	(
		"telecom",
		&[
			("exchange", 14),
			("data_center", 14),
			("connection_point", 15),
			("line", 14),
		],
	),
	(
		"emergency",
		&[
			("fire_hydrant", 15),
			("water_tank", 15),
			("suction_point", 15),
			("defibrillator", 15),
			("siren", 15),
		],
	),
	(
		"barrier",
		&[
			("fence", 15),
			("wall", 15),
			("retaining_wall", 15),
			("hedge", 15),
			("gate", 15),
			("bollard", 15),
			("lift_gate", 15),
			("kerb", 15),
		],
	),
	// Nodes on the road network: signals, signs, crossings and lighting.
	(
		"highway",
		&[
			("traffic_signals", 15),
			("stop", 15),
			("give_way", 15),
			("crossing", 15),
			("street_lamp", 15),
			("speed_camera", 15),
			("traffic_mirror", 15),
		],
	),
	("natural", &[("tree_row", 15)]),
	(
		"man_made",
		&[
			("mast", 14),
			("tower", 14),
			("street_cabinet", 15),
			("water_tower", 14),
			("storage_tank", 15),
			("reservoir_covered", 15),
			("water_works", 13),
			("wastewater_plant", 13),
			("pumping_station", 15),
			("pipeline", 14),
			("embankment", 15),
			("manhole", 15),
			("utility_pole", 15),
		],
	),
	// Street furniture also in the pois layer, repeated here so every prop a 3D renderer places is in one layer.
	(
		"amenity",
		&[
			("bench", 15),
			("waste_basket", 15),
			("post_box", 15),
			("vending_machine", 15),
		],
	),
];

/// Keys kept only as points: the roads layer draws highway ways, and an amenity area is a building or a site.
const POINT_ONLY_KEYS: [&str; 2] = ["highway", "amenity"];

/// The model class a renderer places at a street-furniture point, by tag value.
const PROPS: [(&str, &str); 15] = [
	("bench", "bench"),
	("waste_basket", "waste_basket"),
	("post_box", "post_box"),
	("vending_machine", "vending_machine"),
	("fire_hydrant", "hydrant"),
	("bollard", "bollard"),
	("street_lamp", "lamp"),
	("traffic_signals", "signal"),
	("stop", "sign"),
	("give_way", "sign"),
	("speed_camera", "sign"),
	("traffic_mirror", "mirror"),
	("street_cabinet", "cabinet"),
	("utility_pole", "pole"),
	("pole", "pole"),
];

/// `man_made` values that belong to the water network rather than general structures.
const WATER_WORKS: [&str; 6] = [
	"water_tower",
	"storage_tank",
	"reservoir_covered",
	"water_works",
	"wastewater_plant",
	"pumping_station",
];
const WATER_SUBSTANCES: [&str; 4] = ["water", "sewage", "rainwater", "hot_water"];

/// Whether a closed way of this kind is still a line, such as a fence around a field.
fn is_linear(key: &str, value: &str) -> bool {
	key == "barrier" || matches!(value, "line" | "minor_line" | "tree_row" | "pipeline" | "embankment")
}

fn decorate(feature: &mut Builder, input: &Input<'_>, kind: &str, value: &str, min_zoom: i32) {
	feature
		.set_id(feature_id(input.source))
		.set_attr("kind", kind)
		.set_attr("kind_detail", value)
		.set_attr("operator", input.tag("operator"))
		.set_attr("voltage", input.tag("voltage"))
		.set_attr("name", input.tag("name"))
		.set_attr("medium", input.tag("telecom:medium"))
		.set_attr("crossing", input.tag("crossing"))
		.set_attr("kerb", input.tag("kerb"))
		.set_zoom_range(min_zoom, 15);
	if input.is_point() {
		let prop = PROPS.iter().find(|(tag, _)| *tag == value).map(|(_, prop)| *prop);
		feature
			.set_attr("prop", prop)
			.set_attr("direction", input.tag("direction"));
	}
}

/// `Infrastructure.processOsm`.
pub fn process_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	for (key, kept) in KEPT {
		let Some(value) = input.tag(key) else {
			continue;
		};
		let Some(&(_, min_zoom)) = kept.iter().find(|(candidate, _)| *candidate == value) else {
			continue;
		};
		if POINT_ONLY_KEYS.contains(&key) && !input.is_point() {
			continue;
		}

		let mut kind = if key == "man_made" && WATER_WORKS.contains(&value) {
			"water"
		} else {
			key
		};
		// A pipeline's substance decides its network: water and sewage are water, gas and oil stay man_made.
		if key == "man_made"
			&& value == "pipeline"
			&& input.tag("substance").is_some_and(|s| WATER_SUBSTANCES.contains(&s))
		{
			kind = "water";
		}
		// A mast or tower carrying antennas is part of the telecom network.
		if key == "man_made"
			&& (value == "mast" || value == "tower")
			&& input.tag("tower:type") == Some("communication")
		{
			kind = "telecom";
		}
		if key == "man_made" && value == "street_cabinet" && input.tag("street_cabinet") == Some("telecom") {
			kind = "telecom";
		}

		let mut collector = Collector::new(input, config);
		if input.is_point() {
			decorate(collector.point(layer), input, kind, value, min_zoom);
		} else if input.can_be_polygon() && !is_linear(key, value) {
			// Java starts the polygon, then starts and decorates the centroid, then decorates the polygon. Features are
			// emitted in start order, so the polygon still comes first.
			collector.polygon(layer).set_min_pixel_size(2.0);
			decorate(collector.centroid(layer), input, kind, value, min_zoom.max(15));
			decorate(collector.feature_mut(0), input, kind, value, min_zoom);
		} else if input.can_be_line() {
			decorate(
				collector.line(layer).set_min_pixel_size(0.0),
				input,
				kind,
				value,
				min_zoom,
			);
		} else {
			return;
		}
		features.extend(collector.finish());
		return;
	}
}
