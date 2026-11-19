// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A family defined as data outside `recognize-core`.
//!
//! A package that owns a family writes one JSON document, the family definition, and `recognize-build --definition`
//! compiles it. The definition holds regular-expression strings, so the family is shape-only: it has no captures, no
//! validator and no handler, and it generates no Rust. A definition that names one is refused with a diagnostic. The
//! JSON Schema of the format is `definitions/family-definition.schema.json`.
//!
//! ```json
//! {
//!   "format": "mailwoman.recognize.family-definition",
//!   "version": 1,
//!   "family": "postcode_legacy",
//!   "generator": "node packages/postcode/tools/generate.run.ts",
//!   "fields": { "reader": "knownFormats", "type": "Fields", "from": "./fields.generated.ts" },
//!   "metadata": { "poBox": { "format": "po_box" } },
//!   "shapes": [
//!     { "id": "format.us_zip", "pattern": "[0-9]{5}", "overlaps": ["format.fr"], "metadata": { "confidence": 0.6 } }
//!   ]
//! }
//! ```
//!
//! A shape's `boundary` is `token` when an embedded match may not touch an ASCII letter, an ASCII digit or a connector:
//! the engine then reports no match that sits inside a longer run of those characters. It is `alnum` when a match may not
//! touch an ASCII letter or an ASCII digit, and a connector may touch it.
//!
//! A shape may carry two more pieces of data the known-formats pass reads, and the pass reads no naming convention. `role` is
//! `po_box_leader` for a token that leads a PO box, and `order` is the shape's place, lowest first, in the order the pass
//! reports hits of one text. Both go into the artifact, and a shape ID is only an identifier.
//!
//! # The overlap policy
//!
//! Two shapes that recognize the same string fail the build unless one names the other in `overlaps`, so a new grammar
//! cannot silently collide with an existing one. A definition is analyzed beside the repository's own families, which it
//! may name by shape ID: a package that owns a definition declares its overlaps with `recognizer`'s shapes, and
//! `recognizer` names nothing of any package. A family with a `fields` reader reports no recognitions, and its shapes take
//! no part in the policy.
//!
//! A shape's `scope` is `whole` unless the definition says otherwise, and a pattern holds no assertion: the scope
//! anchors it. Case-insensitivity is an inline flag, as `(?i-u)` for ASCII case folding. `metadata` is copied into the
//! generated TypeScript and is not part of the artifact or its hash. Every diagnostic carries the definition's file and
//! the line of the shape's `id`.

use recognize_core::ast::pattern;
use recognize_core::validate::validate;
use recognize_core::{
	AmbiguityPolicy, Boundary, Diagnostic, DiagnosticKind, IrDocument, Scope, Shape, ShapeRole, Source, IR_FORMAT,
	IR_VERSION,
};
use serde_json::{Map, Value};

/// The `format` field of every family definition.
pub const DEFINITION_FORMAT: &str = "mailwoman.recognize.family-definition";

/// The definition version this reader implements.
pub const DEFINITION_VERSION: u64 = 1;

/// The field readers an external family may name.
pub const READERS: [&str; 1] = ["knownFormats"];

/// The type a family's result fields take, and where the generated TypeScript imports it from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldsSpec {
	pub reader: String,
	pub type_name: String,
	pub from: String,
}

/// A family definition, validated and ready to compile.
#[derive(Clone, Debug, PartialEq)]
pub struct Definition {
	/// The sealed IR of the family.
	pub document: IrDocument,
	/// The command the generated files name as their generator.
	pub generator: String,
	pub fields: Option<FieldsSpec>,
	/// Family-level metadata, copied into the generated TypeScript.
	pub metadata: Value,
	/// Each shape's metadata by shape ID, copied into the generated TypeScript.
	pub shape_metadata: Map<String, Value>,
}

const SHAPE_KEYS: [&str; 8] = [
	"id", "pattern", "scope", "overlaps", "metadata", "role", "order", "boundary",
];
const REFUSED_KEYS: [&str; 3] = ["captures", "validator", "handler"];

/// The line of the first occurrence of `needle` in `text`, or 1.
fn line_of(text: &str, needle: &str) -> u32 {
	text.find(needle)
		.map_or(1, |offset| text[..offset].matches('\n').count() as u32 + 1)
}

/// Reads and validates a definition. `file` names the document in diagnostics.
pub fn read(file: &str, text: &str) -> Result<Definition, Vec<Diagnostic>> {
	let refuse = |line: u32, message: String| {
		vec![Diagnostic::new(
			DiagnosticKind::MalformedIR,
			&Source::new(file, line),
			message,
		)]
	};
	let value: Value = serde_json::from_str(text).map_err(|error| refuse(error.line() as u32, error.to_string()))?;
	let Some(root) = value.as_object() else {
		return Err(refuse(1, "a family definition is a JSON object".to_string()));
	};

	if root.get("format").and_then(Value::as_str) != Some(DEFINITION_FORMAT) {
		return Err(refuse(1, format!("format is not `{DEFINITION_FORMAT}`")));
	}

	if root.get("version").and_then(Value::as_u64) != Some(DEFINITION_VERSION) {
		return Err(refuse(
			1,
			format!("version is not {DEFINITION_VERSION}, which this reader implements"),
		));
	}

	let Some(family) = root.get("family").and_then(Value::as_str) else {
		return Err(refuse(1, "`family` is a string".to_string()));
	};
	let Some(entries) = root.get("shapes").and_then(Value::as_array) else {
		return Err(refuse(1, "`shapes` is an array".to_string()));
	};

	let mut diagnostics = Vec::new();
	let mut shapes = Vec::new();
	let mut shape_metadata = Map::new();

	for entry in entries {
		let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
		let line = [
			format!("\"id\": \"{id}\""),
			format!("\"id\":\"{id}\""),
			format!("\"{id}\""),
		]
		.iter()
		.find(|needle| text.contains(needle.as_str()))
		.map_or(1, |needle| line_of(text, needle));
		let source = Source::new(file, line);
		let Some(object) = entry.as_object() else {
			diagnostics.push(Diagnostic::new(
				DiagnosticKind::MalformedIR,
				&source,
				"a shape is a JSON object".to_string(),
			));

			continue;
		};

		for key in object.keys() {
			if REFUSED_KEYS.contains(&key.as_str()) {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::CaptureSchemaMismatch,
					&source,
					format!(
						"shape `{id}` declares `{key}`; a family defined as data is shape-only, so it has no captures, validator or handler"
					),
				));
			} else if !SHAPE_KEYS.contains(&key.as_str()) {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::MalformedIR,
					&source,
					format!("shape `{id}` has the unknown key `{key}`"),
				));
			}
		}

		let Some(regex) = object.get("pattern").and_then(Value::as_str) else {
			diagnostics.push(Diagnostic::new(
				DiagnosticKind::MissingGrammar,
				&source,
				format!("shape `{id}` declares no `pattern` string"),
			));

			continue;
		};
		let scope = match object.get("scope").and_then(Value::as_str) {
			None | Some("whole") => Scope::Whole,
			Some("embedded") => Scope::Embedded,
			Some("whole_or_embedded") => Scope::WholeOrEmbedded,
			Some(other) => {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::MalformedIR,
					&source,
					format!("shape `{id}` has the scope `{other}`; a defined family has `whole`, `embedded` or `whole_or_embedded`"),
				));

				continue;
			}
		};
		let role = match object.get("role").and_then(Value::as_str) {
			None => None,
			Some("po_box_leader") => Some(ShapeRole::PoBoxLeader),
			Some(other) => {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::MalformedIR,
					&source,
					format!("shape `{id}` has the role `{other}`; the roles are `po_box_leader`"),
				));

				continue;
			}
		};
		let boundary = match object.get("boundary").and_then(Value::as_str) {
			None => None,
			Some("token") => Some(Boundary::Token),
			Some("alnum") => Some(Boundary::Alnum),
			Some(other) => {
				diagnostics.push(Diagnostic::new(
					DiagnosticKind::MalformedIR,
					&source,
					format!("shape `{id}` has the boundary `{other}`; the boundaries are `token` and `alnum`"),
				));

				continue;
			}
		};
		let order = match object.get("order") {
			None => None,
			Some(value) => match value.as_u64().and_then(|order| u32::try_from(order).ok()) {
				Some(order) => Some(order),
				None => {
					diagnostics.push(Diagnostic::new(
						DiagnosticKind::MalformedIR,
						&source,
						format!("shape `{id}` has an `order` that is not a whole number below 2^32"),
					));

					continue;
				}
			},
		};
		let overlaps: Vec<String> = object
			.get("overlaps")
			.and_then(Value::as_array)
			.map(|names| {
				names
					.iter()
					.filter_map(|name| name.as_str().map(str::to_string))
					.collect()
			})
			.unwrap_or_default();

		if let Some(metadata) = object.get("metadata") {
			shape_metadata.insert(id.to_string(), metadata.clone());
		}

		shapes.push(Shape {
			id: id.to_string(),
			grammar: pattern(regex),
			captures: Vec::new(),
			scope,
			validator: None,
			handler: None,
			ambiguity: if overlaps.is_empty() {
				AmbiguityPolicy::Exclusive
			} else {
				AmbiguityPolicy::MayOverlap { with: overlaps }
			},
			unreachable: None,
			partition: None,
			role,
			order,
			boundary,
			source,
		});
	}

	let anchor = Source::new(file, 1);

	diagnostics.extend(validate(family, &anchor, &[], &shapes));

	let fields = match root.get("fields") {
		None => None,
		Some(spec) => {
			let text_of = |key: &str| spec.get(key).and_then(Value::as_str).map(str::to_string);

			match (text_of("reader"), text_of("type"), text_of("from")) {
				(Some(reader), Some(type_name), Some(from)) if READERS.contains(&reader.as_str()) => Some(FieldsSpec {
					reader,
					type_name,
					from,
				}),
				_ => {
					diagnostics.push(Diagnostic::new(
						DiagnosticKind::MalformedIR,
						&Source::new(file, line_of(text, "\"fields\"")),
						format!(
							"`fields` names a `reader` ({}), a `type` and the module it comes `from`",
							READERS.join(", ")
						),
					));

					None
				}
			}
		}
	};

	if !diagnostics.is_empty() {
		diagnostics.sort();
		diagnostics.dedup();

		return Err(diagnostics);
	}

	let document = IrDocument {
		format: IR_FORMAT.to_string(),
		version: IR_VERSION,
		hash: String::new(),
		family: family.to_string(),
		terms: Vec::new(),
		shapes,
	}
	.seal();

	Ok(Definition {
		document,
		generator: root
			.get("generator")
			.and_then(Value::as_str)
			.unwrap_or("recognize-build --definition")
			.to_string(),
		fields,
		metadata: root.get("metadata").cloned().unwrap_or(Value::Null),
		shape_metadata,
	})
}
