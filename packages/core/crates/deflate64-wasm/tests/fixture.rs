// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Inflates the member of `packages/core/test/fixtures/zip/deflate64.zip` through `Decoder` with
//! input and output spans of several sizes, and checks that every split yields the same bytes, the
//! length and CRC-32 the archive's local header records, and a `DONE` status. The TypeScript suite
//! compares the bytes with the source itself.

use deflate64_wasm::{status, Decoder};

const ARCHIVE: &[u8] = include_bytes!("../../../test/fixtures/zip/deflate64.zip");

fn u16_at(bytes: &[u8], offset: usize) -> usize {
	u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
	u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// The first member's method, CRC-32, uncompressed length and compressed bytes, read from its local header.
fn first_member() -> (usize, u32, usize, &'static [u8]) {
	assert_eq!(u32_at(ARCHIVE, 0), 0x0403_4b50, "a local file header signature");

	let method = u16_at(ARCHIVE, 8);
	let crc = u32_at(ARCHIVE, 14);
	let compressed = u32_at(ARCHIVE, 18) as usize;
	let uncompressed = u32_at(ARCHIVE, 22) as usize;
	let start = 30 + u16_at(ARCHIVE, 26) + u16_at(ARCHIVE, 28);

	(method, crc, uncompressed, &ARCHIVE[start..start + compressed])
}

fn crc32(bytes: &[u8]) -> u32 {
	let mut crc = !0u32;

	for byte in bytes {
		crc ^= *byte as u32;

		for _ in 0..8 {
			crc = if crc & 1 == 1 {
				(crc >> 1) ^ 0xEDB8_8320
			} else {
				crc >> 1
			};
		}
	}

	!crc
}

/// Inflates `compressed` in `input_span`-byte chunks through an `output_span`-byte buffer, as the TypeScript
/// wrapper drives the exports.
fn inflate(compressed: &[u8], input_span: usize, output_span: usize) -> (Vec<u8>, i32) {
	let mut decoder = Decoder::new();
	let mut output = vec![0u8; output_span];
	let mut inflated = Vec::new();
	let mut last = status::MORE;

	'chunks: for chunk in compressed.chunks(input_span) {
		let mut offset = 0;

		loop {
			last = decoder.inflate(&chunk[offset..], &mut output);
			offset += decoder.consumed();
			inflated.extend_from_slice(&output[..decoder.written()]);

			if last != status::MORE {
				break 'chunks;
			}

			if offset == chunk.len() && decoder.written() < output_span {
				break;
			}
		}
	}

	(inflated, last)
}

#[test]
fn the_fixture_member_is_deflate64() {
	assert_eq!(first_member().0, 9);
}

#[test]
fn every_split_inflates_to_the_recorded_length_and_crc() {
	let (_, crc, uncompressed, compressed) = first_member();

	for (input_span, output_span) in [(compressed.len(), 1 << 20), (65_536, 262_144), (4_096, 1_000), (7, 13)] {
		let (inflated, last) = inflate(compressed, input_span, output_span);

		assert_eq!(last, status::DONE, "input {input_span}, output {output_span}");
		assert_eq!(inflated.len(), uncompressed, "input {input_span}, output {output_span}");
		assert_eq!(crc32(&inflated), crc, "input {input_span}, output {output_span}");
	}
}

#[test]
fn a_truncated_stream_never_reports_done() {
	let (_, _, _, compressed) = first_member();
	let (_, last) = inflate(&compressed[..compressed.len() / 2], 4_096, 65_536);

	assert_eq!(last, status::MORE);
}

#[test]
fn a_reserved_block_type_is_a_data_error() {
	// The first byte's low three bits are BFINAL = 1 and BTYPE = 3, which the format reserves.
	let (_, last) = inflate(&[0b0000_0111, 0, 0, 0], 4, 64);

	assert_eq!(last, status::DATA_ERROR);
}
