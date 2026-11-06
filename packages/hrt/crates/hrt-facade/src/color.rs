// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from Arnis `src/colors.rs` at commit d8e8b662 (github.com/louis-e/arnis, Apache-2.0). The color-name table
// moved to `packages/structures/data/facade/color-names.json`; the conversions are unchanged.

//! OSM color values (`#rrggbb`, `#rgb` or a name) as sRGB bytes, and the Oklab conversion every palette match uses.

use crate::data;

pub type RGBTuple = (u8, u8, u8);

/// The sRGB bytes of an OSM color value, or `None` for a value neither hex nor a known name.
pub fn color_text_to_rgb_tuple(text: &str) -> Option<RGBTuple> {
	let trimmed = text.trim();
	full_hex(trimmed)
		.or_else(|| short_hex(trimmed))
		.or_else(|| color_name(trimmed))
}

fn full_hex(text: &str) -> Option<RGBTuple> {
	if text.len() != 7 || !text.starts_with('#') || !text.chars().skip(1).all(|c| c.is_ascii_hexdigit()) {
		return None;
	}
	let r = u8::from_str_radix(&text[1..3], 16).ok()?;
	let g = u8::from_str_radix(&text[3..5], 16).ok()?;
	let b = u8::from_str_radix(&text[5..7], 16).ok()?;
	Some((r, g, b))
}

fn short_hex(text: &str) -> Option<RGBTuple> {
	if text.len() != 4 || !text.starts_with('#') || !text.chars().skip(1).all(|c| c.is_ascii_hexdigit()) {
		return None;
	}
	let channel = |at: usize| u8::from_str_radix(&text[at..at + 1], 16).ok().map(|v| v | (v << 4));
	Some((channel(1)?, channel(2)?, channel(3)?))
}

/// Lowercase with whitespace, `_` and `-` removed, the normalization Arnis applies to tag values before matching.
pub fn norm_tag(value: &str) -> String {
	value
		.chars()
		.filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
		.flat_map(|c| c.to_lowercase())
		.collect()
}

fn color_name(text: &str) -> Option<RGBTuple> {
	let normalized = norm_tag(text);
	data::tables().color_names.get(&normalized).map(|c| (c[0], c[1], c[2]))
}

/// Squared Oklab distance between two colors already converted.
#[inline]
pub fn oklab_distance_lab(a: (f32, f32, f32), b: (f32, f32, f32)) -> f32 {
	let dl = a.0 - b.0;
	let da = a.1 - b.1;
	let db = a.2 - b.2;
	dl * dl + da * da + db * db
}

/// The Oklab components (L, a, b) of an sRGB color.
pub fn oklab_components(color: &RGBTuple) -> (f32, f32, f32) {
	rgb_to_oklab(color.0, color.1, color.2)
}

#[inline]
fn srgb_to_linear(c: u8) -> f32 {
	let c = c as f32 / 255.0;
	if c <= 0.04045 {
		c / 12.92
	} else {
		((c + 0.055) / 1.055).powf(2.4)
	}
}

/// sRGB to Oklab, with the constants Arnis uses.
#[inline]
pub fn rgb_to_oklab(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
	let r = srgb_to_linear(r);
	let g = srgb_to_linear(g);
	let b = srgb_to_linear(b);
	let l = 0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b;
	let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
	let s = 0.088_302_46 * r + 0.281_718_84 * g + 0.629_978_7 * b;
	let l = l.cbrt();
	let m = m.cbrt();
	let s = s.cbrt();
	(
		0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
		1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
		0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn hex_and_names_parse() {
		assert_eq!(color_text_to_rgb_tuple("#A0B1C2"), Some((0xa0, 0xb1, 0xc2)));
		assert_eq!(color_text_to_rgb_tuple("#abc"), Some((0xaa, 0xbb, 0xcc)));
		assert_eq!(color_text_to_rgb_tuple("Dark_Grey"), Some((96, 96, 96)));
		assert_eq!(color_text_to_rgb_tuple("mauve"), None);
	}

	#[test]
	fn brown_is_nearer_than_red_in_oklab() {
		let target = oklab_components(&(139, 90, 60));
		let red = oklab_components(&(229, 0, 0));
		let brown = oklab_components(&(115, 70, 40));
		assert!(oklab_distance_lab(target, brown) < oklab_distance_lab(target, red));
	}
}
