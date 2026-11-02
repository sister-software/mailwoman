// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The Hilbert Rust Tiler's OpenStreetMap reader.
//!
//! It reads a PBF file in Planetiler's two passes and offers each element to the profile as a [`SourceFeature`] whose
//! geometry is built only on request. Coordinates are Web Mercator world units quantized exactly as Planetiler
//! quantizes them, so the Java and Rust builds see the same vertices.

pub mod coords;
pub mod elements;
pub mod multimap;
pub mod multipolygon;
pub mod nodes;
pub mod pbf;
pub mod reader;

pub use elements::{ElementKind, Member, Relation, Tags};
/// The `geo` geometry types source features are built in.
pub use geo::{Geometry, LineString};
pub use nodes::NodeStore;
pub use pbf::header_bounds;
pub use reader::{pass1, pass2, GeometryError, Pass1, Pass2Counts, RelationMember, SourceFeature};
