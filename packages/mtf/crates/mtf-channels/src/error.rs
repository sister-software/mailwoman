// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

use std::fmt;

/// A failure to read an encoder input or to encode a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
	/// A lexicon, lookup or record file is not in the expected format; the message identifies the file and field.
	Input(String),
	/// A row cannot be encoded as given; the message quotes the row.
	Row(String),
	/// A span finder failed while matching; the message identifies the pattern and the text.
	Finder(String),
}

impl Error {
	/// The same failure with the index of the batch row it occurred in prefixed to its message.
	pub fn at_row(self, index: usize) -> Self {
		match self {
			Error::Input(m) => Error::Input(format!("row {index}: {m}")),
			Error::Row(m) => Error::Row(format!("row {index}: {m}")),
			Error::Finder(m) => Error::Finder(format!("row {index}: {m}")),
		}
	}
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Error::Input(m) => write!(f, "invalid encoder input: {m}"),
			Error::Row(m) => write!(f, "cannot encode row: {m}"),
			Error::Finder(m) => write!(f, "span finder failed: {m}"),
		}
	}
}

impl std::error::Error for Error {}

/// A Python `repr`-like quotation of a row's text for error messages.
pub(crate) fn quote(raw: &[char]) -> String {
	format!("{:?}", raw.iter().collect::<String>())
}
