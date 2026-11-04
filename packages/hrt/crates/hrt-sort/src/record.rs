// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// The encoding follows Planetiler 0.10.2's FeatureGroup (Apache-2.0, Copyright Michael Barry), which packs with
// msgpack-java.

//! The bytes stored beside each sort key: a rendered feature's group, id, geometry and attributes.
//!
//! Features with equal keys are ordered by these bytes, compared unsigned, so the record is the MessagePack value
//! Planetiler's `FeatureGroup.encodeValue` writes: the group and its limit, the id, a type-and-scale byte, the attribute
//! map in key order, and the geometry commands, each in msgpack-java's most compact form. One part differs. Planetiler
//! writes each attribute key as a number its string table assigns in first-use order across worker threads, so between
//! features whose key sets differ its order depends on thread scheduling; this record writes the key itself.
//!
//! Decoding returns the attributes in the order Planetiler's tile encoder visits them: the iteration order of the
//! `HashMap` it decodes into, with integers read back as longs and floats as doubles.

use hrt_e::Value;
use hrt_render::{GeometryType, Group, VectorGeometry};

/// A rendered feature as the sort stores it.
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureRecord {
	pub group: Option<Group>,
	pub id: i64,
	pub geometry: VectorGeometry,
	/// The attributes in Java `String.compareTo` key order when encoding.
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

/// msgpack-java's `packLong`, which `packInt` matches for values in the `int` range.
fn pack_long(out: &mut Vec<u8>, value: i64) {
	if value < -(1 << 5) {
		if value < -(1 << 15) {
			if value < -(1 << 31) {
				out.push(0xd3);
				out.extend_from_slice(&value.to_be_bytes());
			} else {
				out.push(0xd2);
				out.extend_from_slice(&(value as i32).to_be_bytes());
			}
		} else if value < -(1 << 7) {
			out.push(0xd1);
			out.extend_from_slice(&(value as i16).to_be_bytes());
		} else {
			out.push(0xd0);
			out.push(value as i8 as u8);
		}
	} else if value < (1 << 7) {
		out.push(value as i8 as u8);
	} else {
		pack_unsigned(out, value as u64);
	}
}

fn pack_unsigned(out: &mut Vec<u8>, value: u64) {
	if value < (1 << 7) {
		out.push(value as u8);
	} else if value < (1 << 8) {
		out.extend_from_slice(&[0xcc, value as u8]);
	} else if value < (1 << 16) {
		out.push(0xcd);
		out.extend_from_slice(&(value as u16).to_be_bytes());
	} else if value < (1 << 32) {
		out.push(0xce);
		out.extend_from_slice(&(value as u32).to_be_bytes());
	} else {
		out.push(0xcf);
		out.extend_from_slice(&value.to_be_bytes());
	}
}

/// A header for a string, array or map: a fix form below `fix_limit`, else the 8-, 16- or 32-bit form.
fn pack_header(out: &mut Vec<u8>, length: usize, fix: u8, fix_limit: usize, wide: [Option<u8>; 3]) {
	if length < fix_limit {
		out.push(fix | length as u8);
	} else if let (Some(tag), true) = (wide[0], length < (1 << 8)) {
		out.extend_from_slice(&[tag, length as u8]);
	} else if length < (1 << 16) {
		out.push(wide[1].unwrap());
		out.extend_from_slice(&(length as u16).to_be_bytes());
	} else {
		out.push(wide[2].unwrap());
		out.extend_from_slice(&(length as u32).to_be_bytes());
	}
}

fn pack_string(out: &mut Vec<u8>, text: &str) {
	pack_header(out, text.len(), 0xa0, 32, [Some(0xd9), Some(0xda), Some(0xdb)]);
	out.extend_from_slice(text.as_bytes());
}

fn pack_double(out: &mut Vec<u8>, value: f64) {
	out.push(0xcb);
	out.extend_from_slice(&value.to_be_bytes());
}

impl FeatureRecord {
	/// Appends the record's bytes to `out`.
	pub fn encode(&self, out: &mut Vec<u8>) {
		if let Some(group) = self.group {
			pack_long(out, group.id);
			pack_long(out, i64::from(group.limit));
		}
		pack_long(out, self.id);
		// `packByte` of a Java byte: the type in the low three bits and the scale above it.
		let type_and_scale = (type_byte(self.geometry.geom_type) | ((self.geometry.scale as u8) << 3)) as i8;
		pack_long(out, i64::from(type_and_scale));
		pack_header(out, self.attributes.len(), 0x80, 16, [None, Some(0xde), Some(0xdf)]);
		for (key, value) in &self.attributes {
			pack_string(out, key);
			match value {
				Value::String(text) => pack_string(out, text),
				Value::Float(number) => pack_double(out, f64::from(*number)),
				Value::Double(number) => pack_double(out, *number),
				Value::Int(number) => pack_long(out, *number),
				Value::UInt(number) => pack_unsigned(out, *number),
				Value::Bool(flag) => out.push(if *flag { 0xc3 } else { 0xc2 }),
			}
		}
		pack_header(
			out,
			self.geometry.commands.len(),
			0x90,
			16,
			[None, Some(0xdc), Some(0xdd)],
		);
		for &command in &self.geometry.commands {
			pack_long(out, i64::from(command as i32));
		}
	}

	/// Reads a record written by [`FeatureRecord::encode`]; `has_group` comes from the sort key. The attributes come
	/// back in Java `HashMap` iteration order, integers as [`Value::Int`] and floats as [`Value::Double`].
	pub fn decode(bytes: &[u8], has_group: bool) -> Result<FeatureRecord, RecordError> {
		let mut reader = Reader { bytes, at: 0 };
		let group = if has_group {
			Some(Group {
				id: reader.integer()?,
				limit: reader.integer()? as i32,
			})
		} else {
			None
		};
		let id = reader.integer()?;
		let type_and_scale = reader.integer()? as i8 as u8;
		let attribute_count = reader.map_header()?;
		let mut attributes = Vec::with_capacity(attribute_count);
		for _ in 0..attribute_count {
			let key = reader.string()?;
			attributes.push((key, reader.value()?));
		}
		let command_count = reader.array_header()?;
		let commands = (0..command_count)
			.map(|_| reader.integer().map(|value| value as i32 as u32))
			.collect::<Result<_, _>>()?;
		Ok(FeatureRecord {
			group,
			id,
			geometry: VectorGeometry {
				commands,
				geom_type: type_from_byte(type_and_scale)?,
				scale: u32::from(type_and_scale >> 3),
			},
			attributes: java_hash_map_order(attributes),
		})
	}

	/// Reads only the group from a record that has one.
	pub fn peek_group(bytes: &[u8]) -> Result<Group, RecordError> {
		let mut reader = Reader { bytes, at: 0 };
		Ok(Group {
			id: reader.integer()?,
			limit: reader.integer()? as i32,
		})
	}
}

/// Java's `String.hashCode` over UTF-16 code units.
fn java_string_hash(text: &str) -> i32 {
	text.encode_utf16()
		.fold(0i32, |hash, unit| hash.wrapping_mul(31).wrapping_add(i32::from(unit)))
}

/// Reorders entries inserted in this order into the iteration order of `HashMap.newHashMap(entries.len())`.
///
/// That map is sized so it never resizes: its table holds the smallest power of two at least `ceil(n / 0.75)`
/// buckets. Iteration walks the buckets in index order, and a bucket's entries in insertion order. A bucket that
/// reaches eight entries in a table of 64 or more becomes a tree whose order this does not model.
fn java_hash_map_order<T>(entries: Vec<(String, T)>) -> Vec<(String, T)> {
	let wanted = (entries.len() as f64 / 0.75).ceil() as usize;
	let capacity = wanted.max(1).next_power_of_two();
	let mut indexed: Vec<(usize, (String, T))> = entries
		.into_iter()
		.map(|entry| {
			let hash = java_string_hash(&entry.0) as u32;
			((hash ^ (hash >> 16)) as usize & (capacity - 1), entry)
		})
		.collect();
	// A stable sort keeps insertion order within a bucket.
	indexed.sort_by_key(|(bucket, _)| *bucket);
	indexed.into_iter().map(|(_, entry)| entry).collect()
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

	fn be<const N: usize>(&mut self) -> Result<[u8; N], RecordError> {
		Ok(self.take(N)?.try_into().unwrap())
	}

	fn integer_after(&mut self, tag: u8) -> Result<Option<i64>, RecordError> {
		Ok(Some(match tag {
			0x00..=0x7f => i64::from(tag),
			0xe0..=0xff => i64::from(tag as i8),
			0xcc => i64::from(self.byte()?),
			0xcd => i64::from(u16::from_be_bytes(self.be()?)),
			0xce => i64::from(u32::from_be_bytes(self.be()?)),
			0xcf => u64::from_be_bytes(self.be()?) as i64,
			0xd0 => i64::from(self.byte()? as i8),
			0xd1 => i64::from(i16::from_be_bytes(self.be()?)),
			0xd2 => i64::from(i32::from_be_bytes(self.be()?)),
			0xd3 => i64::from_be_bytes(self.be()?),
			_ => return Ok(None),
		}))
	}

	fn integer(&mut self) -> Result<i64, RecordError> {
		let tag = self.byte()?;
		self.integer_after(tag)?.ok_or(RecordError("expected an integer"))
	}

	fn length_after(
		&mut self,
		tag: u8,
		fix: u8,
		fix_mask: u8,
		wide: [Option<u8>; 3],
	) -> Result<Option<usize>, RecordError> {
		if tag & !fix_mask == fix {
			return Ok(Some(usize::from(tag & fix_mask)));
		}
		Ok(if Some(tag) == wide[0] {
			Some(usize::from(self.byte()?))
		} else if Some(tag) == wide[1] {
			Some(usize::from(u16::from_be_bytes(self.be()?)))
		} else if Some(tag) == wide[2] {
			Some(u32::from_be_bytes(self.be()?) as usize)
		} else {
			None
		})
	}

	fn string_after(&mut self, tag: u8) -> Result<Option<String>, RecordError> {
		match self.length_after(tag, 0xa0, 0x1f, [Some(0xd9), Some(0xda), Some(0xdb)])? {
			Some(length) => Ok(Some(String::from_utf8_lossy(self.take(length)?).into_owned())),
			None => Ok(None),
		}
	}

	fn string(&mut self) -> Result<String, RecordError> {
		let tag = self.byte()?;
		self.string_after(tag)?.ok_or(RecordError("expected a string"))
	}

	fn map_header(&mut self) -> Result<usize, RecordError> {
		let tag = self.byte()?;
		self.length_after(tag, 0x80, 0x0f, [None, Some(0xde), Some(0xdf)])?
			.ok_or(RecordError("expected a map"))
	}

	fn array_header(&mut self) -> Result<usize, RecordError> {
		let tag = self.byte()?;
		self.length_after(tag, 0x90, 0x0f, [None, Some(0xdc), Some(0xdd)])?
			.ok_or(RecordError("expected an array"))
	}

	fn value(&mut self) -> Result<Value, RecordError> {
		let tag = self.byte()?;
		match tag {
			0xc2 => return Ok(Value::Bool(false)),
			0xc3 => return Ok(Value::Bool(true)),
			0xcb => return Ok(Value::Double(f64::from_be_bytes(self.be()?))),
			_ => {}
		}
		if let Some(number) = self.integer_after(tag)? {
			return Ok(Value::Int(number));
		}
		self.string_after(tag)?
			.map(Value::String)
			.ok_or(RecordError("unknown attribute type"))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn record(id: i64, attributes: Vec<(String, Value)>) -> FeatureRecord {
		FeatureRecord {
			group: Some(Group { id: -3, limit: 2 }),
			id,
			geometry: VectorGeometry {
				commands: vec![9, 4, 6],
				geom_type: GeometryType::Point,
				scale: 0,
			},
			attributes,
		}
	}

	fn encode(record: &FeatureRecord) -> Vec<u8> {
		let mut bytes = Vec::new();
		record.encode(&mut bytes);
		bytes
	}

	#[test]
	fn a_record_round_trips_with_attributes_in_hash_order() {
		let attributes = vec![
			("name".to_owned(), Value::String("Monaco".into())),
			("ok".to_owned(), Value::Bool(true)),
			("rank".to_owned(), Value::Int(-4)),
			("size".to_owned(), Value::Double(2.5)),
		];
		let decoded = FeatureRecord::decode(&encode(&record(42, attributes.clone())), true).unwrap();
		assert_eq!(decoded.id, 42);
		assert_eq!(decoded.geometry.commands, [9, 4, 6]);
		let mut sorted = decoded.attributes.clone();
		sorted.sort_by(|a, b| a.0.cmp(&b.0));
		assert_eq!(sorted, attributes);
		assert_eq!(
			FeatureRecord::peek_group(&encode(&record(1, vec![]))).unwrap(),
			Group { id: -3, limit: 2 }
		);
	}

	#[test]
	fn integers_take_msgpack_java_forms() {
		let packed = |value| {
			let mut out = Vec::new();
			pack_long(&mut out, value);
			out
		};
		assert_eq!(packed(5), [0x05]);
		assert_eq!(packed(-3), [0xfd]);
		assert_eq!(packed(-33), [0xd0, 0xdf]);
		assert_eq!(packed(200), [0xcc, 200]);
		assert_eq!(packed(70_000), [0xce, 0x00, 0x01, 0x11, 0x70]);
	}

	#[test]
	fn ties_order_by_big_endian_values() {
		let height = |meters: f64| {
			encode(&record(
				7,
				vec![
					("height".into(), Value::Double(meters)),
					("kind".into(), Value::String("x".into())),
				],
			))
		};
		assert!(height(3.3) < height(8.0));
		assert!(encode(&record(127, vec![])) < encode(&record(128, vec![])));
		assert!(encode(&record(255, vec![])) < encode(&record(70_000, vec![])));
	}

	#[test]
	fn hash_order_follows_java() {
		// Each case's iteration order is what Java 21 printed for HashMap.newHashMap(n) filled in sorted key order.
		let cases: [(&[&str], &[&str]); 4] = [
			(&["height", "kind", "min_height"], &["min_height", "kind", "height"]),
			(
				&["crown_base", "crown_diameter", "height", "kind", "leaf_type"],
				&["leaf_type", "crown_diameter", "kind", "crown_base", "height"],
			),
			(
				&["kind", "kind_detail", "min_zoom", "name", "sort_rank", "surface"],
				&["name", "kind_detail", "surface", "sort_rank", "kind", "min_zoom"],
			),
			(
				&["name", "name:de", "name:en", "name:fr", "pgf:name", "script"],
				&["name", "name:fr", "name:de", "name:en", "pgf:name", "script"],
			),
		];
		for (sorted, expected) in cases {
			let order: Vec<String> = java_hash_map_order(sorted.iter().map(|key| (key.to_string(), ())).collect())
				.into_iter()
				.map(|(key, _)| key)
				.collect();
			assert_eq!(order, expected);
		}
		assert_eq!(java_string_hash("height"), -1_221_029_593);
		assert_eq!(java_string_hash("min_height"), -826_243_148);
		assert_eq!(java_string_hash("pgf:name"), 1_821_939_158);
	}
}
