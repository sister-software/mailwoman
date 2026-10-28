// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

/// One SentencePiece piece with code-point offsets into the row's text.
///
/// `begin` is inclusive and `end` exclusive. A piece that starts with the `▁` word marker covers the space
/// before its word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece {
	pub id: u32,
	pub begin: usize,
	pub end: usize,
}

/// One painted channel over a row's pieces: `dim` features and one confidence per piece.
///
/// The values are `f64`, the precision the Python loader computed them in. They become `f32` once, when the
/// encoder packs the batch, which is the conversion `torch.tensor(..., dtype=torch.float32)` applied.
#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
	pub dim: usize,
	pub features: Vec<f64>,
	pub confidence: Vec<f64>,
}

impl Channel {
	/// A channel of `pieces` zero rows.
	pub fn zeros(dim: usize, pieces: usize) -> Self {
		Self {
			dim,
			features: vec![0.0; dim * pieces],
			confidence: vec![0.0; pieces],
		}
	}

	/// The number of pieces the channel covers.
	pub fn len(&self) -> usize {
		self.confidence.len()
	}

	/// Whether the channel covers no piece.
	pub fn is_empty(&self) -> bool {
		self.confidence.is_empty()
	}

	/// The features of piece `i`.
	pub fn row(&self, i: usize) -> &[f64] {
		&self.features[i * self.dim..(i + 1) * self.dim]
	}

	/// Sets piece `i`'s features and confidence.
	pub fn set(&mut self, i: usize, features: &[f64], confidence: f64) {
		self.features[i * self.dim..(i + 1) * self.dim].copy_from_slice(features);
		self.confidence[i] = confidence;
	}

	/// Truncates to `max_length` pieces and zero-pads to it, the width every tensor of a row has.
	pub fn fit(&mut self, max_length: usize) {
		self.features.resize(max_length * self.dim, 0.0);
		self.confidence.resize(max_length, 0.0);
	}
}
