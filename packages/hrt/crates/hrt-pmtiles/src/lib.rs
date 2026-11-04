// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The Hilbert Rust Tiler's PMTiles v3 writer and reader.
//!
//! A PMTiles archive is one file: a 127-byte header, a root directory, JSON metadata, leaf directories, and the tile
//! data. Tiles are addressed by a Hilbert tile id that orders every tile of every zoom along one curve, which this
//! crate computes with the same rotation as the `pmtiles` reader the tile worker uses.
//!
//! The writer takes tiles in ascending tile id order, stores each distinct tile body once, and folds consecutive tiles
//! with the same body into one run. The specification is
//! <https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md>.

mod directory;
mod header;
mod reader;
mod tile_id;
mod writer;

pub use directory::{deserialize_directory, serialize_directory, Entry};
pub use header::{Compression, Header, TileType, HEADER_LENGTH};
pub use reader::{decompress, Reader};
pub use tile_id::{tile_id, tile_id_to_zxy, MAX_ZOOM};
pub use writer::{ArchiveSummary, Writer, WriterOptions};
