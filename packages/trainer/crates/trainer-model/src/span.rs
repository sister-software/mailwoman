//! `nn/span_scorer.py`: the semi-Markov span scorer, its segment-transition CRF and the gold segmentation.
//!
//! The scorer gives every `(start, length, type)` span a score, `(B, S, max_span, T)`, from the classifier's input.
//! The segment types are `trainer_export::span::segment_types` of the label set, which the exported sidecar names
//! too: `O` and then each tag in the order its BIO labels first name it. The CRF's
//! negative log-likelihood is the span loss. A span of length above 1 cannot be `O`: the length mask adds `-1e4` to
//! those scores before the partition function and the decode, but not to the gold path's score.

use crate::layers::Linear;
use crate::store::Store;
use crate::{fail, Result};
use tch::{Device, Kind, Tensor};

/// The score the length mask and the empty forward variables carry, `_NEG_INF`.
const NEG_INF: f64 = -1e4;

/// One gold segment: `(start, length, type id)`.
pub type Segment = (usize, usize, usize);

/// `gold_segments`: the row's labels read as segments up to its first ignored position, and whether every entity
/// segment fits within `max_span`. An `O` position is a segment of its own.
pub fn gold_segments(
	row: &[i64],
	labels: &[String],
	types: &[String],
	ignore_index: i64,
	max_span: usize,
) -> Result<(Vec<Segment>, bool)> {
	let label = |id: i64| -> Result<&str> {
		usize::try_from(id)
			.ok()
			.and_then(|i| labels.get(i))
			.map(String::as_str)
			.ok_or_else(|| fail!("label id {id} is outside the label set"))
	};
	let type_id = |component: &str| -> Result<usize> {
		types
			.iter()
			.position(|t| t == component)
			.ok_or_else(|| fail!("segment type {component} is not in the segment types"))
	};
	let (mut segments, mut representable, mut i) = (Vec::new(), true, 0usize);
	let n = row.len();
	while i < n {
		if row[i] == ignore_index {
			break;
		}
		let current = label(row[i])?;
		if current == "O" {
			segments.push((i, 1, 0));
			i += 1;
			continue;
		}
		let component = current.split_once('-').map_or(current, |(_, c)| c);
		let inside = format!("I-{component}");
		let mut length = 1;
		while i + length < n && row[i + length] != ignore_index && label(row[i + length])? == inside {
			length += 1;
		}
		if length > max_span {
			representable = false;
		}
		segments.push((i, length, type_id(component)?));
		i += length;
	}
	Ok((segments, representable))
}

/// `SpanScorer`: a start and an end projection, and a type projection of their sum's `tanh`.
pub struct SpanScorer {
	pub max_span: i64,
	start_proj: Linear,
	end_proj: Linear,
	type_out: Linear,
}

impl SpanScorer {
	pub fn new(store: &mut Store, prefix: &str, hidden: i64, span_dim: i64, max_span: i64, types: i64) -> Self {
		Self {
			max_span,
			start_proj: Linear::new(store, &format!("{prefix}.start_proj"), hidden, span_dim, true),
			end_proj: Linear::new(store, &format!("{prefix}.end_proj"), hidden, span_dim, true),
			type_out: Linear::new(store, &format!("{prefix}.type_out"), span_dim, types, true),
		}
	}

	/// The span scores `(B, S, max_span, T)`: position `[b, i, l]` scores the span of `l + 1` units starting at `i`.
	/// A span that runs past the sequence reads zeros for its end projection, as `F.pad` writes them.
	pub fn forward(&self, h: &Tensor) -> Tensor {
		let starts = self.start_proj.forward(h);
		let ends = self.end_proj.forward(h);
		let shifted: Vec<Tensor> = (0..self.max_span)
			.map(|offset| ends.constant_pad_nd([0, 0, 0, offset]).slice(1, offset, None, 1))
			.collect();
		let shifted = Tensor::stack(&shifted, 2);
		let span_h = (starts.unsqueeze(2) + shifted).tanh();
		self.type_out.forward(&span_h)
	}
}

/// `SemiMarkovCRF`: the segment-type transitions with their start and end scores.
pub struct SemiMarkovCrf {
	pub max_span: i64,
	pub transitions: Tensor,
	pub start_transitions: Tensor,
	pub end_transitions: Tensor,
}

impl SemiMarkovCrf {
	pub fn new(store: &mut Store, prefix: &str, max_span: i64, types: i64) -> Self {
		let zeros = |shape: &[i64]| Tensor::zeros(shape, (Kind::Float, Device::Cpu));
		Self {
			max_span,
			transitions: store.param(&format!("{prefix}.transitions"), zeros(&[types, types])),
			start_transitions: store.param(&format!("{prefix}.start_transitions"), zeros(&[types])),
			end_transitions: store.param(&format!("{prefix}.end_transitions"), zeros(&[types])),
		}
	}

	/// `_length_mask`: `-1e4` on every `O` span longer than one unit.
	fn length_mask(&self, types: i64, device: Device) -> Tensor {
		let mask = Tensor::zeros([self.max_span, types], (Kind::Float, device));
		if self.max_span > 1 {
			let _ = mask.narrow(0, 1, self.max_span - 1).select(1, 0).fill_(NEG_INF);
		}
		mask
	}

	/// `log_partition`: the log of the sum over every segmentation of `[0, length)` of its score.
	pub fn log_partition(&self, span_scores: &Tensor, lengths: &Tensor) -> Tensor {
		let size = span_scores.size();
		let (batch, seq_len, types) = (size[0], size[1], size[3]);
		let scores = span_scores.to_kind(Kind::Float) + self.length_mask(types, span_scores.device());
		let trans = self.transitions.to_kind(Kind::Float);
		let mut alpha = Tensor::full([batch, seq_len + 1, types], NEG_INF, (Kind::Float, scores.device()));
		for j in 1..=seq_len {
			let mut candidates = Vec::new();
			for span_len in 1..=self.max_span.min(j) {
				let i = j - span_len;
				let segment = scores.select(1, i).select(1, span_len - 1);
				let prev = if i == 0 {
					self.start_transitions
						.to_kind(Kind::Float)
						.unsqueeze(0)
						.expand([batch, types], false)
				} else {
					(alpha.select(1, i).unsqueeze(2) + trans.unsqueeze(0)).logsumexp([1], false)
				};
				candidates.push(prev + segment);
			}
			alpha = alpha.copy();
			let value = Tensor::stack(&candidates, 0).logsumexp([0], false);
			alpha.select(1, j).copy_(&value);
		}
		let idx = lengths
			.to_device(alpha.device())
			.view([batch, 1, 1])
			.expand([batch, 1, types], false);
		let last = alpha.gather(1, &idx, false).squeeze_dim(1);
		(last + self.end_transitions.to_kind(Kind::Float).unsqueeze(0)).logsumexp([1], false)
	}

	/// `score_segmentation`: each row's gold path score, its span scores plus its transitions.
	pub fn score_segmentation(&self, span_scores: &Tensor, segments: &[Vec<Segment>]) -> Tensor {
		let scores = span_scores.to_kind(Kind::Float);
		let start = self.start_transitions.to_kind(Kind::Float);
		let trans = self.transitions.to_kind(Kind::Float);
		let end = self.end_transitions.to_kind(Kind::Float);
		let totals: Vec<Tensor> = segments
			.iter()
			.enumerate()
			.map(|(b, segmentation)| {
				let mut total = Tensor::zeros([], (Kind::Float, scores.device()));
				let mut prev: Option<usize> = None;
				for &(i, length, t) in segmentation {
					total = total
						+ scores
							.select(0, b as i64)
							.select(0, i as i64)
							.select(0, length as i64 - 1)
							.select(0, t as i64);
					total = total
						+ match prev {
							None => start.select(0, t as i64),
							Some(p) => trans.select(0, p as i64).select(0, t as i64),
						};
					prev = Some(t);
				}
				if let Some(p) = prev {
					total = total + end.select(0, p as i64);
				}
				total
			})
			.collect();
		Tensor::stack(&totals, 0)
	}

	/// `nll`: the partition function less the gold path's score, per row.
	pub fn nll(&self, span_scores: &Tensor, segments: &[Vec<Segment>], lengths: &Tensor) -> Tensor {
		self.log_partition(span_scores, lengths) - self.score_segmentation(span_scores, segments)
	}
}
