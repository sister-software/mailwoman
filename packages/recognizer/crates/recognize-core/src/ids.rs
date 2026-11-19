// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Identifier syntax. Shape IDs, term IDs, family IDs and capture paths are dotted lowercase names. Validator and
//! handler IDs are PascalCase names that a later phase maps to Rust and TypeScript declarations.

use serde::{Deserialize, Serialize};

/// Whether `text` is `segment(.segment)*` with each segment `[a-z][a-z0-9_]*`.
pub fn is_dotted_name(text: &str) -> bool {
	!text.is_empty()
		&& text.split('.').all(|segment| {
			let mut chars = segment.chars();

			chars.next().is_some_and(|first| first.is_ascii_lowercase())
				&& chars.all(|rest| rest.is_ascii_lowercase() || rest.is_ascii_digit() || rest == '_')
		})
}

/// Whether `text` is `[A-Z][A-Za-z0-9]*`.
pub fn is_pascal_name(text: &str) -> bool {
	let mut chars = text.chars();

	chars.next().is_some_and(|first| first.is_ascii_uppercase()) && chars.all(|rest| rest.is_ascii_alphanumeric())
}

macro_rules! pascal_id {
	($(#[$meta:meta])* $name:ident) => {
		$(#[$meta])*
		#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
		#[serde(try_from = "String", into = "String")]
		pub struct $name(String);

		impl $name {
			/// Wraps `text` when it is a PascalCase name.
			pub fn new(text: &str) -> Result<Self, String> {
				if is_pascal_name(text) {
					Ok($name(text.to_string()))
				} else {
					Err(format!("`{text}` is not a PascalCase name"))
				}
			}

			pub fn as_str(&self) -> &str {
				&self.0
			}
		}

		impl TryFrom<String> for $name {
			type Error = String;

			fn try_from(text: String) -> Result<Self, String> {
				$name::new(&text)
			}
		}

		impl From<$name> for String {
			fn from(id: $name) -> String {
				id.0
			}
		}
	};
}

pascal_id! {
	/// Names the validator that checks a shape's captured values. A later phase binds it to Rust code; the grammar
	/// crate only carries the identifier.
	ValidatorID
}

pascal_id! {
	/// Names the TypeScript handler that receives a shape's validated recognition. The grammar crate only carries the
	/// identifier.
	HandlerID
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dotted_names_follow_the_rule() {
		assert!(is_dotted_name("number.signed_decimal"));
		assert!(is_dotted_name("a1"));
		assert!(!is_dotted_name(""));
		assert!(!is_dotted_name("a..b"));
		assert!(!is_dotted_name("A.b"));
		assert!(!is_dotted_name("1a"));
		assert!(!is_dotted_name("a."));
		assert!(!is_dotted_name("a-b"));
	}

	#[test]
	fn pascal_ids_validate_on_construction() {
		assert!(ValidatorID::new("WGS84Pair").is_ok());
		assert!(HandlerID::new("wgs84").is_err());
		assert!(HandlerID::new("").is_err());
	}
}
