// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Protocol buffer wire encoding: varints, tags and length-delimited fields.

pub const WIRE_VARINT: u32 = 0;
pub const WIRE_FIXED64: u32 = 1;
pub const WIRE_LENGTH_DELIMITED: u32 = 2;
pub const WIRE_FIXED32: u32 = 5;

pub fn varint(buffer: &mut Vec<u8>, mut value: u64) {
	while value >= 0x80 {
		buffer.push((value as u8) | 0x80);
		value >>= 7;
	}
	buffer.push(value as u8);
}

pub fn tag(buffer: &mut Vec<u8>, field: u32, wire_type: u32) {
	varint(buffer, u64::from((field << 3) | wire_type));
}

pub fn bytes_field(buffer: &mut Vec<u8>, field: u32, bytes: &[u8]) {
	tag(buffer, field, WIRE_LENGTH_DELIMITED);
	varint(buffer, bytes.len() as u64);
	buffer.extend_from_slice(bytes);
}

pub fn varint_field(buffer: &mut Vec<u8>, field: u32, value: u64) {
	tag(buffer, field, WIRE_VARINT);
	varint(buffer, value);
}

/// A packed repeated `uint32` field.
pub fn packed_field(buffer: &mut Vec<u8>, field: u32, values: &[u32]) {
	if values.is_empty() {
		return;
	}

	let mut packed = Vec::with_capacity(values.len() * 2);
	for &value in values {
		varint(&mut packed, u64::from(value));
	}

	bytes_field(buffer, field, &packed);
}

pub fn zigzag32(value: i32) -> u32 {
	((value << 1) ^ (value >> 31)) as u32
}

pub fn zigzag64(value: i64) -> u64 {
	((value << 1) ^ (value >> 63)) as u64
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn varints_and_zigzag_match_the_protobuf_encoding() {
		let mut buffer = Vec::new();
		varint(&mut buffer, 300);
		assert_eq!(buffer, vec![0xac, 0x02]);

		assert_eq!(zigzag32(0), 0);
		assert_eq!(zigzag32(-1), 1);
		assert_eq!(zigzag32(1), 2);
		assert_eq!(zigzag32(-2), 3);
		assert_eq!(zigzag64(-3), 5);
	}
}
