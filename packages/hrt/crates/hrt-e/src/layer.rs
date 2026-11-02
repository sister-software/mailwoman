// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Layers and tiles.

use std::collections::HashMap;

use crate::geometry::{encode, Geometry};
use crate::proto::{
	bytes_field, packed_field, tag, varint, varint_field, zigzag64, WIRE_FIXED32, WIRE_FIXED64, WIRE_VARINT,
};

/// The extent most tiles use: 4096 units per tile side.
pub const DEFAULT_EXTENT: u32 = 4_096;

/// An attribute value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
	String(String),
	Float(f32),
	Double(f64),
	/// Written as the `sint64` field, so a negative value costs as few bytes as a positive one.
	Int(i64),
	/// Written as the `uint64` field.
	UInt(u64),
	Bool(bool),
}

/// A value's identity in the layer's value table. Floats key on their bit pattern, so two values intern together only
/// when they encode identically.
#[derive(Clone, PartialEq, Eq, Hash)]
enum ValueKey {
	String(String),
	Float(u32),
	Double(u64),
	Int(i64),
	UInt(u64),
	Bool(bool),
}

impl From<&Value> for ValueKey {
	fn from(value: &Value) -> Self {
		match value {
			Value::String(text) => ValueKey::String(text.clone()),
			Value::Float(number) => ValueKey::Float(number.to_bits()),
			Value::Double(number) => ValueKey::Double(number.to_bits()),
			Value::Int(number) => ValueKey::Int(*number),
			Value::UInt(number) => ValueKey::UInt(*number),
			Value::Bool(flag) => ValueKey::Bool(*flag),
		}
	}
}

fn encode_value(value: &Value) -> Vec<u8> {
	let mut buffer = Vec::new();

	match value {
		Value::String(text) => bytes_field(&mut buffer, 1, text.as_bytes()),
		Value::Float(number) => {
			tag(&mut buffer, 2, WIRE_FIXED32);
			buffer.extend_from_slice(&number.to_le_bytes());
		}
		Value::Double(number) => {
			tag(&mut buffer, 3, WIRE_FIXED64);
			buffer.extend_from_slice(&number.to_le_bytes());
		}
		Value::UInt(number) => varint_field(&mut buffer, 5, *number),
		Value::Int(number) => varint_field(&mut buffer, 6, zigzag64(*number)),
		Value::Bool(flag) => {
			tag(&mut buffer, 7, WIRE_VARINT);
			varint(&mut buffer, u64::from(*flag));
		}
	}

	buffer
}

/// Accumulates one layer's features, interning each attribute key and value once.
pub struct LayerBuilder {
	name: String,
	extent: u32,
	keys: Vec<String>,
	key_index: HashMap<String, u32>,
	values: Vec<Value>,
	value_index: HashMap<ValueKey, u32>,
	features: Vec<u8>,
	feature_count: usize,
}

impl LayerBuilder {
	pub fn new(name: impl Into<String>, extent: u32) -> Self {
		LayerBuilder {
			name: name.into(),
			extent,
			keys: Vec::new(),
			key_index: HashMap::new(),
			values: Vec::new(),
			value_index: HashMap::new(),
			features: Vec::new(),
			feature_count: 0,
		}
	}

	/// The number of features added and kept.
	pub fn len(&self) -> usize {
		self.feature_count
	}

	pub fn is_empty(&self) -> bool {
		self.feature_count == 0
	}

	fn key(&mut self, key: &str) -> u32 {
		if let Some(&index) = self.key_index.get(key) {
			return index;
		}

		let index = self.keys.len() as u32;
		self.keys.push(key.to_owned());
		self.key_index.insert(key.to_owned(), index);
		index
	}

	fn value(&mut self, value: &Value) -> u32 {
		let key = ValueKey::from(value);

		if let Some(&index) = self.value_index.get(&key) {
			return index;
		}

		let index = self.values.len() as u32;
		self.values.push(value.clone());
		self.value_index.insert(key, index);
		index
	}

	/// Adds a feature and returns whether it was kept. A feature whose geometry encodes to no commands, such as a
	/// collapsed ring, is left out.
	pub fn add_feature(&mut self, id: Option<u64>, geometry: &Geometry, attributes: &[(&str, Value)]) -> bool {
		self.add_encoded_feature(id, geometry.type_code(), &encode(geometry), attributes)
	}

	/// Adds a feature whose geometry is already encoded as commands, with its geometry type code: 1 for points, 2 for
	/// lines, 3 for polygons. A feature with no commands is left out, and the return value says whether it was kept.
	pub fn add_encoded_feature(
		&mut self,
		id: Option<u64>,
		type_code: u64,
		commands: &[u32],
		attributes: &[(&str, Value)],
	) -> bool {
		if commands.is_empty() {
			return false;
		}

		let mut tags = Vec::with_capacity(attributes.len() * 2);
		for (key, value) in attributes {
			let key_index = self.key(key);
			let value_index = self.value(value);
			tags.push(key_index);
			tags.push(value_index);
		}

		let mut feature = Vec::with_capacity(commands.len() * 2 + tags.len() + 16);
		if let Some(id) = id {
			varint_field(&mut feature, 1, id);
		}
		packed_field(&mut feature, 2, &tags);
		varint_field(&mut feature, 3, type_code);
		packed_field(&mut feature, 4, commands);

		bytes_field(&mut self.features, 2, &feature);
		self.feature_count += 1;

		true
	}

	/// The layer message: name, features, keys, values, extent and version 2.
	///
	/// Fields go in ascending field number, the order Java's protobuf serializer writes them in, so a tile with the same
	/// content as Planetiler's encodes to the same bytes.
	pub fn encode(&self) -> Vec<u8> {
		let mut buffer = Vec::with_capacity(self.features.len() + self.keys.len() * 8 + self.values.len() * 8 + 32);

		bytes_field(&mut buffer, 1, self.name.as_bytes());
		buffer.extend_from_slice(&self.features);

		for key in &self.keys {
			bytes_field(&mut buffer, 3, key.as_bytes());
		}

		for value in &self.values {
			bytes_field(&mut buffer, 4, &encode_value(value));
		}

		varint_field(&mut buffer, 5, u64::from(self.extent));
		varint_field(&mut buffer, 15, 2);

		buffer
	}
}

/// The tile message for these layers, leaving out any layer with no features.
pub fn encode_tile(layers: &[LayerBuilder]) -> Vec<u8> {
	let mut tile = Vec::new();

	for layer in layers.iter().filter(|layer| !layer.is_empty()) {
		bytes_field(&mut tile, 3, &layer.encode());
	}

	tile
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn interns_repeated_keys_and_values() {
		let mut layer = LayerBuilder::new("roads", DEFAULT_EXTENT);
		let attributes = [
			("kind", Value::String("major_road".into())),
			("min_zoom", Value::Int(7)),
		];

		assert!(layer.add_feature(Some(1), &Geometry::Lines(vec![vec![[0, 0], [10, 0]]]), &attributes));
		assert!(layer.add_feature(Some(2), &Geometry::Lines(vec![vec![[0, 5], [10, 5]]]), &attributes));

		assert_eq!(layer.keys, vec!["kind", "min_zoom"]);
		assert_eq!(layer.values.len(), 2);
		assert_eq!(layer.len(), 2);
	}

	#[test]
	fn leaves_out_a_feature_with_no_drawable_geometry_and_an_empty_layer() {
		let mut layer = LayerBuilder::new("water", DEFAULT_EXTENT);

		assert!(!layer.add_feature(None, &Geometry::Lines(vec![vec![[3, 3]]]), &[]));
		assert!(encode_tile(&[layer]).is_empty());
	}
}
