// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.
//
// Ported from the basemaps fork's layers/Boundaries.java (BSD-3-Clause, Protomaps).

//! The `boundaries` layer: country and regional boundary lines from Natural Earth through zoom 5, and from the
//! OpenStreetMap ways of administrative boundary relations from zoom 6.

use hrt_osm::Relation;
use hrt_render::snap::SnapCounts;

use crate::merge::merge_line_strings;
use crate::parse::{parse_double, parse_int_or_null};
use crate::{feature_id, Collector, CollectorConfig, Emitted, Input, TileFeature};

pub const LAYER_NAME: &str = "boundaries";

/// What the layer keeps of an administrative boundary relation: `Boundaries.AdminRecord`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdminRecord {
	pub admin_level: i32,
	pub disputed: bool,
}

/// `Boundaries.preprocessOsmRelation`: a `type=boundary` relation of an administrative, disputed or claimed boundary
/// with an admin level of 8 or less.
pub fn admin_record(relation: &Relation) -> Option<AdminRecord> {
	let tags = &relation.tags;
	if tags.get("type") != Some("boundary")
		|| !matches!(tags.get("boundary"), Some("administrative" | "disputed" | "claim"))
	{
		return None;
	}
	let admin_level = parse_int_or_null(tags.get("admin_level")).filter(|level| *level <= 8)?;
	let disputed = tags.get("boundary") == Some("disputed")
		|| tags.get("disputed") == Some("yes")
		|| tags.get("disputed_by").is_some()
		|| tags.get("claimed_by").is_some();
	Some(AdminRecord { admin_level, disputed })
}

/// `Boundaries.getNeString`: a Natural Earth column, else its upper-case spelling, which the GeoPackage keeps for the
/// admin tables.
fn ne_string<'a>(input: &'a Input<'_>, key: &str) -> Option<&'a str> {
	input.tag(key).or_else(|| input.tag(&key.to_uppercase()))
}

/// The kind and admin level for a Natural Earth feature class, or `None` for a class the layer does not draw.
fn ne_class(feature_class: &str) -> Option<(&'static str, i32, bool)> {
	Some(match feature_class {
		"Disputed (please verify)"
		| "Indefinite (please verify)"
		| "Indeterminant frontier"
		| "Line of control (please verify)" => ("country", 2, true),
		"International boundary (verify)" => ("country", 2, false),
		"Lease limit" => ("lease_limit", 3, false),
		"Overlay limit" => ("overlay_limit", 3, false),
		"Unrecognized" => ("unrecognized_country", 2, false),
		"Map unit boundary" => ("map_unit", 3, false),
		"Breakaway" | "Claim boundary" | "Elusive frontier" | "Reference line" => ("unrecognized_country", 3, false),
		"Admin-1 region boundary" => ("macroregion", 3, false),
		"Admin-1 boundary"
		| "Admin-1 statistical boundary"
		| "Admin-1 statistical meta bounds"
		| "1st Order Admin Lines" => ("region", 4, false),
		"Unrecognized Admin-1 region boundary" => ("unrecognized_macroregion", 4, false),
		"Unrecognized Admin-1 boundary"
		| "Unrecognized Admin-1 statistical boundary"
		| "Unrecognized Admin-1 statistical meta bounds" => ("unrecognized_region", 4, false),
		_ => return None,
	})
}

/// `Boundaries.processNe`: the admin-0 and admin-1 boundary lines, through zoom 5.
pub fn process_ne(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	let source_layer = input.source.source_layer;
	if !matches!(
		source_layer,
		"ne_10m_admin_0_boundary_lines_land"
			| "ne_10m_admin_0_boundary_lines_map_units"
			| "ne_10m_admin_0_boundary_lines_disputed_areas"
			| "ne_10m_admin_1_states_provinces_lines"
	) {
		return;
	}
	let theme_max_zoom = 5;
	let Some((kind, admin_level, disputed)) = ne_class(ne_string(input, "featurecla").unwrap_or("")) else {
		return;
	};
	let Some(min_zoom) = ne_string(input, "min_zoom") else {
		return;
	};
	if !input.can_be_line() {
		return;
	}
	// Java's Double.parseDouble throws on text that is no number, which drops the feature.
	let Some(min_zoom) = parse_double(min_zoom).map(|zoom| zoom - 1.0) else {
		return;
	};
	let sort_rank = 289 - i32::from(disputed);
	let mut collector = Collector::new(input, config);
	collector
		.line(layer)
		.set_attr("kind", kind)
		.set_attr("kind_detail", admin_level)
		.set_attr("sort_rank", sort_rank)
		.set_sort_key(sort_rank)
		.set_attr("disputed", disputed.then_some(true))
		.set_attr("brk_a3", ne_string(input, "brk_a3"))
		.set_zoom_range(min_zoom as i32, theme_max_zoom)
		.set_min_pixel_size(0.0)
		.set_buffer_pixels(8.0);
	features.extend(collector.finish());
}

/// `Boundaries.processOsm`: each way of an administrative boundary relation, drawn at the lowest admin level among its
/// relations.
pub fn process_osm(input: &Input<'_>, layer: u32, features: &mut Vec<Emitted>, config: CollectorConfig) {
	if !input.can_be_line() {
		return;
	}
	// Coastlines and coastal waters, such as admin borders across large estuaries, are left out.
	if input.tag("natural") == Some("coastline") || input.tag("maritime") == Some("yes") {
		return;
	}
	let records: Vec<AdminRecord> = input
		.source
		.relations
		.iter()
		.filter(|member| member.parent_path.is_empty())
		.filter_map(|member| admin_record(member.relation))
		.collect();
	let Some(min_admin_level) = records.iter().map(|record| record.admin_level).min() else {
		return;
	};
	let disputed_relation = records.iter().any(|record| record.disputed);
	let (kind, theme_min_zoom) = match min_admin_level {
		// Natural Earth draws country and region lines below zoom 6.
		2 => ("country", 6),
		3 | 4 => ("region", 6),
		5 | 6 => ("county", 8),
		_ => ("locality", 10),
	};
	let disputed = disputed_relation
		|| input.has_tag_in("boundary", &["disputed", "claim"])
		|| input.tag("disputed") == Some("yes")
		|| input.has_tag("disputed_by")
		|| input.has_tag("claimed_by");
	let sort_rank = 289 - i32::from(disputed);
	let mut collector = Collector::new(input, config);
	collector
		.line(layer)
		.set_id(feature_id(input.source))
		.set_attr("kind", kind)
		.set_attr("kind_detail", min_admin_level)
		.set_attr("sort_rank", sort_rank)
		.set_sort_key(sort_rank)
		.set_attr("disputed", disputed.then_some(true))
		.set_min_pixel_size(0.0)
		.set_min_zoom(theme_min_zoom);
	features.extend(collector.finish());
}

/// `Boundaries.postProcess`: lines with equal attributes merge, resimplified at 0.2 pixels below zoom 6 and 0.4 from it.
pub fn post_process(zoom: u8, features: Vec<TileFeature>, _counts: &mut SnapCounts) -> Vec<TileFeature> {
	let tolerance = if zoom < 6 { 0.2 } else { 0.4 };
	merge_line_strings(features, 0.0, tolerance, 4.0, true)
}

#[cfg(test)]
mod tests {
	use hrt_osm::{ElementKind, Member, Tags};

	use super::*;

	fn relation(pairs: &[(&str, &str)]) -> Relation {
		Relation {
			id: 1,
			tags: Tags(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
			members: vec![Member {
				kind: ElementKind::Way,
				id: 2,
				role: "outer".into(),
			}],
		}
	}

	#[test]
	fn admin_relations_are_kept_through_level_8() {
		let kept = admin_record(&relation(&[
			("type", "boundary"),
			("boundary", "administrative"),
			("admin_level", "4"),
		]));
		assert_eq!(
			kept,
			Some(AdminRecord {
				admin_level: 4,
				disputed: false
			})
		);
		let claim = admin_record(&relation(&[
			("type", "boundary"),
			("boundary", "disputed"),
			("admin_level", "2"),
		]));
		assert!(claim.is_some_and(|record| record.disputed));
		assert_eq!(
			admin_record(&relation(&[
				("type", "boundary"),
				("boundary", "administrative"),
				("admin_level", "9")
			])),
			None
		);
		assert_eq!(
			admin_record(&relation(&[("type", "boundary"), ("boundary", "administrative")])),
			None
		);
		assert_eq!(
			admin_record(&relation(&[
				("type", "route"),
				("boundary", "administrative"),
				("admin_level", "2")
			])),
			None
		);
	}

	#[test]
	fn natural_earth_classes_map_to_kinds() {
		assert_eq!(ne_class("Admin-1 boundary"), Some(("region", 4, false)));
		assert_eq!(ne_class("Line of control (please verify)"), Some(("country", 2, true)));
		assert_eq!(ne_class("Coastline"), None);
	}
}
