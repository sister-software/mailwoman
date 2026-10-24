//! UTF-8 helpers with SentencePiece's exact semantics (upstream `src/util.h`, `src/util.cc`).

/// The byte length a UTF-8 lead byte announces, without validating the trailing bytes.
///
/// A trailing byte reports length 1, as upstream's lookup table does.
pub fn one_char_len(lead: u8) -> usize {
	const TABLE: [u8; 16] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4];
	TABLE[(lead >> 4) as usize] as usize
}

fn is_trail(b: u8) -> bool {
	(b as i8) < -0x40
}

fn is_valid_codepoint(c: u32) -> bool {
	c < 0xD800 || (0xE000..=0x10FFFF).contains(&c)
}

/// Decodes one character from the front of `input`, returning `(valid, byte_length)`.
///
/// Malformed input reports length 1. Upstream also treats a decode error of length 3 as valid,
/// a case its decoder never produces, so that branch is omitted.
pub fn decode_prefix(input: &[u8]) -> (bool, usize) {
	let len = input.len();
	let b0 = input[0];
	if b0 < 0x80 {
		return (true, 1);
	}
	if len >= 2 && (b0 & 0xE0) == 0xC0 {
		let cp = ((b0 as u32 & 0x1F) << 6) | (input[1] as u32 & 0x3F);
		if is_trail(input[1]) && cp >= 0x80 && is_valid_codepoint(cp) {
			return (true, 2);
		}
	} else if len >= 3 && (b0 & 0xF0) == 0xE0 {
		let cp = ((b0 as u32 & 0x0F) << 12) | ((input[1] as u32 & 0x3F) << 6) | (input[2] as u32 & 0x3F);
		if is_trail(input[1]) && is_trail(input[2]) && cp >= 0x800 && is_valid_codepoint(cp) {
			return (true, 3);
		}
	} else if len >= 4 && (b0 & 0xF8) == 0xF0 {
		let cp = ((b0 as u32 & 0x07) << 18)
			| ((input[1] as u32 & 0x3F) << 12)
			| ((input[2] as u32 & 0x3F) << 6)
			| (input[3] as u32 & 0x3F);
		if is_trail(input[1]) && is_trail(input[2]) && is_trail(input[3]) && cp >= 0x10000 && is_valid_codepoint(cp) {
			return (true, 4);
		}
	}
	(false, 1)
}
