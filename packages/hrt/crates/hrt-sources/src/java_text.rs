// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Numbers written as Java's `toString` writes them, so tag values from typed columns compare as Java's strings do.

/// Java's `Double.toString`: the shortest digits that round-trip, in plain notation with at least one fractional digit
/// for magnitudes from 1e-3 up to 1e7, and as `d.dddE±n` otherwise.
pub fn double_to_string(value: f64) -> String {
	if value.is_nan() {
		return "NaN".to_owned();
	}
	if value.is_infinite() {
		return if value > 0.0 {
			"Infinity".to_owned()
		} else {
			"-Infinity".to_owned()
		};
	}
	if value == 0.0 {
		return if value.is_sign_negative() {
			"-0.0".to_owned()
		} else {
			"0.0".to_owned()
		};
	}
	let magnitude = value.abs();
	if (1e-3..1e7).contains(&magnitude) {
		let plain = format!("{value}");
		return if plain.contains('.') {
			plain
		} else {
			format!("{plain}.0")
		};
	}
	// Rust's `{:e}` gives the shortest round-trip digits as d.ddde±n.
	let scientific = format!("{value:e}");
	let (mantissa, exponent) = scientific.split_once('e').unwrap();
	let mantissa = if mantissa.contains('.') {
		mantissa.to_owned()
	} else {
		format!("{mantissa}.0")
	};
	format!("{mantissa}E{exponent}")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn doubles_print_as_java_prints_them() {
		assert_eq!(double_to_string(1.0), "1.0");
		assert_eq!(double_to_string(1.7), "1.7");
		assert_eq!(double_to_string(-0.5), "-0.5");
		assert_eq!(double_to_string(0.001), "0.001");
		assert_eq!(double_to_string(0.0001), "1.0E-4");
		assert_eq!(double_to_string(12_345_678.0), "1.2345678E7");
		assert_eq!(double_to_string(9_999_999.0), "9999999.0");
		assert_eq!(double_to_string(0.0), "0.0");
	}
}
