// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Decoding a vector tile back into layers, features, attributes and raw geometry commands.

use crate::layer::Value;

/// A feature read from a tile, with its attribute keys and values resolved from the layer tables.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedFeature {
	pub id: Option<u64>,
	/// 0 unknown, 1 point, 2 line, 3 polygon.
	pub geom_type: u64,
	pub commands: Vec<u32>,
	pub attributes: Vec<(String, Value)>,
}

/// A layer read from a tile.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedLayer {
	pub name: String,
	pub extent: u32,
	pub features: Vec<DecodedFeature>,
}

/// A tile that could not be parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeError(pub &'static str);

struct Reader<'a> {
	bytes: &'a [u8],
	at: usize,
}

impl<'a> Reader<'a> {
	fn done(&self) -> bool {
		self.at >= self.bytes.len()
	}

	fn varint(&mut self) -> Result<u64, DecodeError> {
		let mut value = 0u64;
		for shift in (0..64).step_by(7) {
			let byte = *self.bytes.get(self.at).ok_or(DecodeError("truncated varint"))?;
			self.at += 1;
			value |= u64::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return Ok(value);
			}
		}
		Err(DecodeError("varint longer than ten bytes"))
	}

	fn take(&mut self, length: usize) -> Result<&'a [u8], DecodeError> {
		let end = self.at.checked_add(length).ok_or(DecodeError("length overflow"))?;
		let slice = self.bytes.get(self.at..end).ok_or(DecodeError("truncated field"))?;
		self.at = end;
		Ok(slice)
	}

	fn bytes(&mut self) -> Result<&'a [u8], DecodeError> {
		let length = self.varint()? as usize;
		self.take(length)
	}

	/// Reads a field key, returning the field number and wire type.
	fn key(&mut self) -> Result<(u64, u64), DecodeError> {
		let key = self.varint()?;
		Ok((key >> 3, key & 7))
	}

	fn skip(&mut self, wire_type: u64) -> Result<(), DecodeError> {
		match wire_type {
			0 => {
				self.varint()?;
			}
			1 => {
				self.take(8)?;
			}
			2 => {
				self.bytes()?;
			}
			5 => {
				self.take(4)?;
			}
			_ => return Err(DecodeError("unsupported wire type")),
		}
		Ok(())
	}
}

fn packed(bytes: &[u8]) -> Result<Vec<u32>, DecodeError> {
	let mut reader = Reader { bytes, at: 0 };
	let mut out = Vec::new();
	while !reader.done() {
		out.push(reader.varint()? as u32);
	}
	Ok(out)
}

fn value(bytes: &[u8]) -> Result<Value, DecodeError> {
	let mut reader = Reader { bytes, at: 0 };
	let mut out = None;
	while !reader.done() {
		let (field, wire_type) = reader.key()?;
		out = Some(match (field, wire_type) {
			(1, 2) => Value::String(String::from_utf8_lossy(reader.bytes()?).into_owned()),
			(2, 5) => Value::Float(f32::from_le_bytes(reader.take(4)?.try_into().unwrap())),
			(3, 1) => Value::Double(f64::from_le_bytes(reader.take(8)?.try_into().unwrap())),
			(4, 0) => Value::Int(reader.varint()? as i64),
			(5, 0) => Value::UInt(reader.varint()?),
			(6, 0) => {
				let raw = reader.varint()?;
				Value::Int(((raw >> 1) as i64) ^ -((raw & 1) as i64))
			}
			(7, 0) => Value::Bool(reader.varint()? != 0),
			_ => {
				reader.skip(wire_type)?;
				continue;
			}
		});
	}
	out.ok_or(DecodeError("value without a field"))
}

/// Decodes an uncompressed tile.
pub fn decode_tile(bytes: &[u8]) -> Result<Vec<DecodedLayer>, DecodeError> {
	let mut reader = Reader { bytes, at: 0 };
	let mut layers = Vec::new();
	while !reader.done() {
		let (field, wire_type) = reader.key()?;
		if field == 3 && wire_type == 2 {
			layers.push(decode_layer(reader.bytes()?)?);
		} else {
			reader.skip(wire_type)?;
		}
	}
	Ok(layers)
}

fn decode_layer(bytes: &[u8]) -> Result<DecodedLayer, DecodeError> {
	let mut reader = Reader { bytes, at: 0 };
	let mut name = String::new();
	let mut extent = 4096;
	let mut keys = Vec::new();
	let mut values = Vec::new();
	let mut raw_features = Vec::new();
	while !reader.done() {
		let (field, wire_type) = reader.key()?;
		match (field, wire_type) {
			(1, 2) => name = String::from_utf8_lossy(reader.bytes()?).into_owned(),
			(2, 2) => raw_features.push(reader.bytes()?),
			(3, 2) => keys.push(String::from_utf8_lossy(reader.bytes()?).into_owned()),
			(4, 2) => values.push(value(reader.bytes()?)?),
			(5, 0) => extent = reader.varint()? as u32,
			_ => reader.skip(wire_type)?,
		}
	}

	let mut features = Vec::with_capacity(raw_features.len());
	for raw in raw_features {
		let mut reader = Reader { bytes: raw, at: 0 };
		let mut feature = DecodedFeature {
			id: None,
			geom_type: 0,
			commands: Vec::new(),
			attributes: Vec::new(),
		};
		let mut tags = Vec::new();
		while !reader.done() {
			let (field, wire_type) = reader.key()?;
			match (field, wire_type) {
				(1, 0) => feature.id = Some(reader.varint()?),
				(2, 2) => tags = packed(reader.bytes()?)?,
				(3, 0) => feature.geom_type = reader.varint()?,
				(4, 2) => feature.commands = packed(reader.bytes()?)?,
				_ => reader.skip(wire_type)?,
			}
		}
		for pair in tags.chunks(2) {
			let key = keys.get(pair[0] as usize).ok_or(DecodeError("tag key out of range"))?;
			let value = values
				.get(*pair.get(1).ok_or(DecodeError("odd tag count"))? as usize)
				.ok_or(DecodeError("tag value out of range"))?;
			feature.attributes.push((key.clone(), value.clone()));
		}
		features.push(feature);
	}
	Ok(DecodedLayer { name, extent, features })
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{encode_tile, Geometry, LayerBuilder};

	#[test]
	fn an_encoded_tile_decodes_to_the_same_features() {
		let mut layer = LayerBuilder::new("roads", 4096);
		layer.add_feature(
			Some(7),
			&Geometry::Lines(vec![vec![[1, 1], [10, 1]]]),
			&[("kind", Value::String("major".into())), ("lanes", Value::Int(-2))],
		);
		let layers = decode_tile(&encode_tile(&[layer])).unwrap();
		assert_eq!(layers.len(), 1);
		assert_eq!(layers[0].name, "roads");
		let feature = &layers[0].features[0];
		assert_eq!(feature.id, Some(7));
		assert_eq!(feature.geom_type, 2);
		assert_eq!(feature.commands, vec![9, 2, 2, 10, 18, 0]);
		assert_eq!(
			feature.attributes,
			vec![
				("kind".to_owned(), Value::String("major".into())),
				("lanes".to_owned(), Value::Int(-2))
			]
		);
	}
}
