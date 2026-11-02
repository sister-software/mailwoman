// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt merge-probe`: one tile's polygon merge, step by step, for comparison with `packages/hrt/parity/MergeProbe.java`.
//!
//! The command reads one tile from an archive built without post-processing, writes its polygon features to a text
//! file the Java probe reads, and prints what the water layer's polygon merge does with them: each proximity group, the
//! area after buffering and union, the area after snapping, and the polygons kept.

use std::fmt::Write as _;
use std::io::{self, Write};
use std::path::Path;

use geos::{BufferParams, Geom as _, Geometry, JoinStyle};
use hrt_e::{decode_tile, Value};
use hrt_pmtiles::{tile_id, Reader};
use hrt_profile::merge::decode;
use hrt_render::snap::{from_geos, snap_and_fix_polygon, to_geos, SnapCounts};
use hrt_render::{Geom, GeometryType, VectorGeometry};

fn value_text(value: &Value) -> String {
	match value {
		Value::String(text) => format!("s:{text}"),
		Value::Int(number) => format!("i:{number}"),
		Value::Double(number) => format!("d:{number}"),
		other => format!("{other:?}"),
	}
}

/// Writes the polygon features of `layer` on tile `z/x/y` of `archive` to `features_out`, one per line as
/// `<id>\t<attrs>\t<commands>`, and prints the merge steps for the group with `kind_detail` `detail`.
pub fn probe(archive: &Path, z: u8, x: u32, y: u32, layer: &str, detail: &str, features_out: &Path) -> io::Result<()> {
	let reader = Reader::open(archive)?;
	let id = tile_id(z, x, y);
	let entry = reader
		.entries()?
		.into_iter()
		.find(|entry| entry.tile_id <= id && id < entry.tile_id + u64::from(entry.run_length))
		.ok_or_else(|| io::Error::other("tile not in the archive"))?;
	let layers = decode_tile(&reader.tile(&entry)?).map_err(|error| io::Error::other(error.0))?;
	let features = &layers
		.iter()
		.find(|candidate| candidate.name == layer)
		.ok_or_else(|| io::Error::other("layer not in the tile"))?
		.features;

	let mut file = std::fs::File::create(features_out)?;
	let mut group = Vec::new();
	for feature in features.iter().filter(|feature| feature.geom_type == 3) {
		let mut attributes: Vec<String> = feature
			.attributes
			.iter()
			.map(|(key, value)| format!("{key}={}", value_text(value)))
			.collect();
		attributes.sort();
		let commands: Vec<String> = feature.commands.iter().map(u32::to_string).collect();
		writeln!(
			file,
			"{}\t{}\t{}",
			feature.id.unwrap_or(0),
			attributes.join(";"),
			commands.join(",")
		)?;
		if feature
			.attributes
			.iter()
			.any(|(key, value)| key == "kind_detail" && *value == Value::String(detail.to_owned()))
		{
			group.push(decode(&VectorGeometry {
				commands: feature.commands.clone(),
				geom_type: GeometryType::Polygon,
				scale: 0,
			}));
		}
	}

	let mut params = BufferParams::new().map_err(io::Error::other)?;
	params.set_join_style(JoinStyle::Mitre).map_err(io::Error::other)?;
	let mut out = String::new();
	let _ = writeln!(out, "{} features with kind_detail={detail}", group.len());
	for (index, geom) in group.iter().enumerate() {
		let _ = writeln!(
			out,
			"  input {index}: area {:.4}, {} points",
			geom.area(),
			geom.num_points()
		);
	}
	let buffered: Vec<Geometry> = group
		.iter()
		.map(|geom| to_geos(geom).and_then(|g| g.buffer_with_params(0.0625, &params)))
		.collect::<geos::GResult<_>>()
		.map_err(io::Error::other)?;
	let collection = Geometry::create_geometry_collection(buffered).map_err(io::Error::other)?;
	let union = collection.unary_union().map_err(io::Error::other)?;
	let unbuffered = union.buffer_with_params(-0.0625, &params).map_err(io::Error::other)?;
	let merged: Geom = from_geos(&unbuffered).map_err(io::Error::other)?;
	let _ = writeln!(
		out,
		"  union area {:.4}; after unbuffer area {:.4}, {} points, valid {}",
		union.area().unwrap_or(-1.0),
		merged.area(),
		merged.num_points(),
		unbuffered.is_valid().unwrap_or(false)
	);
	let mut counts = SnapCounts::default();
	match snap_and_fix_polygon(&merged, &mut counts) {
		Ok(snapped) => {
			let _ = writeln!(
				out,
				"  snapped area {:.4}, {} points; {counts:?}",
				snapped.area(),
				snapped.num_points()
			);
		}
		Err(error) => {
			let _ = writeln!(out, "  snap failed: {error:?}");
		}
	}
	print!("{out}");
	Ok(())
}
