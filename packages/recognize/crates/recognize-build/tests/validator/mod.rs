// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A small JSON Schema validator covering the keywords `definitions/ir.schema.json` uses. It adds no dependency, and
//! it panics on a keyword it does not implement, so extending the schema without extending the validator fails loudly
//! rather than validating nothing.
//!
//! `pattern` is checked by the crate's own name rules, which the schema's three patterns mirror. A new pattern panics.

use recognize_core::ids::{is_dotted_name, is_pascal_name};
use serde_json::Value;

const ANNOTATIONS: [&str; 5] = ["$schema", "$id", "title", "description", "$defs"];

/// Returns every violation of `schema` by `value`, each prefixed with the JSON path it occurs at.
pub fn violations(schema: &Value, value: &Value) -> Vec<String> {
	let mut errors = Vec::new();

	check(schema, schema, value, "$", &mut errors);

	errors
}

fn type_matches(expected: &str, value: &Value) -> bool {
	match expected {
		"object" => value.is_object(),
		"array" => value.is_array(),
		"string" => value.is_string(),
		"boolean" => value.is_boolean(),
		"null" => value.is_null(),
		"integer" => value.is_i64() || value.is_u64(),
		other => panic!("unhandled type `{other}`"),
	}
}

fn pattern_matches(pattern: &str, text: &str) -> bool {
	match pattern {
		"^[0-9a-f]{64}$" => text.len() == 64 && text.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
		"^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$" => is_dotted_name(text),
		"^[A-Z][A-Za-z0-9]*$" => is_pascal_name(text),
		other => panic!("unhandled pattern `{other}`"),
	}
}

fn check(root: &Value, schema: &Value, value: &Value, path: &str, errors: &mut Vec<String>) {
	let Some(object) = schema.as_object() else {
		panic!("schema at {path} is not an object")
	};

	for (keyword, argument) in object {
		match keyword.as_str() {
			key if ANNOTATIONS.contains(&key) => {}
			"$ref" => {
				let pointer = argument.as_str().unwrap().strip_prefix('#').unwrap();
				let target = root
					.pointer(pointer)
					.unwrap_or_else(|| panic!("unresolved reference {pointer}"));

				check(root, target, value, path, errors);
			}
			"const" => {
				if value != argument {
					errors.push(format!("{path}: expected {argument}, found {value}"));
				}
			}
			"enum" => {
				if !argument.as_array().unwrap().contains(value) {
					errors.push(format!("{path}: {value} is not one of {argument}"));
				}
			}
			"type" => {
				if !type_matches(argument.as_str().unwrap(), value) {
					errors.push(format!("{path}: expected type {argument}, found {value}"));
				}
			}
			"required" => {
				if let Some(map) = value.as_object() {
					for name in argument.as_array().unwrap() {
						if !map.contains_key(name.as_str().unwrap()) {
							errors.push(format!("{path}: missing required property {name}"));
						}
					}
				}
			}
			"properties" => {
				if let Some(map) = value.as_object() {
					for (name, child_schema) in argument.as_object().unwrap() {
						if let Some(child) = map.get(name) {
							check(root, child_schema, child, &format!("{path}.{name}"), errors);
						}
					}
				}
			}
			"additionalProperties" => {
				assert_eq!(
					argument,
					&Value::Bool(false),
					"only `additionalProperties: false` is implemented"
				);

				if let (Some(map), Some(properties)) = (value.as_object(), object.get("properties")) {
					for name in map.keys() {
						if !properties.as_object().unwrap().contains_key(name) {
							errors.push(format!("{path}: unexpected property `{name}`"));
						}
					}
				}
			}
			"items" => {
				if let Some(list) = value.as_array() {
					for (index, child) in list.iter().enumerate() {
						check(root, argument, child, &format!("{path}[{index}]"), errors);
					}
				}
			}
			"minItems" => {
				if value
					.as_array()
					.is_some_and(|list| (list.len() as u64) < argument.as_u64().unwrap())
				{
					errors.push(format!("{path}: fewer than {argument} items"));
				}
			}
			"maxItems" => {
				if value
					.as_array()
					.is_some_and(|list| (list.len() as u64) > argument.as_u64().unwrap())
				{
					errors.push(format!("{path}: more than {argument} items"));
				}
			}
			"minLength" => {
				if value
					.as_str()
					.is_some_and(|text| (text.chars().count() as u64) < argument.as_u64().unwrap())
				{
					errors.push(format!("{path}: shorter than {argument}"));
				}
			}
			"maxLength" => {
				if value
					.as_str()
					.is_some_and(|text| (text.chars().count() as u64) > argument.as_u64().unwrap())
				{
					errors.push(format!("{path}: longer than {argument}"));
				}
			}
			"minimum" => {
				if value.as_i64().is_some_and(|number| number < argument.as_i64().unwrap()) {
					errors.push(format!("{path}: below {argument}"));
				}
			}
			"pattern" => {
				if value
					.as_str()
					.is_some_and(|text| !pattern_matches(argument.as_str().unwrap(), text))
				{
					errors.push(format!("{path}: {value} does not match {argument}"));
				}
			}
			"oneOf" => {
				let matching = argument
					.as_array()
					.unwrap()
					.iter()
					.filter(|branch| {
						let mut branch_errors = Vec::new();

						check(root, branch, value, path, &mut branch_errors);
						branch_errors.is_empty()
					})
					.count();

				if matching != 1 {
					errors.push(format!("{path}: matches {matching} of the oneOf branches, expected 1"));
				}
			}
			other => panic!("unhandled schema keyword `{other}`"),
		}
	}
}
