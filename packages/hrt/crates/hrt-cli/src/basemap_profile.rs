// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The ported layers of the fork's `Basemap` profile, routed by source as `Basemap.java` routes them, for one or more
//! chosen layers at the production maxzoom of 15.

use std::sync::Mutex;

use hrt_osm::{Relation, SourceFeature};
use hrt_profile::country::CountryCoder;
use hrt_profile::layers::places::WikidataConfigs;
use hrt_profile::layers::{
	boundaries, buildings, earth, facilities, infrastructure, landuse, places, roads, transit, trees, water,
};
use hrt_profile::{CollectorConfig, Emitted, Input, Profile, TileFeature};
use hrt_render::snap::SnapCounts;

/// The layers this profile can build, in name order.
pub const PORTED_LAYERS: [&str; 11] = [
	boundaries::LAYER_NAME,
	buildings::LAYER_NAME,
	earth::LAYER_NAME,
	facilities::LAYER_NAME,
	infrastructure::LAYER_NAME,
	landuse::LAYER_NAME,
	places::LAYER_NAME,
	roads::LAYER_NAME,
	transit::LAYER_NAME,
	trees::LAYER_NAME,
	water::LAYER_NAME,
];
const MAX_ZOOM: u8 = 15;

/// The basemap profile over a chosen set of ported layers.
pub struct BasemapProfile {
	layers: Vec<&'static str>,
	countries: Option<CountryCoder>,
	/// The curated place zooms from the fork's `places.csv`; empty when none was given.
	pub wikidata: WikidataConfigs,
	/// Skips post-processing, leaving the features as rendered, to compare the merges' inputs.
	pub raw: bool,
	pub merge_counts: Mutex<SnapCounts>,
}

impl BasemapProfile {
	/// Builds the profile for `layers`, which must be names in [`PORTED_LAYERS`].
	pub fn new(layers: &[&str], countries: Option<CountryCoder>) -> Option<Self> {
		let mut chosen: Vec<&'static str> = Vec::new();
		for layer in layers {
			chosen.push(*PORTED_LAYERS.iter().find(|candidate| *candidate == layer)?);
		}
		chosen.sort_unstable();
		Some(BasemapProfile {
			layers: chosen,
			countries,
			wikidata: WikidataConfigs::default(),
			raw: false,
			merge_counts: Mutex::new(SnapCounts::default()),
		})
	}

	fn layer_id(&self, name: &str) -> Option<u32> {
		self.layers
			.iter()
			.position(|layer| *layer == name)
			.map(|index| index as u32)
	}
}

impl Profile for BasemapProfile {
	fn layers(&self) -> &[&'static str] {
		&self.layers
	}

	fn max_zoom(&self) -> u8 {
		MAX_ZOOM
	}

	fn keep_relation(&self, relation: &Relation) -> bool {
		(self.layer_id(roads::LAYER_NAME).is_some() && roads::keep_relation(relation))
			|| (self.layer_id(boundaries::LAYER_NAME).is_some() && boundaries::admin_record(relation).is_some())
	}

	fn process(&self, source: &SourceFeature<'_>) -> Vec<Emitted> {
		let config = CollectorConfig::new(MAX_ZOOM);
		let mut out = Vec::new();
		let osm = source.source == "osm";
		if let Some(layer) = self.layer_id(infrastructure::LAYER_NAME).filter(|_| osm) {
			infrastructure::process_osm(&Input::new(source), layer, &mut out, config);
		}
		if let Some(layer) = self.layer_id(facilities::LAYER_NAME).filter(|_| osm) {
			facilities::process_osm(&Input::new(source), layer, &mut out, config);
		}
		if let Some(layer) = self.layer_id(trees::LAYER_NAME).filter(|_| osm) {
			trees::process_osm(&Input::new(source), layer, &mut out, config);
		}
		if let Some(layer) = self.layer_id(landuse::LAYER_NAME).filter(|_| osm) {
			landuse::process_osm(&Input::new(source), layer, &mut out, config);
		}
		if let Some(layer) = self.layer_id(buildings::LAYER_NAME).filter(|_| osm) {
			buildings::process_osm(&Input::new(source), layer, &mut out, config);
		}
		if let Some(layer) = self.layer_id(places::LAYER_NAME).filter(|_| osm) {
			let mut input = Input::new(source);
			places::process_osm(
				&mut input,
				layer,
				self.countries.as_ref(),
				&self.wikidata,
				&mut out,
				config,
			);
		}
		if let Some(layer) = self.layer_id(boundaries::LAYER_NAME) {
			match source.source {
				"osm" => boundaries::process_osm(&Input::new(source), layer, &mut out, config),
				"ne" => boundaries::process_ne(&Input::new(source), layer, &mut out, config),
				_ => {}
			}
		}
		if let Some(layer) = self.layer_id(roads::LAYER_NAME) {
			if source.source == "osm" {
				let mut input = Input::new(source);
				roads::process_osm(&mut input, layer, self.countries.as_ref(), &mut out, config);
			}
		}
		if let Some(layer) = self.layer_id(water::LAYER_NAME) {
			let mut input = Input::new(source);
			match source.source {
				"osm" => water::process_osm(&mut input, layer, &mut out, config),
				"ne" => water::process_ne(&mut input, layer, &mut out, config),
				"osm_water" => water::process_prepared_osm(&input, layer, &mut out, config),
				_ => {}
			}
		}
		if let Some(layer) = self.layer_id(earth::LAYER_NAME) {
			let input = Input::new(source);
			match source.source {
				"osm" => earth::process_osm(&input, layer, &mut out, config),
				"ne" => earth::process_ne(&input, layer, &mut out, config),
				"osm_land" => earth::process_prepared_osm(&input, layer, &mut out, config),
				_ => {}
			}
		}
		out
	}

	fn post_process(&self, layer: &str, zoom: u8, features: Vec<TileFeature>) -> Vec<TileFeature> {
		if self.raw {
			return features;
		}
		let mut counts = SnapCounts::default();
		let out = match layer {
			roads::LAYER_NAME => roads::post_process(zoom, features, &mut counts),
			water::LAYER_NAME => water::post_process(features, &mut counts),
			earth::LAYER_NAME => earth::post_process(features, &mut counts),
			landuse::LAYER_NAME => landuse::post_process(zoom, features, &mut counts),
			boundaries::LAYER_NAME => boundaries::post_process(zoom, features, &mut counts),
			buildings::LAYER_NAME => buildings::post_process(zoom, features, &mut counts),
			_ => features,
		};
		let mut total = self.merge_counts.lock().unwrap();
		total.reduced += counts.reduced;
		total.fix_input += counts.fix_input;
		out
	}

	fn metadata(&self) -> String {
		let layers: Vec<String> = self
			.layers
			.iter()
			.map(|layer| format!(r#"{{"id":"{layer}","fields":{{}}}}"#))
			.collect();
		format!(
			r#"{{"name":"hrt basemap","format":"pbf","vector_layers":[{}]}}"#,
			layers.join(",")
		)
	}
}
