// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A source feature as a layer sees it: its tags, with any tags the layer sets on top, and its geometry flags.

use hrt_osm::{ElementKind, SourceFeature};

/// A source feature with a writable tag overlay, standing in for Planetiler's mutable `SourceFeature` tags.
pub struct Input<'a> {
	pub source: &'a SourceFeature<'a>,
	/// The source layer of a non-OSM source, such as `ne_10m_lakes`; empty for OpenStreetMap.
	pub source_layer: &'a str,
	overlay: Vec<(String, Option<String>)>,
}

impl<'a> Input<'a> {
	pub fn new(source: &'a SourceFeature<'a>) -> Self {
		Input {
			source,
			source_layer: "",
			overlay: Vec::new(),
		}
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
