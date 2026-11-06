// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Key encodings: the position of a code in its direct-address key space.
//!
//! Two or three upper-case ASCII letters encode base-26, most significant letter first:
//! `key = ((a - 65) * 26 + (b - 65)) * 26 + (c - 65)` for three letters. A three-digit numeric code
//! encodes as its decimal value. Every encoder checks length and alphabet first and answers `None`
//! for anything else; a caller normalizes case or whitespace before calling, never here.

/// The number of two-letter keys: 26².
pub const KEY_SPACE_2: u32 = 676;
/// The number of three-letter keys: 26³.
pub const KEY_SPACE_3: u32 = 17_576;
/// The number of three-digit numeric keys.
pub const KEY_SPACE_NUMERIC: u32 = 1000;

/// The arity value a section's `aux` carries for a numeric key space.
pub const ARITY_NUMERIC: u32 = 0;

/// The size of the key space for an arity, or `None` for an arity no section declares.
pub const fn key_space(arity: u32) -> Option<u32> {
	match arity {
		ARITY_NUMERIC => Some(KEY_SPACE_NUMERIC),
		2 => Some(KEY_SPACE_2),
		3 => Some(KEY_SPACE_3),
		_ => None,
	}
}

#[inline]
const fn letter(byte: u8) -> Option<u32> {
	if byte >= b'A' && byte <= b'Z' {
		Some((byte - b'A') as u32)
	} else {
		None
	}
}

/// Encodes two upper-case letters.
#[inline]
pub fn encode2(code: &[u8]) -> Option<u32> {
	match code {
		[a, b] => Some(letter(*a)? * 26 + letter(*b)?),
		_ => None,
	}
}

/// Encodes three upper-case letters.
#[inline]
pub fn encode3(code: &[u8]) -> Option<u32> {
	match code {
		[a, b, c] => Some((letter(*a)? * 26 + letter(*b)?) * 26 + letter(*c)?),
		_ => None,
	}
}

/// Encodes three bytes the caller has already established as upper-case ASCII letters.
///
/// A byte outside `A..=Z` produces a key outside the space or a wrong key, so the caller validates first; the batch
/// kernel does so sixteen bytes at a time and calls this for the validated prefix.
#[inline]
pub fn encode3_unchecked(code: &[u8]) -> u32 {
	((code[0] - b'A') as u32 * 26 + (code[1] - b'A') as u32) * 26 + (code[2] - b'A') as u32
}

/// Encodes three ASCII digits, keeping a leading zero's position.
#[inline]
pub fn encode_numeric(code: &[u8]) -> Option<u32> {
	match code {
		[a, b, c] if a.is_ascii_digit() && b.is_ascii_digit() && c.is_ascii_digit() => {
			Some(((a - b'0') as u32) * 100 + ((b - b'0') as u32) * 10 + (c - b'0') as u32)
		}
		_ => None,
	}
}

/// Encodes a code for the arity a section declares.
#[inline]
pub fn encode(arity: u32, code: &[u8]) -> Option<u32> {
	match arity {
		ARITY_NUMERIC => encode_numeric(code),
		2 => encode2(code),
		3 => encode3(code),
		_ => None,
	}
}

/// Writes the three letters of a three-letter key into `out`.
pub fn decode3(key: u32, out: &mut [u8; 3]) {
	out[0] = b'A' + (key / 676) as u8;
	out[1] = b'A' + ((key / 26) % 26) as u8;
	out[2] = b'A' + (key % 26) as u8;
}

/// Writes the two letters of a two-letter key into `out`.
pub fn decode2(key: u32, out: &mut [u8; 2]) {
	out[0] = b'A' + (key / 26) as u8;
	out[1] = b'A' + (key % 26) as u8;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn three_letters_round_trip() {
		let mut out = [0u8; 3];

		for key in 0..KEY_SPACE_3 {
			decode3(key, &mut out);
			assert_eq!(encode3(&out), Some(key));
		}
	}

	#[test]
	fn refuses_other_shapes() {
		assert_eq!(encode3(b"aus"), None);
		assert_eq!(encode3(b"AU"), None);
		assert_eq!(encode3(b"AUS "), None);
		assert_eq!(encode3(b"A1S"), None);
		assert_eq!(encode2(b"US"), Some(20 * 26 + 18));
		assert_eq!(encode_numeric(b"036"), Some(36));
		assert_eq!(encode_numeric(b"36"), None);
	}
}
