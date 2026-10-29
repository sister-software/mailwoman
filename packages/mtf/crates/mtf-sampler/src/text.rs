// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Python 3.12's string operations the sampler performs, over `mtf_channels::python_text`'s tables.

use mtf_channels::python_text::is_space;

/// `str.split()` with no argument: the runs of non-`isspace` characters.
pub fn split_whitespace(text: &str) -> Vec<String> {
	let mut out = Vec::new();
	let mut current = String::new();
	for c in text.chars() {
		if is_space(c) {
			if !current.is_empty() {
				out.push(std::mem::take(&mut current));
			}
		} else {
			current.push(c);
		}
	}
	if !current.is_empty() {
		out.push(current);
	}
	out
}

/// The `(start, end)` of each match of `\S+` in `text`, as `re.finditer` reports them.
pub fn non_space_runs(text: &[char]) -> Vec<(usize, usize)> {
	let mut out = Vec::new();
	let mut start = None;
	for (i, &c) in text.iter().enumerate() {
		match (is_space(c), start) {
			(false, None) => start = Some(i),
			(true, Some(s)) => {
				out.push((s, i));
				start = None;
			}
			_ => {}
		}
	}
	if let Some(s) = start {
		out.push((s, text.len()));
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn split_follows_python_whitespace() {
		assert_eq!(split_whitespace("  a\u{1C}b\u{A0} c "), vec!["a", "b", "c"]);
		assert!(split_whitespace(" \t").is_empty());
	}

	#[test]
	fn runs_report_code_point_offsets() {
		let text: Vec<char> = "É  rue\u{3000}x".chars().collect();
		assert_eq!(non_space_runs(&text), vec![(0, 1), (3, 6), (7, 8)]);
	}
}
