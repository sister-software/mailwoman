// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Prints every source feature hrt-osm offers a profile, in the line format of `packages/hrt/parity/OsmDump.java`.
//!
//! Usage: `cargo run --release -p hrt-osm --example parity-dump -- <input.osm.pbf> > rust.txt`
//!
//! Both programs keep every relation for membership. Sorting the two outputs and comparing them shows each feature
//! whose flags, memberships or coordinates differ.

use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use geo::{Geometry, LineString, Polygon};
use hrt_osm::{pass1, pass2, ElementKind, SourceFeature};

fn coords(line: &LineString) -> String {
	line.0
		.iter()
		.map(|c| format!("{:x},{:x}", c.x.to_bits(), c.y.to_bits()))
		.collect::<Vec<_>>()
		.join(" ")
}

fn polygon(polygon: &Polygon) -> String {
	std::iter::once(polygon.exterior())
		.chain(polygon.interiors())
		.map(coords)
		.collect::<Vec<_>>()
		.join("|")
}

fn geometry(geometry: &Geometry) -> String {
	match geometry {
		Geometry::Point(point) => format!("point {:x},{:x}", point.x().to_bits(), point.y().to_bits()),
		Geometry::LineString(line) => format!("line {}", coords(line)),
		Geometry::Polygon(shape) => format!("polygon {}", polygon(shape)),
		Geometry::MultiPolygon(shapes) => {
			format!("polygon {}", shapes.0.iter().map(polygon).collect::<Vec<_>>().join(";"))
		}
		other => panic!("unexpected geometry {other:?}"),
	}
}

fn line(feature: &SourceFeature<'_>) -> String {
	let kind = match feature.kind {
		ElementKind::Node => 'n',
		ElementKind::Way => 'w',
		ElementKind::Relation => 'r',
		ElementKind::Other => 'o',
	};
	let rels = feature
		.relations
		.iter()
		.map(|member| {
			let path = member
				.parent_path
				.iter()
				.map(i64::to_string)
				.collect::<Vec<_>>()
				.join("/");
			format!("{}:{}:{}", member.role, member.relation.id, path)
		})
		.collect::<Vec<_>>()
		.join(",");
	let geom = feature
		.world_geometry()
		.map_or_else(|_| "error".to_owned(), |g| geometry(&g));
	format!(
		"{kind}{} L{} P{} rels={rels} geom={geom}",
		feature.id,
		u8::from(feature.can_be_line()),
		u8::from(feature.can_be_polygon())
	)
}

fn main() {
	let input = PathBuf::from(std::env::args().nth(1).expect("usage: parity-dump <input.osm.pbf>"));
	let state = pass1(&input, |_| true).unwrap();
	let out = Mutex::new(BufWriter::new(std::io::stdout()));
	let counts = pass2(&input, &state, |feature| {
		let text = line(feature);
		writeln!(out.lock().unwrap(), "{text}").unwrap();
	})
	.unwrap();
	out.into_inner().unwrap().flush().unwrap();
	eprintln!("{} nodes stored, {counts:?}", state.nodes.len());
}
