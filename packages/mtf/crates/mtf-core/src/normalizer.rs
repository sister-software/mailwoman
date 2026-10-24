//! SentencePiece's normalizer with original-input alignment (upstream `src/normalizer.cc`).

use crate::darts::DoubleArray;
use crate::error::Error;
use crate::unigram::ByteTrie;
use crate::utf8;

const SPACE_SYMBOL: &[u8] = "\u{2581}".as_bytes();
const REPLACEMENT_CHAR: &[u8] = "\u{FFFD}".as_bytes();

/// The normalization rules of one model.
pub struct Normalizer {
	/// The darts-clone trie bytes and the NUL-separated replacement strings it indexes.
	charsmap: Option<(Vec<u8>, Vec<u8>)>,
	add_dummy_prefix: bool,
	remove_extra_whitespaces: bool,
	escape_whitespaces: bool,
	treat_whitespace_as_suffix: bool,
}

/// A normalized string and, for each of its bytes plus one end position, the original-input byte
/// offset it came from.
pub struct Normalized {
	pub text: Vec<u8>,
	pub norm_to_orig: Vec<usize>,
}

impl Normalizer {
	pub fn new(
		precompiled_charsmap: &[u8],
		add_dummy_prefix: bool,
		remove_extra_whitespaces: bool,
		escape_whitespaces: bool,
		treat_whitespace_as_suffix: bool,
	) -> Result<Self, Error> {
		let charsmap = if precompiled_charsmap.is_empty() {
			None
		} else {
			Some(decode_charsmap(precompiled_charsmap)?)
		};
		Ok(Self {
			charsmap,
			add_dummy_prefix,
			remove_extra_whitespaces,
			escape_whitespaces,
			treat_whitespace_as_suffix,
		})
	}

	/// Returns the normalized form of the longest rule matching the front of `input` and the
	/// number of input bytes it consumes.
	fn normalize_prefix<'a>(
		&'a self,
		input: &'a [u8],
		user_defined: &ByteTrie,
		scratch: &mut Vec<(u32, usize)>,
	) -> (&'a [u8], usize) {
		if let Some(len) = user_defined.longest_prefix(input) {
			return (&input[..len], len);
		}
		let mut longest_length = 0usize;
		let mut longest_value = 0usize;
		if let Some((trie, replacements)) = &self.charsmap {
			// The blob was validated as whole units when the model loaded.
			let trie = DoubleArray::new(trie).expect("validated at load");
			trie.common_prefix_search(input, scratch);
			for &(value, length) in scratch.iter().take(32) {
				if longest_length == 0 || length > longest_length {
					longest_length = length;
					longest_value = value as usize;
				}
			}
			if longest_length != 0 && longest_length <= input.len() && longest_value < replacements.len() {
				let rest = &replacements[longest_value..];
				let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
				return (&rest[..end], longest_length);
			}
		}
		let (valid, length) = utf8::decode_prefix(input);
		if valid {
			(&input[..length], length)
		} else {
			(REPLACEMENT_CHAR, 1)
		}
	}

	/// Normalizes `input`, recording each output byte's original offset.
	pub fn normalize(&self, input: &[u8], user_defined: &ByteTrie) -> Result<Normalized, Error> {
		let mut out = Normalized {
			text: Vec::new(),
			norm_to_orig: Vec::new(),
		};
		if input.is_empty() {
			return Ok(out);
		}
		let mut scratch = Vec::new();
		let mut input = input;
		let mut consumed = 0usize;

		if self.remove_extra_whitespaces {
			while !input.is_empty() {
				let (sp, n) = self.normalize_prefix(input, user_defined, &mut scratch);
				if sp != b" " {
					break;
				}
				input = &input[n..];
				consumed += n;
			}
		}
		if input.is_empty() {
			return Ok(out);
		}

		let space: &[u8] = if self.escape_whitespaces { SPACE_SYMBOL } else { b" " };
		let add_ws = |out: &mut Normalized, consumed: usize| {
			out.text.extend_from_slice(space);
			out.norm_to_orig.extend(std::iter::repeat_n(consumed, space.len()));
		};

		if !self.treat_whitespace_as_suffix && self.add_dummy_prefix {
			add_ws(&mut out, consumed);
		}

		let mut is_prev_space = self.remove_extra_whitespaces;
		while !input.is_empty() {
			let (mut sp, n) = self.normalize_prefix(input, user_defined, &mut scratch);
			while is_prev_space && sp.first() == Some(&b' ') {
				sp = &sp[1..];
			}
			if !sp.is_empty() {
				for &b in sp {
					if b == b' ' {
						add_ws(&mut out, consumed);
					} else {
						out.text.push(b);
						out.norm_to_orig.push(consumed);
					}
				}
				is_prev_space = sp.last() == Some(&b' ');
			}
			consumed += n;
			input = &input[n..];
			if !self.remove_extra_whitespaces {
				is_prev_space = false;
			}
		}

		if self.remove_extra_whitespaces {
			while out.text.ends_with(space) {
				let length = out.text.len() - space.len();
				out.text.truncate(length);
				consumed = out.norm_to_orig[length];
				out.norm_to_orig.truncate(length);
			}
		}

		if self.treat_whitespace_as_suffix && self.add_dummy_prefix {
			add_ws(&mut out, consumed);
		}
		out.norm_to_orig.push(consumed);
		Ok(out)
	}
}

/// Splits a precompiled charsmap into its trie units and replacement strings, with upstream's checks.
fn decode_charsmap(blob: &[u8]) -> Result<(Vec<u8>, Vec<u8>), Error> {
	if blob.len() <= 4 {
		return Err(Error::MalformedModel("normalization rule blob is broken".into()));
	}
	let trie_size = u32::from_le_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
	if trie_size >= blob.len() - 4 {
		return Err(Error::MalformedModel(
			"trie data size exceeds the input blob size".into(),
		));
	}
	if trie_size < 1024 || trie_size & 0x3FF != 0 {
		return Err(Error::MalformedModel("trie data size is not divisible by 1024".into()));
	}
	let trie = blob[4..4 + trie_size].to_vec();
	let replacements = blob[4 + trie_size..].to_vec();
	if replacements.last() != Some(&0) {
		return Err(Error::MalformedModel("normalized block must be null terminated".into()));
	}
	DoubleArray::new(&trie)?;
	Ok((trie, replacements))
}
