// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The codepoint classes and the script ranges of the `structure` family, declared once.
//!
//! The family's grammar builds its character classes from these tables, and the engine's structure pass reads the same
//! tables to classify the codepoints inside a token, so the automata and the pass cannot disagree.
//!
//! The tables are the hand-written ranges of `@mailwoman/query-shape` and no Unicode property table. They stay equal to
//! that package's functions until a change widens both at once. The `structure` differential tests run the legacy
//! functions over every codepoint to hold them equal. Wider coverage is a separate change.

/// An inclusive range of codepoints.
pub type Range = (u32, u32);

/// The class of one codepoint. The classes are disjoint, so the order that decides ties in the legacy function does not
/// matter here, and a test holds them disjoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CharClass {
	Digit,
	Alpha,
	Whitespace,
	Connector,
	Punct,
	Cjk,
	Cyrillic,
	Arabic,
	Other,
}

/// ASCII digits.
pub const DIGIT: &[Range] = &[(0x30, 0x39)];

/// Latin letters: ASCII letters, Latin-1 letters with diacritics, Latin Extended-A and B, and Latin Extended Additional.
/// The range from U+00C0 includes the multiplication and division signs.
pub const ALPHA: &[Range] = &[(0x41, 0x5a), (0x61, 0x7a), (0xc0, 0x24f), (0x1e00, 0x1eff)];

/// Tab, line feed, carriage return, space and the no-break space.
pub const WHITESPACE: &[Range] = &[(0x09, 0x09), (0x0a, 0x0a), (0x0d, 0x0d), (0x20, 0x20), (0xa0, 0xa0)];

/// Codepoints that join adjacent characters into one token, as in `10118-1234` and `O'Brien`: the hyphen, the apostrophe,
/// the low line and the two single curly quotation marks.
pub const CONNECTOR: &[Range] = &[
	(0x2d, 0x2d),
	(0x27, 0x27),
	(0x5f, 0x5f),
	(0x2018, 0x2018),
	(0x2019, 0x2019),
];

/// Punctuation that ends a token. The set is the ASCII punctuation that is not a connector, the inverted exclamation
/// and question marks, the en and em dashes, the two double curly quotation marks, and the ideographic comma and full
/// stop.
pub const PUNCT: &[Range] = &[
	(0x21, 0x23),
	(0x25, 0x26),
	(0x28, 0x2c),
	(0x2e, 0x2f),
	(0x3a, 0x40),
	(0x5b, 0x5e),
	(0x60, 0x60),
	(0x7b, 0x7e),
	(0xa1, 0xa1),
	(0xbf, 0xbf),
	(0x2013, 0x2014),
	(0x201c, 0x201d),
	(0x3001, 0x3002),
];

/// The class `cjk` merges Kana, Han, Hangul, Yi and the whole halfwidth and fullwidth forms block.
pub const CJK: &[Range] = &[
	(0x3005, 0x3005),
	(0x3007, 0x3007),
	(0x3021, 0x3029),
	(0x3038, 0x303b),
	(0x3040, 0x30ff),
	(0x31f0, 0x31ff),
	(0x3400, 0x4dbf),
	(0x4e00, 0x9fff),
	(0xa000, 0xa4cf),
	(0xac00, 0xd7af),
	(0xf900, 0xfaff),
	(0xff00, 0xffef),
	(0x2_0000, 0x2_a6df),
];

pub const CYRILLIC: &[Range] = &[(0x0400, 0x04ff), (0x0500, 0x052f), (0x2de0, 0x2dff), (0xa640, 0xa69f)];

pub const ARABIC: &[Range] = &[
	(0x0600, 0x06ff),
	(0x0750, 0x077f),
	(0x08a0, 0x08ff),
	(0xfb50, 0xfdff),
	(0xfe70, 0xfeff),
];

/// The ten values of `ScriptCode` the legacy classifier produces: eight scripts, `Zyyy` for characters that belong to
/// no script, and `Zzzz` for a codepoint no range covers. The discriminant is the code the result records carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Script {
	Latn = 0,
	Hani = 1,
	Hira = 2,
	Kana = 3,
	Hang = 4,
	Cyrl = 5,
	Arab = 6,
	Yiii = 7,
	Zyyy = 8,
	Zzzz = 9,
}

/// The number of script values.
pub const SCRIPTS: usize = 10;

/// Codepoint ranges per script, most specific first. Halfwidth and fullwidth forms belong to several scripts: fullwidth
/// ASCII letters are Latin, halfwidth katakana is Kana and halfwidth jamo is Hangul.
pub const SCRIPT_RANGES: &[(Script, &[Range])] = &[
	(
		Script::Hira,
		&[(0x3041, 0x3096), (0x309d, 0x309f), (0x1_b001, 0x1_b001)],
	),
	(
		Script::Kana,
		&[
			(0x30a1, 0x30fa),
			(0x30fd, 0x30ff),
			(0x31f0, 0x31ff),
			(0xff66, 0xff6f),
			(0xff71, 0xff9d),
		],
	),
	(
		Script::Hang,
		&[
			(0x1100, 0x11ff),
			(0x3131, 0x318e),
			(0x302e, 0x302f),
			(0x3200, 0x321e),
			(0x3260, 0x327e),
			(0xa960, 0xa97c),
			(0xac00, 0xd7a3),
			(0xd7b0, 0xd7c6),
			(0xd7cb, 0xd7fb),
			(0xffa0, 0xffbe),
			(0xffc2, 0xffc7),
			(0xffca, 0xffcf),
			(0xffd2, 0xffd7),
			(0xffda, 0xffdc),
		],
	),
	(
		Script::Hani,
		&[
			(0x2e80, 0x2e99),
			(0x2e9b, 0x2ef3),
			(0x2f00, 0x2fd5),
			(0x3005, 0x3005),
			(0x3007, 0x3007),
			(0x3021, 0x3029),
			(0x3038, 0x303b),
			(0x3400, 0x4dbf),
			(0x4e00, 0x9fff),
			(0xf900, 0xfa6d),
			(0xfa70, 0xfad9),
			(0x2_0000, 0x2_a6df),
		],
	),
	(
		Script::Latn,
		&[
			(0x41, 0x5a),
			(0x61, 0x7a),
			(0xc0, 0xd6),
			(0xd8, 0xf6),
			(0xf8, 0x24f),
			(0x1e00, 0x1eff),
			(0xff21, 0xff3a),
			(0xff41, 0xff5a),
		],
	),
	(
		Script::Cyrl,
		&[
			(0x0400, 0x0484),
			(0x0487, 0x04ff),
			(0x0500, 0x052f),
			(0x2de0, 0x2dff),
			(0xa640, 0xa69f),
		],
	),
	(
		Script::Arab,
		&[
			(0x0620, 0x063f),
			(0x0641, 0x064a),
			(0x0656, 0x066f),
			(0x0671, 0x06dc),
			(0x06de, 0x06ff),
			(0x0750, 0x077f),
			(0x08a0, 0x08e1),
			(0x08e3, 0x08ff),
			(0xfb50, 0xfd3d),
			(0xfd40, 0xfdcf),
			(0xfdf0, 0xfdff),
			(0xfe70, 0xfe74),
			(0xfe76, 0xfefc),
		],
	),
	(Script::Yiii, &[(0xa000, 0xa48c), (0xa490, 0xa4c6)]),
];

/// Codepoints that Unicode assigns to `Common` inside blocks that otherwise belong to one script. They map to `Zyyy`, so
/// a script share ignores them.
pub const COMMON: &[Range] = &[
	(0x0640, 0x0640),
	(0x3000, 0x3004),
	(0x3006, 0x3006),
	(0x3008, 0x3020),
	(0x302a, 0x302d),
	(0x3030, 0x3037),
	(0x303c, 0x303f),
	(0x3099, 0x309c),
	(0x30a0, 0x30a0),
	(0x30fb, 0x30fc),
	(0xff01, 0xff20),
	(0xff3b, 0xff40),
	(0xff5b, 0xff65),
	(0xff70, 0xff70),
	(0xff9e, 0xff9f),
];

fn within(cp: u32, ranges: &[Range]) -> bool {
	ranges.iter().any(|&(low, high)| cp >= low && cp <= high)
}

/// The class of a codepoint, in the order the legacy function tests: digit, Latin letter, whitespace, connector,
/// punctuation, then the three script classes, and everything else is `Other`.
pub fn classify(cp: u32) -> CharClass {
	if within(cp, DIGIT) {
		CharClass::Digit
	} else if within(cp, ALPHA) {
		CharClass::Alpha
	} else if within(cp, WHITESPACE) {
		CharClass::Whitespace
	} else if within(cp, CONNECTOR) {
		CharClass::Connector
	} else if within(cp, PUNCT) {
		CharClass::Punct
	} else if within(cp, CJK) {
		CharClass::Cjk
	} else if within(cp, CYRILLIC) {
		CharClass::Cyrillic
	} else if within(cp, ARABIC) {
		CharClass::Arabic
	} else {
		CharClass::Other
	}
}

/// The script of a codepoint: `Zyyy` inside a common range, the script whose range holds it, `Zyyy` for the other digit,
/// punctuation, whitespace and connector codepoints, and `Zzzz` for everything else.
pub fn script_of(cp: u32) -> Script {
	if within(cp, COMMON) {
		return Script::Zyyy;
	}

	for (script, ranges) in SCRIPT_RANGES {
		if within(cp, ranges) {
			return *script;
		}
	}

	match classify(cp) {
		CharClass::Digit | CharClass::Punct | CharClass::Whitespace | CharClass::Connector => Script::Zyyy,
		_ => Script::Zzzz,
	}
}

/// The classes of the ASCII block, so the common case reads one byte.
const ASCII: [CharClass; 128] =
	{
		let mut table = [CharClass::Other; 128];
		let mut cp = 0;

		while cp < 128 {
			table[cp] =
				if cp >= 0x30 && cp <= 0x39 {
					CharClass::Digit
				} else if (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) {
					CharClass::Alpha
				} else if cp == 0x09 || cp == 0x0a || cp == 0x0d || cp == 0x20 {
					CharClass::Whitespace
				} else if cp == 0x2d || cp == 0x27 || cp == 0x5f {
					CharClass::Connector
				} else if (cp >= 0x21 && cp <= 0x23)
					|| cp == 0x25 || cp == 0x26
					|| (cp >= 0x28 && cp <= 0x2c)
					|| cp == 0x2e || cp == 0x2f
					|| (cp >= 0x3a && cp <= 0x40)
					|| (cp >= 0x5b && cp <= 0x5e)
					|| cp == 0x60 || (cp >= 0x7b && cp <= 0x7e)
				{
					CharClass::Punct
				} else {
					CharClass::Other
				};
			cp += 1;
		}

		table
	};

/// [`classify`], with a table for ASCII.
#[inline]
pub fn class_of(cp: char) -> CharClass {
	let cp = cp as u32;

	if cp < 128 {
		ASCII[cp as usize]
	} else {
		classify(cp)
	}
}

/// [`script_of`], with the ASCII letters and digits answered without a scan.
#[inline]
pub fn script_at(cp: char) -> Script {
	match cp {
		'A'..='Z' | 'a'..='z' => Script::Latn,
		'0'..='9' => Script::Zyyy,
		_ => script_of(cp as u32),
	}
}

/// The characters JavaScript's `\s` matches, which the segment rules trim: the ECMAScript white space and line
/// terminators. The set is the code units U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029,
/// U+202F, U+205F, U+3000 and U+FEFF.
pub const JS_WHITESPACE: &[Range] = &[
	(0x09, 0x0d),
	(0x20, 0x20),
	(0xa0, 0xa0),
	(0x1680, 0x1680),
	(0x2000, 0x200a),
	(0x2028, 0x2029),
	(0x202f, 0x202f),
	(0x205f, 0x205f),
	(0x3000, 0x3000),
	(0xfeff, 0xfeff),
];

/// The characters that separate segments: comma and semicolon (both reported as a comma), line feed and tab.
pub const SEGMENT_COMMA: &[Range] = &[(0x2c, 0x2c), (0x3b, 0x3b)];
pub const SEGMENT_NEWLINE: &[Range] = &[(0x0a, 0x0a)];
pub const SEGMENT_TAB: &[Range] = &[(0x09, 0x09)];

#[cfg(test)]
mod tests {
	use super::*;

	const CLASSES: [&[Range]; 8] = [DIGIT, ALPHA, WHITESPACE, CONNECTOR, PUNCT, CJK, CYRILLIC, ARABIC];

	#[test]
	fn the_classes_are_disjoint_and_their_ranges_are_ordered() {
		for (index, left) in CLASSES.iter().enumerate() {
			for &(low, high) in *left {
				assert!(low <= high, "{low:#x}..{high:#x} is reversed");

				for right in &CLASSES[index + 1..] {
					assert!(
						!right
							.iter()
							.any(|&(other_low, other_high)| low <= other_high && other_low <= high),
						"{low:#x}..{high:#x} overlaps another class"
					);
				}
			}
		}
	}

	#[test]
	fn the_script_ranges_and_the_common_ranges_are_disjoint() {
		let mut all: Vec<(u32, u32)> = COMMON.to_vec();

		for (_, ranges) in SCRIPT_RANGES {
			all.extend_from_slice(ranges);
		}

		all.sort_unstable();

		for pair in all.windows(2) {
			assert!(pair[0].1 < pair[1].0, "{:?} overlaps {:?}", pair[0], pair[1]);
		}
	}

	#[test]
	fn a_codepoint_that_is_whitespace_punctuation_or_a_connector_has_no_script() {
		// The structure pass adds up script counts over tokens only, which holds because no skipped codepoint counts.
		for cp in 0..=0x10_ffffu32 {
			if matches!(
				classify(cp),
				CharClass::Whitespace | CharClass::Punct | CharClass::Connector
			) {
				assert_eq!(script_of(cp), Script::Zyyy, "{cp:#x}");
			}
		}
	}

	#[test]
	fn the_ascii_table_and_the_scripts_shortcut_agree_with_the_ranges() {
		for cp in 0..128u32 {
			let character = char::from_u32(cp).unwrap();

			assert_eq!(class_of(character), classify(cp), "{cp:#x}");
			assert_eq!(script_at(character), script_of(cp), "{cp:#x}");
		}
	}

	#[test]
	fn the_known_quirks_of_the_legacy_tables_hold() {
		// Fullwidth Latin letters are class `cjk` with script `Latn`; Greek is class `other` with script `Zzzz`.
		assert_eq!(classify(0xff21), CharClass::Cjk);
		assert_eq!(script_of(0xff21), Script::Latn);
		assert_eq!(classify(0x3b1), CharClass::Other);
		assert_eq!(script_of(0x3b1), Script::Zzzz);
		// The multiplication sign is a Latin letter to the classifier and no script to the script table.
		assert_eq!(classify(0xd7), CharClass::Alpha);
		assert_eq!(script_of(0xd7), Script::Zzzz);
	}
}
