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

/// One shape's declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeDeclaration {
	pub captures: Vec<CaptureSpec>,
	pub handler: Option<String>,
	pub id: String,
	/// The PascalCase name of the shape's recognition kind.
	pub kind: String,
	pub validator: Option<String>,
}

/// One family's declarations, with shapes sorted by ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declarations {
	pub family: String,
	pub shapes: Vec<ShapeDeclaration>,
}

/// The kind name of a shape ID: `coordinate.decimal_pair` is `CoordinateDecimalPair`.
pub fn kind_name(shape: &str) -> String {
	shape
		.split(['.', '_'])
		.filter(|part| !part.is_empty())
		.map(|part| {
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
			.map(|shape| ShapeDeclaration {
				captures: shape.captures.clone(),
				handler: shape.handler.as_ref().map(|handler| handler.as_str().to_string()),
				id: shape.id.clone(),
				kind: kind_name(&shape.id),
				validator: shape.validator.as_ref().map(|validator| validator.as_str().to_string()),
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
		assert_eq!(kind_name("postcode.generic_5digit"), "PostcodeGeneric5digit");
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
