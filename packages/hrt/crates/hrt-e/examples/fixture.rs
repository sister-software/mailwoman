// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Writes a fixture archive for checking the encoder and the archive writer against independent readers.
//!
//! Every tile from zoom 0 through the given zoom holds one layer, `probe`, whose features record the tile's own
//! zoom, column and row. A reader that finds the right tile and decodes it recovers those numbers. Tile bodies vary in
//! length, so a deep enough archive needs leaf directories.
//!
//! Usage: `cargo run -p hrt-e --example fixture -- <out.pmtiles> <max zoom>`

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufWriter, Write};

use flate2::write::GzEncoder;
use hrt_e::{encode_tile, Geometry, LayerBuilder, Value, DEFAULT_EXTENT};
use hrt_pmtiles::{tile_id, Writer, WriterOptions};

fn tile_body(z: u8, x: u32, y: u32) -> Vec<u8> {
	let mut layer = LayerBuilder::new("probe", DEFAULT_EXTENT);
	let attributes = [
		("z", Value::UInt(u64::from(z))),
		("x", Value::UInt(u64::from(x))),
		("y", Value::UInt(u64::from(y))),
		("name", Value::String(format!("{z}/{x}/{y}"))),
		("offset", Value::Int(-(i64::from(x) + 1))),
		("ratio", Value::Double(f64::from(y) / 7.0)),
		("even", Value::Bool((x + y).is_multiple_of(2))),
	];

	layer.add_feature(
		Some(tile_id(z, x, y)),
		&Geometry::Points(vec![[2048, 2048]]),
		&attributes,
	);

	// A line whose vertex count varies by tile, so tile lengths vary.
	let vertices = 2 + ((x * 31 + y * 17) % 40) as i32;
	let line: Vec<[i32; 2]> = (0..vertices).map(|index| [index * 90, (index * 37) % 4096]).collect();
	layer.add_feature(
		None,
		&Geometry::Lines(vec![line]),
		&[("kind", Value::String("road".into()))],
	);

	// A square with a square hole, both given counter-clockwise on screen so the encoder must orient them.
	layer.add_feature(
		None,
		&Geometry::Polygons(vec![vec![
			vec![[100, 100], [100, 900], [900, 900], [900, 100]],
			vec![[300, 300], [300, 700], [700, 700], [700, 300]],
		]]),
		&[("kind", Value::String("park".into()))],
	);

	let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
	encoder.write_all(&encode_tile(&[layer])).unwrap();
	encoder.finish().unwrap()
}

fn main() {
	let mut args = std::env::args().skip(1);
	let out = args.next().expect("usage: fixture <out.pmtiles> <max zoom>");
	let max_zoom: u8 = args
		.next()
		.expect("usage: fixture <out.pmtiles> <max zoom>")
		.parse()
		.unwrap();

	let mut tiles = BTreeMap::new();
	for z in 0..=max_zoom {
		for x in 0..(1u32 << z) {
			for y in 0..(1u32 << z) {
				tiles.insert(tile_id(z, x, y), (z, x, y));
			}
		}
	}

	let mut writer = Writer::new(WriterOptions::default(), tempfile::tempfile().unwrap());
	for (&id, &(z, x, y)) in &tiles {
		writer.add_tile(id, &tile_body(z, x, y)).unwrap();
	}

	let metadata = br#"{"name":"hrt fixture","vector_layers":[{"id":"probe","fields":{}}]}"#;
	let mut file = BufWriter::new(File::create(&out).unwrap());
	let summary = writer.finish(metadata, &mut file).unwrap();
	file.flush().unwrap();

	println!("{summary:?}");
}
