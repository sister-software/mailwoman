// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The text layout of the committed IR. It is the layout the repository's formatter (`oxfmt`) leaves unchanged, so
//! `yarn lint` accepts a generated file as written: objects expand one key per line, an array of scalars or of one
//! short array stays on a line when it fits in 120 columns, and an array of several arrays that each hold several
//! values, or any array that holds an object, breaks one element per line.

use serde_json::Value;

const WIDTH: usize = 120;
const TAB_COLUMNS: usize = 2;

/// Renders `value` with tab indentation and a trailing newline.
pub fn render(value: &Value) -> String {
	let mut out = String::new();

	print(value, 0, 0, &mut out);
	out.push('\n');

	out
}

fn holds_object(value: &Value) -> bool {
	match value {
		Value::Object(_) => true,
		Value::Array(items) => items.iter().any(holds_object),
		_ => false,
	}
}

fn flat(value: &Value) -> String {
	match value {
		Value::Array(items) => format!("[{}]", items.iter().map(flat).collect::<Vec<_>>().join(", ")),
		scalar => serde_json::to_string(scalar).expect("a JSON value serializes"),
	}
}

fn forced_break(items: &[Value]) -> bool {
	items.len() > 1
		&& items
			.iter()
			.all(|item| matches!(item, Value::Array(inner) if inner.len() > 1))
}

/// `prefix` is the width of the `"key": ` text on the same line, which a flat array must fit beside.
fn print(value: &Value, depth: usize, prefix: usize, out: &mut String) {
	match value {
		Value::Object(map) if !map.is_empty() => {
			out.push_str("{\n");

			for (index, (key, child)) in map.iter().enumerate() {
				let key_text = format!("{}: ", serde_json::to_string(key).expect("a key serializes"));

				out.push_str(&"\t".repeat(depth + 1));
				out.push_str(&key_text);
				print(child, depth + 1, key_text.chars().count(), out);

				if index + 1 < map.len() {
					out.push(',');
				}

				out.push('\n');
			}

			out.push_str(&"\t".repeat(depth));
			out.push('}');
		}
		Value::Array(items) if !items.is_empty() => {
			let one_line = flat(value);
			let fits = depth * TAB_COLUMNS + prefix + one_line.chars().count() < WIDTH;

			if !holds_object(value) && !forced_break(items) && fits {
				out.push_str(&one_line);
				return;
			}

			out.push_str("[\n");

			for (index, item) in items.iter().enumerate() {
				out.push_str(&"\t".repeat(depth + 1));
				print(item, depth + 1, 0, out);

				if index + 1 < items.len() {
					out.push(',');
				}

				out.push('\n');
			}

			out.push_str(&"\t".repeat(depth));
			out.push(']');
		}
		Value::Object(_) => out.push_str("{}"),
		Value::Array(_) => out.push_str("[]"),
		scalar => out.push_str(&serde_json::to_string(scalar).expect("a JSON value serializes")),
	}
}
