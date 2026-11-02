// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt clock`: comparing two archives tile by tile under the parity contract of issue #2902.
//!
//! Two archives agree on a tile when both have it and, for every layer, the two layers hold the same multiset of
//! features. A feature is compared by id, geometry type, attribute map, and geometry decoded to absolute coordinates.
//! A polygon ring is rotated to start at its smallest vertex first, because GEOS's precision reducer can start a ring
//! at a different vertex from JTS's while describing the same polygon. Feature order within a layer is reported
//! separately, since equal sort keys leave it open.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io;
use std::path::Path;

use hrt_e::{decode_tile, DecodedFeature, Value};
use hrt_pmtiles::{tile_id_to_zxy, Entry, Reader};

/// A feature in comparable form.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Canonical {
	pub id: Option<u64>,
	pub geom_type: u64,
	pub attributes: Vec<(String, String)>,
	pub parts: Vec<Vec<[i32; 2]>>,
}

fn value_text(value: &Value) -> String {
	match value {
		Value::String(text) => format!("s:{text}"),
		Value::Float(number) => format!("f:{number:e}"),
		Value::Double(number) => format!("d:{number:e}"),
		Value::Int(number) => format!("i:{number}"),
		Value::UInt(number) => format!("i:{number}"),
		Value::Bool(flag) => format!("b:{flag}"),
	}
}

fn zig_zag_decode(value: u32) -> i32 {
	((value >> 1) as i32) ^ -((value & 1) as i32)
}

/// Decodes commands into parts of absolute coordinates; a closed ring omits its repeated start.
fn parts(commands: &[u32]) -> Vec<Vec<[i32; 2]>> {
	let mut out: Vec<Vec<[i32; 2]>> = Vec::new();
	let (mut x, mut y) = (0i32, 0i32);
	let mut i = 0;
	while i < commands.len() {
		let id = commands[i] & 7;
		let count = commands[i] >> 3;
		i += 1;
		if id == 7 {
			continue;
		}
		for _ in 0..count {
			if i + 1 >= commands.len() {
				return out;
			}
			x = x.wrapping_add(zig_zag_decode(commands[i]));
			y = y.wrapping_add(zig_zag_decode(commands[i + 1]));
			i += 2;
			// Every MoveTo point starts a part: one per line or ring, one per point of a multipoint.
			if id == 1 {
				out.push(Vec::new());
			}
			if let Some(part) = out.last_mut() {
				part.push([x, y]);
			}
		}
	}
	out
}

/// Returns the feature in comparable form, with polygon rings rotated to start at their smallest vertex.
pub fn canonical(feature: &DecodedFeature) -> Canonical {
	let mut attributes: Vec<(String, String)> = feature
		.attributes
		.iter()
		.map(|(key, value)| (key.clone(), value_text(value)))
		.collect();
	attributes.sort();
	let mut parts = parts(&feature.commands);
	if feature.geom_type == 3 {
		for ring in &mut parts {
			if let Some(start) = (0..ring.len()).min_by_key(|&index| ring[index]) {
				ring.rotate_left(start);
			}
		}
	}
	Canonical {
		id: feature.id,
		geom_type: feature.geom_type,
		attributes,
		parts,
	}
}

/// Counts from comparing two archives.
#[derive(Debug, Default)]
pub struct ClockReport {
	pub tiles_a: usize,
	pub tiles_b: usize,
	pub only_in_a: usize,
	pub only_in_b: usize,
	pub identical_bytes: usize,
	pub equal_contents: usize,
	pub different: usize,
	pub order_only: usize,
	pub features_compared: usize,
	pub details: Vec<String>,
}

fn expand(reader: &Reader) -> io::Result<BTreeMap<u64, Entry>> {
	let mut tiles = BTreeMap::new();
	for entry in reader.entries()? {
		for offset in 0..u64::from(entry.run_length) {
			tiles.insert(entry.tile_id + offset, entry);
		}
	}
	Ok(tiles)
}

fn tile_name(id: u64) -> String {
	let (z, x, y) = tile_id_to_zxy(id);
	format!("{z}/{x}/{y}")
}

fn describe(feature: Option<&Canonical>) -> String {
	match feature {
		None => "(none)".to_owned(),
		Some(feature) => {
			let mut text = format!(
				"id={:?} type={} attrs={:?} parts=",
				feature.id, feature.geom_type, feature.attributes
			);
			for part in feature.parts.iter().take(3) {
				let _ = write!(text, "[{} points from {:?}]", part.len(), part.first());
			}
			text
		}
	}
}

/// Compares archives `a` and `b`, keeping the first `max_details` differences as text.
pub fn compare(a: &Path, b: &Path, max_details: usize) -> io::Result<ClockReport> {
	let reader_a = Reader::open(a)?;
	let reader_b = Reader::open(b)?;
	let tiles_a = expand(&reader_a)?;
	let tiles_b = expand(&reader_b)?;
	let mut report = ClockReport {
		tiles_a: tiles_a.len(),
		tiles_b: tiles_b.len(),
		..ClockReport::default()
	};
	let note = |report: &mut ClockReport, text: String| {
		if report.details.len() < max_details {
			report.details.push(text);
		}
	};

	for (&id, entry_a) in &tiles_a {
		let Some(entry_b) = tiles_b.get(&id) else {
			report.only_in_a += 1;
			note(&mut report, format!("{} only in the first archive", tile_name(id)));
			continue;
		};
		let bytes_a = reader_a.tile(entry_a)?;
		let bytes_b = reader_b.tile(entry_b)?;
		if bytes_a == bytes_b {
			report.identical_bytes += 1;
			report.equal_contents += 1;
			continue;
		}
		let layers_a = decode_tile(&bytes_a).map_err(|error| io::Error::other(error.0))?;
		let layers_b = decode_tile(&bytes_b).map_err(|error| io::Error::other(error.0))?;
		let by_name = |layers: &[hrt_e::DecodedLayer]| {
			layers
				.iter()
				.map(|layer| {
					(
						layer.name.clone(),
						layer.features.iter().map(canonical).collect::<Vec<_>>(),
					)
				})
				.collect::<BTreeMap<_, _>>()
		};
		let named_a = by_name(&layers_a);
		let named_b = by_name(&layers_b);
		let mut equal = named_a.keys().eq(named_b.keys());
		let mut ordered = true;
		let mut detail = None;
		for (name, features_a) in &named_a {
			let Some(features_b) = named_b.get(name) else {
				detail.get_or_insert_with(|| format!("{} layer {name} only in the first archive", tile_name(id)));
				continue;
			};
			report.features_compared += features_a.len();
			if features_a != features_b {
				ordered = false;
			}
			let mut sorted_a = features_a.clone();
			let mut sorted_b = features_b.clone();
			sorted_a.sort();
			sorted_b.sort();
			if sorted_a != sorted_b {
				equal = false;
				let index = (0..sorted_a.len().max(sorted_b.len()))
					.find(|&index| sorted_a.get(index) != sorted_b.get(index))
					.unwrap_or(0);
				detail.get_or_insert_with(|| {
					format!(
						"{} layer {name}: {} vs {} features; first difference\n    a: {}\n    b: {}",
						tile_name(id),
						sorted_a.len(),
						sorted_b.len(),
						describe(sorted_a.get(index)),
						describe(sorted_b.get(index))
					)
				});
			}
		}
		if equal {
			report.equal_contents += 1;
			if !ordered {
				report.order_only += 1;
			}
		} else {
			report.different += 1;
			let text = detail.unwrap_or_else(|| format!("{} layer names differ", tile_name(id)));
			note(&mut report, text);
		}
	}
	for &id in tiles_b.keys() {
		if !tiles_a.contains_key(&id) {
			report.only_in_b += 1;
			note(&mut report, format!("{} only in the second archive", tile_name(id)));
		}
	}
	Ok(report)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rotated_rings_compare_equal() {
		// A square starting at (0,0), and the same square starting at (10,10).
		let a = DecodedFeature {
			id: Some(1),
			geom_type: 3,
			commands: vec![9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 15],
			attributes: vec![],
		};
		let b = DecodedFeature {
			commands: vec![9, 20, 20, 26, 19, 0, 0, 19, 20, 0, 15],
			..a.clone()
		};
		assert_eq!(canonical(&a), canonical(&b));
	}
}
