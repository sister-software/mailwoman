// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

use std::fmt;

/// A failure to open a corpus, to read one of its files, or to sample or encode one of its rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
	/// The configuration, a manifest, a lexicon or a sidecar is missing or malformed; the message names the file or
	/// the key.
	Input(String),
	/// A corpus file cannot be read; the message names the path.
	Io(String),
	/// A sampled row is corrupt or cannot be transformed as configured; the message names the file, the row group and
	/// the row's text where they are known.
	Row(String),
	/// The caller cancelled the stream.
	Cancelled,
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Error::Input(m) => write!(f, "invalid sampler input: {m}"),
			Error::Io(m) => write!(f, "cannot read corpus file: {m}"),
			Error::Row(m) => write!(f, "corrupt row: {m}"),
			Error::Cancelled => f.write_str("the sampler was cancelled"),
		}
	}
}

impl std::error::Error for Error {}

impl From<mtf_channels::Error> for Error {
	fn from(error: mtf_channels::Error) -> Self {
		match error {
			mtf_channels::Error::Input(m) => Error::Input(m),
			other => Error::Row(other.to_string()),
		}
	}
}

impl From<crate::pyrandom::DrawError> for Error {
	fn from(error: crate::pyrandom::DrawError) -> Self {
		Error::Row(error.0)
	}
}

pub type Result<T> = std::result::Result<T, Error>;

/// A Python `repr`-like quotation of a row's text for error messages.
pub(crate) fn quote(raw: &str) -> String {
	format!("{raw:?}")
}
