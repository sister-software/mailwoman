// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The Hilbert Rust Tiler's feature sort.
//!
//! Rendered features are stored as a 64-bit key, which orders them by Hilbert tile id, layer and sort key, and a value
//! holding the rest. An external merge sort orders the records, and [`Tiles`] groups them into tiles with Planetiler's
//! label-grid limits applied.

pub mod key;
pub mod record;
pub mod sorter;
pub mod tiles;

pub use key::encode_key;
pub use record::FeatureRecord;
pub use sorter::{ChunkWriter, Merged, Sorter};
pub use tiles::{TileFeatures, Tiles};
