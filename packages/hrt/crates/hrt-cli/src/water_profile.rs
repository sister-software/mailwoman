// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The water layer alone, from OpenStreetMap, as `packages/hrt/parity/WaterDump.java` builds it.

use std::sync::Mutex;

use hrt_osm::SourceFeature;
use hrt_profile::layers::water;
use hrt_profile::{CollectorConfig, Emitted, Input, Profile, TileFeature};
use hrt_render::snap::SnapCounts;

/// The water-only profile at the production build's maxzoom of 15.
#[derive(Default)]
pub struct WaterProfile {
	pub merge_counts: Mutex<SnapCounts>,
	/// Skips post-processing, leaving the features as rendered, to compare the merge's inputs.
	pub raw: bool,
}

const LAYERS: [&str; 1] = [water::LAYER_NAME];
const MAX_ZOOM: u8 = 15;

impl Profile for WaterProfile {
	fn layers(&self) -> &[&'static str] {
		&LAYERS
	}

	fn max_zoom(&self) -> u8 {
		MAX_ZOOM
	}

	fn process(&self, source: &SourceFeature<'_>) -> Vec<Emitted> {
		let mut input = Input::new(source);
		let mut out = Vec::new();
		water::process_osm(&mut input, 0, &mut out, CollectorConfig::new(MAX_ZOOM));
		out
	}

	fn post_process(&self, layer: &str, _zoom: u8, features: Vec<TileFeature>) -> Vec<TileFeature> {
		if layer != water::LAYER_NAME || self.raw {
			return features;
		}
		let mut counts = SnapCounts::default();
		let out = water::post_process(features, &mut counts);
		let mut total = self.merge_counts.lock().unwrap();
		total.reduced += counts.reduced;
		total.fix_input += counts.fix_input;
		out
	}

	fn metadata(&self) -> String {
		r#"{"name":"hrt water","format":"pbf","vector_layers":[{"id":"water","fields":{}}]}"#.to_owned()
	}
}
