// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The Hilbert Rust Tiler's renderer.
//!
//! A profile hands the renderer [`Feature`]s in world coordinates. For each zoom the renderer scales and simplifies a
//! feature, slices it into the tiles it touches, snaps polygons to the tile grid, and encodes each piece as Mapbox Vector
//! Tile commands, following Planetiler 0.10.2's `FeatureRenderer` step for step.

pub mod commands;
pub mod geom;
pub mod groups;
pub mod range_set;
pub mod render;
pub mod simplify;
pub mod snap;
pub mod tiled;

pub use commands::VectorGeometry;
pub use geom::{Geom, GeometryType, Line, Polygon};
pub use render::{Feature, Group, RenderConfig, RenderCounts, RenderedFeature, Renderer, ZoomSettings, MAX_ZOOM};
