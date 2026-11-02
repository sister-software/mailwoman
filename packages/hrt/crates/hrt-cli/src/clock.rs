// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `hrt clock`: comparing two archives tile by tile under the parity contract of issue #2902.
//!
//! Two archives agree on a tile when both have it and, for every layer, the two layers hold the same multiset of
//! features. A feature is compared by id, geometry type, attribute map, and geometry decoded to absolute coordinates.
//! A polygon's rings are rotated to start at their smallest vertex and then sorted, because GEOS's precision reducer
//! and union can start a ring at a different vertex from JTS's, which also reorders merged parts sorted by first
//! vertex, while describing the same polygon.
//!
//! A polygon whose rings still differ counts as equal within tolerance when its area and its overlap with the other
//! archive's polygon agree within 1e-3, the contract's allowance for merged polygons, where JTS's and GEOS's overlay
//! place vertices differently. Feature order within a layer is reported separately, since equal sort keys leave it
//! open.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io;
use std::path::Path;

use geos::Geom as _;
use hrt_e::{decode_tile, DecodedFeature, Value};
use hrt_pmtiles::{tile_id_to_zxy, Entry, Reader};
use hrt_profile::merge::decode;
use hrt_render::snap::to_geos;
use hrt_render::{GeometryType, VectorGeometry};

/// The relative area difference and the shortfall of intersection over union that merged polygons may show.
const POLYGON_TOLERANCE: f64 = 1e-3;

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
		parts.sort();
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
	/// Tiles counted in `equal_contents` that needed the polygon tolerance.
	pub equal_within_tolerance: usize,
	/// Polygons that differed in their rings and agreed within the polygon tolerance.
	pub polygons_within_tolerance: usize,
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

/// Two polygon features measured against each other: each one's area, in squared tile units, and their intersection
/// over union.
struct PolygonMeasure {
	area_a: f64,
	area_b: f64,
	iou: f64,
}

fn measure_polygons(a: &DecodedFeature, b: &DecodedFeature) -> Option<PolygonMeasure> {
	let geometry = |feature: &DecodedFeature| {
		let geom = decode(&VectorGeometry {
			commands: feature.commands.clone(),
			geom_type: GeometryType::Polygon,
			scale: 0,
		});
		to_geos(&geom).ok().and_then(|g| {
			if g.is_valid().unwrap_or(false) {
				Some(g)
			} else {
				g.make_valid().ok()
			}
		})
	};
	let (a, b) = (geometry(a)?, geometry(b)?);
	let (area_a, area_b) = (a.area().ok()?, b.area().ok()?);
	let intersection = a.intersection(&b).and_then(|g| g.area()).ok()?;
	let union = area_a + area_b - intersection;
	let iou = if union <= 0.0 {
		if area_a == area_b {
			1.0
		} else {
			0.0
		}
	} else {
		intersection / union
	};
	Some(PolygonMeasure { area_a, area_b, iou })
}

/// Returns whether two polygon features have areas within the tolerance of each other and an intersection over union
/// within the tolerance of 1.
fn polygons_close(a: &DecodedFeature, b: &DecodedFeature) -> bool {
	measure_polygons(a, b).is_some_and(|m| {
		(m.area_a - m.area_b).abs() <= POLYGON_TOLERANCE * m.area_a.max(m.area_b) && m.iou >= 1.0 - POLYGON_TOLERANCE
	})
}

type FeatureKey = (Option<u64>, u64, Vec<(String, String)>);

/// The outcome of comparing one layer's features in two archives.
enum LayerComparison {
	Equal,
	WithinTolerance(usize),
	Different(String),
}

fn compare_layer(features_a: &[DecodedFeature], features_b: &[DecodedFeature]) -> LayerComparison {
	let mut sorted_a: Vec<(Canonical, &DecodedFeature)> = features_a.iter().map(|f| (canonical(f), f)).collect();
	let mut sorted_b: Vec<(Canonical, &DecodedFeature)> = features_b.iter().map(|f| (canonical(f), f)).collect();
	sorted_a.sort_by(|x, y| x.0.cmp(&y.0));
	sorted_b.sort_by(|x, y| x.0.cmp(&y.0));
	if sorted_a.iter().map(|x| &x.0).eq(sorted_b.iter().map(|x| &x.0)) {
		return LayerComparison::Equal;
	}

	let group = |features: &[(Canonical, &DecodedFeature)]| {
		let mut groups: BTreeMap<FeatureKey, Vec<(Canonical, DecodedFeature)>> = BTreeMap::new();
		for (canonical, feature) in features {
			let key = (canonical.id, canonical.geom_type, canonical.attributes.clone());
			groups
				.entry(key)
				.or_default()
				.push((canonical.clone(), (*feature).clone()));
		}
		groups
	};
	let groups_a = group(&sorted_a);
	let groups_b = group(&sorted_b);
	let first_difference = |a: Option<&Canonical>, b: Option<&Canonical>| {
		format!(
			"{} vs {} features; first difference\n    a: {}\n    b: {}",
			sorted_a.len(),
			sorted_b.len(),
			describe(a),
			describe(b)
		)
	};
	if !groups_a.keys().eq(groups_b.keys()) {
		let key = groups_a
			.keys()
			.find(|key| !groups_b.contains_key(*key))
			.or_else(|| groups_b.keys().find(|key| !groups_a.contains_key(*key)));
		let a = key.and_then(|key| groups_a.get(key)).map(|group| &group[0].0);
		let b = key.and_then(|key| groups_b.get(key)).map(|group| &group[0].0);
		return LayerComparison::Different(first_difference(a, b));
	}
	let mut within = 0;
	for (key, group_a) in &groups_a {
		let group_b = &groups_b[key];
		if group_a.len() != group_b.len() {
			return LayerComparison::Different(first_difference(Some(&group_a[0].0), Some(&group_b[0].0)));
		}
		for ((canonical_a, feature_a), (canonical_b, feature_b)) in group_a.iter().zip(group_b) {
			if canonical_a == canonical_b {
				continue;
			}
			if canonical_a.geom_type == 3 && polygons_close(feature_a, feature_b) {
				within += 1;
				continue;
			}
			let mut text = first_difference(Some(canonical_a), Some(canonical_b));
			if let Some((part, index)) = canonical_a
				.parts
				.iter()
				.zip(&canonical_b.parts)
				.enumerate()
				.find_map(|(part, (pa, pb))| pa.iter().zip(pb).position(|(x, y)| x != y).map(|index| (part, index)))
			{
				let window =
					|points: &[[i32; 2]]| points[index.saturating_sub(2)..(index + 3).min(points.len())].to_vec();
				let _ = write!(
					text,
					"\n    part {part} from vertex {}: {:?}\n                     vs {:?}",
					index.saturating_sub(2),
					window(&canonical_a.parts[part]),
					window(&canonical_b.parts[part])
				);
			}
			if canonical_a.geom_type == 3 {
				if let Some(m) = measure_polygons(feature_a, feature_b) {
					let _ = write!(
						text,
						"\n    rings {} vs {}; area {:.1} vs {:.1}; intersection over union {:.6}",
						canonical_a.parts.len(),
						canonical_b.parts.len(),
						m.area_a,
						m.area_b,
						m.iou
					);
				}
			}
			return LayerComparison::Different(text);
		}
	}
	LayerComparison::WithinTolerance(within)
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
				.map(|layer| (layer.name.clone(), layer.features.clone()))
				.collect::<BTreeMap<_, _>>()
		};
		let named_a = by_name(&layers_a);
		let named_b = by_name(&layers_b);
		let mut equal = named_a.keys().eq(named_b.keys());
		let mut ordered = true;
		let mut within = 0;
		let mut detail = None;
		let mut order_detail = None;
		for (name, features_a) in &named_a {
			let Some(features_b) = named_b.get(name) else {
				detail.get_or_insert_with(|| format!("{} layer {name} only in the first archive", tile_name(id)));
				continue;
			};
			report.features_compared += features_a.len();
			if ordered {
				let order_a: Vec<Canonical> = features_a.iter().map(canonical).collect();
				let order_b: Vec<Canonical> = features_b.iter().map(canonical).collect();
				if let Some(index) = order_a.iter().zip(&order_b).position(|(a, b)| a != b) {
					ordered = false;
					order_detail = Some(format!(
						"{} layer {name}: same features, first out of order at position {index} of {}\n    a: {}\n    b: {}",
						tile_name(id),
						order_a.len(),
						describe(order_a.get(index)),
						describe(order_b.get(index))
					));
				}
			}
			match compare_layer(features_a, features_b) {
				LayerComparison::Equal => {}
				LayerComparison::WithinTolerance(count) => within += count,
				LayerComparison::Different(text) => {
					equal = false;
					detail.get_or_insert_with(|| format!("{} layer {name}: {text}", tile_name(id)));
				}
			}
		}
		if equal {
			report.equal_contents += 1;
			if within > 0 {
				report.equal_within_tolerance += 1;
				report.polygons_within_tolerance += within;
			} else if !ordered {
				report.order_only += 1;
				if let Some(text) = order_detail {
					note(&mut report, text);
				}
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
