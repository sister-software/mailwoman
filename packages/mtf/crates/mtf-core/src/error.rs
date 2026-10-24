// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

use std::fmt;

/// A failure to load a model, encode an input, or decode a sequence of IDs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
	/// The model bytes are not a well-formed protobuf message.
	MalformedModel(String),
	/// The model is well formed but uses a feature this crate does not implement.
	Unsupported(String),
	/// A decode input contained an ID outside the vocabulary.
	InvalidID(i64),
	/// An internal invariant failed while encoding; the message identifies which.
	Internal(String),
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Error::MalformedModel(m) => write!(f, "malformed model: {m}"),
			Error::Unsupported(m) => write!(f, "unsupported model feature: {m}"),
			Error::InvalidID(id) => write!(f, "invalid id: {id}"),
			Error::Internal(m) => write!(f, "internal error: {m}"),
		}
	}
}

impl std::error::Error for Error {}
