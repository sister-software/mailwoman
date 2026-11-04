// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! A source feature as a layer sees it: its tags, with any tags the layer sets on top, and its geometry flags.

use hrt_osm::{ElementKind, SourceFeature};

use crate::pgf::FontRegistry;

/// A source feature with a writable tag overlay, standing in for Planetiler's mutable `SourceFeature` tags.
pub struct Input<'a> {
	pub source: &'a SourceFeature<'a>,
	/// The source layer of a non-OSM source, such as `ne_10m_lakes`; empty for OpenStreetMap.
	pub source_layer: &'a str,
	/// The fonts whose scripts' names are written as `pgf:` attributes; `None` writes none, as the fork does without
	/// `pgf-encoding.zip`.
	pub fonts: Option<&'a FontRegistry>,
	overlay: Vec<(String, Option<String>)>,
}

impl<'a> Input<'a> {
	pub fn new(source: &'a SourceFeature<'a>) -> Self {
		Input {
			source,
			source_layer: "",
			fonts: None,
			overlay: Vec::new(),
		}
	}

	/// Sets the fonts the names of this feature are encoded with.
	pub fn with_fonts(mut self, fonts: Option<&'a FontRegistry>) -> Self {
		self.fonts = fonts;
		self
	}

	/// Returns the tag's value, or `None` when the feature lacks it.
	pub fn tag(&self, key: &str) -> Option<&str> {
		if let Some((_, value)) = self.overlay.iter().rev().find(|(k, _)| k == key) {
			return value.as_deref();
		}
		self.source.tags.get(key)
	}

	pub fn has_tag(&self, key: &str) -> bool {
		self.tag(key).is_some()
	}

	/// Returns whether the tag's value is one of `values`, as Planetiler's `hasTag(key, values...)` does.
	pub fn has_tag_in(&self, key: &str, values: &[&str]) -> bool {
		self.tag(key).is_some_and(|value| values.contains(&value))
	}

	/// Sets a tag for the rest of this feature's processing, as Planetiler's `SourceFeature.setTag` does.
	pub fn set_tag(&mut self, key: &str, value: Option<String>) {
		self.overlay.push((key.to_owned(), value));
	}

	/// Returns every tag, the overlay applied, in the source's order followed by tags only the overlay holds.
	pub fn tags(&self) -> Vec<(&str, &str)> {
		let mut out: Vec<(&str, &str)> = Vec::new();
		for (key, _) in &self.source.tags.0 {
			if let Some(value) = self.tag(key) {
				out.push((key.as_str(), value));
			}
		}
		for (key, _) in &self.overlay {
			if !out.iter().any(|(existing, _)| *existing == key.as_str()) {
				if let Some(value) = self.tag(key) {
					out.push((key.as_str(), value));
				}
			}
		}
		out
	}

	pub fn is_point(&self) -> bool {
		self.source.is_point()
	}

	pub fn can_be_line(&self) -> bool {
		self.source.can_be_line()
	}

	pub fn can_be_polygon(&self) -> bool {
		self.source.can_be_polygon()
	}

	pub fn kind(&self) -> ElementKind {
		self.source.kind
	}

	pub fn id(&self) -> i64 {
		self.source.id
	}
}
