// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The Hilbert Rust Tiler's Mapbox Vector Tile encoder.
//!
//! A tile is a list of layers. Each layer stores its attribute keys and values once, in tables that features index
//! into, and each feature's geometry as a sequence of commands: move to, line to and close path, with every
//! coordinate written as a zig-zag delta from the previous one. The specification is
//! <https://github.com/mapbox/vector-tile-spec/tree/master/2.1>.
//!
//! The encoder writes protocol buffer bytes directly, with no intermediate message objects.

mod decode;
mod geometry;
mod layer;
mod proto;

pub use decode::{decode_tile, DecodeError, DecodedFeature, DecodedLayer};
pub use geometry::Geometry;
pub use layer::{encode_tile, LayerBuilder, Value, DEFAULT_EXTENT};
