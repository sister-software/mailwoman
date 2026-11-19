// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The declarations of a family: what its generated Rust and TypeScript are written from.
//!
//! A family's declarations are its shapes' kind names, capture schemas, validator IDs and handler IDs, with nothing
//! about the grammar itself. The generated Rust module, the generated TypeScript module and the artifact's
//! `declarationsHash` all derive from this one document, so they agree by construction, and a loader that holds the
//! TypeScript declarations can refuse an artifact built from other ones.
//!
//! The hash is the SHA-256 of the document's compact JSON, whose keys are in byte order.

use serde::Serialize;

use crate::ir::{sha256_hex, CaptureSpec, IrDocument};
use crate::validators::{self, PayloadField};

/// One shape's declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeDeclaration {
	pub captures: Vec<CaptureSpec>,
	pub handler: Option<String>,
	pub id: String,
	/// The PascalCase name of the shape's recognition kind.
	pub kind: String,
	/// The partition the shape is a piece of. A partition piece is never a recognition, so the generated TypeScript lists
	/// no kind for it. Absent from the declarations of every other shape.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub partition: Option<String>,
	/// The fields of the validator's payload, from the validator's own declaration. Empty without a validator.
	pub payload: Vec<PayloadField>,
	/// Every rejection code a recognition of the shape can carry: the validator's and the engine's.
	pub rejections: Vec<String>,
	pub validator: Option<String>,
}

/// One family's declarations, with shapes sorted by ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declarations {
	pub family: String,
	pub shapes: Vec<ShapeDeclaration>,
}

/// The parts of a shape ID the repository spells as a whole acronym in a name, with the spelling: `coordinate.geo_uri`
/// is `CoordinateGeoURI` and `census.geoid_county` is `CensusGeoIDCounty`, as the lint rule for acronyms requires.
const ACRONYMS: [(&str, &str); 8] = [
	("dms", "DMS"),
	("geoid", "GeoID"),
	("geojson", "GeoJSON"),
	("gnis", "GNIS"),
	("id", "ID"),
	("uri", "URI"),
	("url", "URL"),
	("wof", "WOF"),
];

/// The kind name of a shape ID: `coordinate.decimal_pair` is `CoordinateDecimalPair`.
pub fn kind_name(shape: &str) -> String {
	shape
		.split(['.', '_'])
		.filter(|part| !part.is_empty())
		.map(|part| {
			if let Some((_, spelling)) = ACRONYMS.iter().find(|(acronym, _)| *acronym == part) {
				return spelling.to_string();
			}

			let mut characters = part.chars();

			match characters.next() {
				Some(first) => first.to_ascii_uppercase().to_string() + characters.as_str(),
				None => String::new(),
			}
		})
		.collect()
}

impl Declarations {
	/// Reads the declarations out of a family's IR.
	pub fn from_ir(document: &IrDocument) -> Self {
		let mut shapes: Vec<ShapeDeclaration> = document
			.shapes
			.iter()
			.map(|shape| {
				let schema = shape
					.validator
					.as_ref()
					.and_then(|validator| validators::schema(validator.as_str()));
				let mut rejections: Vec<String> = schema
					.map(|schema| {
						schema
							.rejections
							.iter()
							.chain(validators::ENGINE_REJECTIONS)
							.map(|code| code.to_string())
							.collect()
					})
					.unwrap_or_default();

				rejections.sort();

				ShapeDeclaration {
					captures: shape.captures.clone(),
					handler: shape.handler.as_ref().map(|handler| handler.as_str().to_string()),
					id: shape.id.clone(),
					kind: kind_name(&shape.id),
					partition: shape.partition.clone(),
					payload: schema.map(|schema| schema.payload.to_vec()).unwrap_or_default(),
					rejections,
					validator: shape.validator.as_ref().map(|validator| validator.as_str().to_string()),
				}
			})
			.collect();

		shapes.sort_by(|a, b| a.id.cmp(&b.id));

		Declarations {
			family: document.family.clone(),
			shapes,
		}
	}

	/// The canonical text the hash covers.
	pub fn canonical_json(&self) -> String {
		serde_json::to_string(self).expect("declarations always serialize")
	}

	/// The `declarationsHash` an artifact of this family carries.
	pub fn hash(&self) -> String {
		sha256_hex(self.canonical_json().as_bytes())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn kind_names_follow_the_shape_id() {
		assert_eq!(kind_name("coordinate.decimal_pair"), "CoordinateDecimalPair");
		assert_eq!(kind_name("word.ascii"), "WordAscii");
		assert_eq!(kind_name("coordinate.geo_uri"), "CoordinateGeoURI");
		assert_eq!(kind_name("postcode.generic_5digit"), "PostcodeGeneric5digit");
		assert_eq!(kind_name("census.geoid_block_group"), "CensusGeoIDBlockGroup");
		assert_eq!(kind_name("geojson.object"), "GeoJSONObject");
		assert_eq!(kind_name("wof.spelunker_url"), "WOFSpelunkerURL");
		assert_eq!(kind_name("coordinate.dms_pair"), "CoordinateDMSPair");
	}

	#[test]
	fn the_hash_changes_with_a_declaration_and_not_with_a_grammar() {
		let family = crate::grammars::coordinates::family();
		let document = family.clone().build().unwrap();
		let base = Declarations::from_ir(&document);

		assert_eq!(base.hash().len(), 64);
		assert_eq!(base.hash(), Declarations::from_ir(&family.build().unwrap()).hash());

		let mut changed = base.clone();

		changed.shapes[0].validator = Some("Other".to_string());

		assert_ne!(base.hash(), changed.hash());
	}
}
