// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The Hilbert Rust Tiler's basemap profile.
//!
//! Layers match source features against rule tables ([`expr`]), build output features with Planetiler's per-zoom
//! settings ([`builder`]), and write OpenStreetMap names ([`names`]), each following the Java profile in the
//! `mailwoman/basemaps` fork.

pub mod builder;
pub mod building_buffers;
pub mod clip;
pub mod country;
pub mod expr;
pub mod input;
pub mod layers;
pub mod line_merger;
pub mod locales;
pub mod merge;
pub mod names;
pub mod parse;
pub mod pgf;
pub mod smoothing;
pub mod sort_key;

pub use builder::{Attribute, Builder, Collector, CollectorConfig, Emitted};
pub use input::Input;

use hrt_e::Value;
use hrt_osm::{Relation, SourceFeature};
use hrt_render::VectorGeometry;

/// One feature of one layer in one tile, as post-processing sees it. Lines still carry the extra precision they were
/// rendered with; the pipeline reduces them to the tile extent after post-processing.
#[derive(Clone, Debug, PartialEq)]
pub struct TileFeature {
	pub id: i64,
	pub geometry: VectorGeometry,
	pub attributes: Vec<(String, Value)>,
}

/// One tile's features by layer name.
pub type TileLayers = Vec<(&'static str, Vec<TileFeature>)>;

/// What a build needs from a profile.
pub trait Profile: Sync {
	/// The layer names, indexed by the layer ids features carry; tiles write layers in name order regardless.
	fn layers(&self) -> &[&'static str];
	/// The highest zoom the build renders.
	fn max_zoom(&self) -> u8;
	/// Returns whether pass 1 keeps a relation for membership lookups.
	fn keep_relation(&self, _relation: &Relation) -> bool {
		false
	}
	/// Maps one source feature to the features it emits.
	fn process(&self, source: &SourceFeature<'_>) -> Vec<Emitted>;
	/// Rewrites a whole tile's layers, in name order, as Planetiler's `postProcessTileFeatures` does. It runs before
	/// [`Profile::post_process`], and a layer it leaves without features is dropped.
	fn post_process_tile(&self, _z: u8, _x: u32, _y: u32, layers: TileLayers) -> TileLayers {
		layers
	}
	/// Rewrites one layer's features in one tile, as Planetiler's `postProcessLayerFeatures` does.
	fn post_process(&self, _layer: &str, _zoom: u8, features: Vec<TileFeature>) -> Vec<TileFeature> {
		features
	}
	/// The archive metadata JSON.
	fn metadata(&self) -> String;
}

/// The fork's `FeatureId.create`: the element type in bits 44 and up, 1 for a node, 2 for a way and 3 for a relation,
/// over the element id; a feature from another source keeps its own id.
pub fn feature_id(source: &SourceFeature<'_>) -> i64 {
	let element_type: i64 = match source.kind {
		hrt_osm::ElementKind::Node => 1,
		hrt_osm::ElementKind::Way => 2,
		hrt_osm::ElementKind::Relation => 3,
		hrt_osm::ElementKind::Other => return source.id,
	};
	(element_type << 44) | source.id
}
