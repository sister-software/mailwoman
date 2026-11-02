// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The bytes stored beside each sort key: a rendered feature's group, id, geometry and attributes.
//!
//! Features with equal keys are ordered by these bytes, compared unsigned, as Planetiler orders its msgpack values. The
//! group and id are written big-endian with the sign bit flipped, so byte order equals numeric order, which is the order
//! msgpack gives Planetiler for the non-negative ids its profiles produce. The geometry byte uses Planetiler's type
//! numbers, 1 point, 2 line and 4 polygon, with the scale in the upper five bits.

use hrt_e::Value;
use hrt_render::{GeometryType, Group, VectorGeometry};

/// A rendered feature as the sort stores it.
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureRecord {
	pub group: Option<Group>,
	pub id: i64,
	pub geometry: VectorGeometry,
	pub attributes: Vec<(String, Value)>,
}

/// Bytes that are not a record this module wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordError(pub &'static str);

fn type_byte(geom_type: GeometryType) -> u8 {
	match geom_type {
		GeometryType::Unknown => 0,
		GeometryType::Point => 1,
		GeometryType::Line => 2,
		GeometryType::Polygon => 4,
	}
}

fn type_from_byte(byte: u8) -> Result<GeometryType, RecordError> {
	Ok(match byte & 0b111 {
		0 => GeometryType::Unknown,
		1 => GeometryType::Point,
		2 => GeometryType::Line,
		4 => GeometryType::Polygon,
		_ => return Err(RecordError("unknown geometry type")),
	})
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
	while value >= 0x80 {
		out.push((value as u8) | 0x80);
		value >>= 7;
	}
	out.push(value as u8);
}

fn ordered_i64(value: i64) -> [u8; 8] {
	((value as u64) ^ (1 << 63)).to_be_bytes()
}

fn ordered_i32(value: i32) -> [u8; 4] {
	((value as u32) ^ (1 << 31)).to_be_bytes()
}

impl FeatureRecord {
	/// Appends the record's bytes to `out`.
	pub fn encode(&self, out: &mut Vec<u8>) {
		if let Some(group) = self.group {
			out.extend_from_slice(&ordered_i64(group.id));
			out.extend_from_slice(&ordered_i32(group.limit));
		}
		out.extend_from_slice(&ordered_i64(self.id));
		out.push(type_byte(self.geometry.geom_type) | ((self.geometry.scale as u8) << 3));
		varint(out, self.attributes.len() as u64);
		for (key, value) in &self.attributes {
			varint(out, key.len() as u64);
			out.extend_from_slice(key.as_bytes());
			match value {
				Value::String(text) => {
					out.push(1);
					varint(out, text.len() as u64);
					out.extend_from_slice(text.as_bytes());
				}
				Value::Float(number) => {
					out.push(2);
					out.extend_from_slice(&number.to_le_bytes());
				}
				Value::Double(number) => {
					out.push(3);
					out.extend_from_slice(&number.to_le_bytes());
				}
				Value::Int(number) => {
					out.push(4);
					out.extend_from_slice(&number.to_le_bytes());
				}
				Value::UInt(number) => {
					out.push(5);
					out.extend_from_slice(&number.to_le_bytes());
				}
				Value::Bool(flag) => {
					out.push(6);
					out.push(u8::from(*flag));
				}
			}
		}
		varint(out, self.geometry.commands.len() as u64);
		for &command in &self.geometry.commands {
			varint(out, u64::from(command));
		}
	}

	/// Reads a record written by [`FeatureRecord::encode`]; `has_group` comes from the sort key.
	pub fn decode(bytes: &[u8], has_group: bool) -> Result<FeatureRecord, RecordError> {
		let mut reader = Reader { bytes, at: 0 };
		let group = if has_group {
			Some(Group {
				id: reader.ordered_i64()?,
				limit: reader.ordered_i32()?,
			})
		} else {
			None
		};
		let id = reader.ordered_i64()?;
		let type_and_scale = reader.byte()?;
		let attribute_count = reader.varint()? as usize;
		let mut attributes = Vec::with_capacity(attribute_count);
		for _ in 0..attribute_count {
			let key = reader.string()?;
			let value = match reader.byte()? {
				1 => Value::String(reader.string()?),
				2 => Value::Float(f32::from_le_bytes(reader.take(4)?.try_into().unwrap())),
				3 => Value::Double(f64::from_le_bytes(reader.take(8)?.try_into().unwrap())),
				4 => Value::Int(i64::from_le_bytes(reader.take(8)?.try_into().unwrap())),
				5 => Value::UInt(u64::from_le_bytes(reader.take(8)?.try_into().unwrap())),
				6 => Value::Bool(reader.byte()? != 0),
				_ => return Err(RecordError("unknown attribute type")),
			};
			attributes.push((key, value));
		}
		let command_count = reader.varint()? as usize;
		let commands = (0..command_count)
			.map(|_| reader.varint().map(|value| value as u32))
			.collect::<Result<_, _>>()?;
		Ok(FeatureRecord {
			group,
			id,
			geometry: VectorGeometry {
				commands,
				geom_type: type_from_byte(type_and_scale)?,
				scale: u32::from(type_and_scale >> 3),
			},
			attributes,
		})
	}

	/// Reads only the group from a record that has one.
	pub fn peek_group(bytes: &[u8]) -> Result<Group, RecordError> {
		let mut reader = Reader { bytes, at: 0 };
		Ok(Group {
			id: reader.ordered_i64()?,
			limit: reader.ordered_i32()?,
		})
	}
}

struct Reader<'a> {
	bytes: &'a [u8],
	at: usize,
}

impl Reader<'_> {
	fn take(&mut self, length: usize) -> Result<&[u8], RecordError> {
		let slice = self
			.bytes
			.get(self.at..self.at + length)
			.ok_or(RecordError("truncated record"))?;
		self.at += length;
		Ok(slice)
	}

	fn byte(&mut self) -> Result<u8, RecordError> {
		Ok(self.take(1)?[0])
	}

	fn varint(&mut self) -> Result<u64, RecordError> {
		let mut value = 0u64;
		for shift in (0..64).step_by(7) {
			let byte = self.byte()?;
			value |= u64::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return Ok(value);
			}
		}
		Err(RecordError("varint longer than ten bytes"))
	}

	fn string(&mut self) -> Result<String, RecordError> {
		let length = self.varint()? as usize;
		Ok(String::from_utf8_lossy(self.take(length)?).into_owned())
	}

	fn ordered_i64(&mut self) -> Result<i64, RecordError> {
		let raw = u64::from_be_bytes(self.take(8)?.try_into().unwrap());
		Ok((raw ^ (1 << 63)) as i64)
	}

	fn ordered_i32(&mut self) -> Result<i32, RecordError> {
		let raw = u32::from_be_bytes(self.take(4)?.try_into().unwrap());
		Ok((raw ^ (1 << 31)) as i32)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn record(id: i64) -> FeatureRecord {
		FeatureRecord {
			group: Some(Group { id: -3, limit: 2 }),
			id,
			geometry: VectorGeometry {
				commands: vec![9, 4, 6],
				geom_type: GeometryType::Point,
				scale: 0,
			},
			attributes: vec![
				("name".into(), Value::String("Monaco".into())),
				("rank".into(), Value::Int(-4)),
				("ok".into(), Value::Bool(true)),
			],
		}
	}

	#[test]
	fn a_record_round_trips() {
		let mut bytes = Vec::new();
		record(42).encode(&mut bytes);
		assert_eq!(FeatureRecord::decode(&bytes, true).unwrap(), record(42));
		assert_eq!(FeatureRecord::peek_group(&bytes).unwrap(), Group { id: -3, limit: 2 });
	}

	#[test]
	fn byte_order_follows_numeric_id_order() {
		let encode = |id| {
			let mut bytes = Vec::new();
			FeatureRecord {
				group: None,
				..record(id)
			}
			.encode(&mut bytes);
			bytes
		};
		assert!(encode(-1) < encode(0));
		assert!(encode(127) < encode(128));
		assert!(encode(255) < encode(70_000));
	}
}
