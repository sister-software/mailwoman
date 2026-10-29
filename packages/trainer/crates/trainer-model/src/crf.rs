//! `nn/crf.py`'s `LinearChainCRF`: the BIO-masked linear-chain CRF and its negative log-likelihood.

use crate::init;
use crate::store::Store;
use crate::{fail, Result};
use tch::{Kind, Tensor};

/// Whether `prev → curr` is a valid BIO transition: anything into `O` or a `B-`, and `I-x` only after `B-x` or `I-x`.
fn valid_transition(prev: &str, curr: &str) -> bool {
	if curr == "O" {
		return true;
	}
	let Some((curr_prefix, curr_tag)) = curr.split_once('-') else {
		return false;
	};
	if curr_prefix == "B" {
		return true;
	}
	if curr_prefix != "I" || prev == "O" {
		return false;
	}
	match prev.split_once('-') {
		Some((p, tag)) if p == "B" || p == "I" => tag == curr_tag,
		_ => false,
	}
}

/// How the per-sequence NLL is reduced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reduction {
	Mean,
	Sum,
	PerToken,
}

pub struct LinearChainCrf {
	pub transitions: Tensor,
	pub start_transitions: Tensor,
	pub end_transitions: Tensor,
	pub transition_mask: Tensor,
	pub start_mask: Tensor,
}

impl LinearChainCrf {
	pub fn new(store: &mut Store, prefix: &str, labels: &[String]) -> Self {
		let n = labels.len() as i64;
		let empty = |shape: &[i64]| Tensor::empty(shape, (Kind::Float, tch::Device::Cpu));
		let transitions = store.param(&format!("{prefix}.transitions"), empty(&[n, n]));
		let start_transitions = store.param(&format!("{prefix}.start_transitions"), empty(&[n]));
		let end_transitions = store.param(&format!("{prefix}.end_transitions"), empty(&[n]));
		init::uniform_(&transitions, -0.1, 0.1);
		init::uniform_(&start_transitions, -0.1, 0.1);
		init::uniform_(&end_transitions, -0.1, 0.1);
		let mut mask = vec![0f32; (n * n) as usize];
		for (p, prev) in labels.iter().enumerate() {
			for (c, curr) in labels.iter().enumerate() {
				if !valid_transition(prev, curr) {
					mask[p * n as usize + c] = f32::NEG_INFINITY;
				}
			}
		}
		let start: Vec<f32> = labels
			.iter()
			.map(|l| {
				if l != "O" && l.starts_with("I-") {
					f32::NEG_INFINITY
				} else {
					0.0
				}
			})
			.collect();
		let transition_mask = store.buffer(
			&format!("{prefix}.transition_mask"),
			Tensor::from_slice(&mask).view([n, n]),
			true,
		);
		let start_mask = store.buffer(&format!("{prefix}.start_mask"), Tensor::from_slice(&start), true);
		Self {
			transitions,
			start_transitions,
			end_transitions,
			transition_mask,
			start_mask,
		}
	}

	pub fn masked_transitions(&self) -> Tensor {
		&self.transitions + &self.transition_mask
	}

	pub fn masked_start_transitions(&self) -> Tensor {
		&self.start_transitions + &self.start_mask
	}

	/// The NLL of `tags` under `emissions` `(B, S, N)`, reduced. `mask` is `(B, S)` in the emissions' dtype.
	pub fn nll(&self, emissions: &Tensor, tags: &Tensor, mask: &Tensor, reduction: Reduction) -> Result<Tensor> {
		if emissions.dim() != 3 {
			return Err(fail!("emissions must be (B, S, N), got {:?}", emissions.size()));
		}
		let safe = tags.clamp_min(0);
		let numerator = self.score_sequence(emissions, &safe, mask);
		let denominator = self.log_partition(emissions, mask);
		let nll = denominator - numerator;
		Ok(match reduction {
			Reduction::Mean => nll.mean(None),
			Reduction::Sum => nll.sum(None),
			Reduction::PerToken => nll.sum(None) / mask.sum(None).clamp_min(1),
		})
	}

	fn score_sequence(&self, emissions: &Tensor, tags: &Tensor, mask: &Tensor) -> Tensor {
		let seq_len = emissions.size()[1];
		let first = tags.select(1, 0);
		let mut score = self.masked_start_transitions().index(&[Some(&first)])
			+ emissions
				.select(1, 0)
				.gather(1, &first.unsqueeze(1), false)
				.squeeze_dim(1);
		let masked = self.masked_transitions();
		for t in 1..seq_len {
			let prev = tags.select(1, t - 1);
			let curr = tags.select(1, t);
			let trans = masked.index(&[Some(&prev), Some(&curr)]);
			let emit = emissions
				.select(1, t)
				.gather(1, &curr.unsqueeze(1), false)
				.squeeze_dim(1);
			let step = trans + emit;
			score = score + step * mask.select(1, t);
		}
		let last = Self::last_valid_tag(tags, mask);
		score + self.end_transitions.index(&[Some(&last)])
	}

	fn log_partition(&self, emissions: &Tensor, mask: &Tensor) -> Tensor {
		let seq_len = emissions.size()[1];
		let mut alpha = self.masked_start_transitions().unsqueeze(0) + emissions.select(1, 0);
		let masked = self.masked_transitions();
		for t in 1..seq_len {
			let broadcast = alpha.unsqueeze(2) + masked.unsqueeze(0) + emissions.select(1, t).unsqueeze(1);
			let new_alpha = broadcast.logsumexp([1], false);
			let keep = mask.select(1, t).unsqueeze(1).to_kind(Kind::Bool);
			alpha = new_alpha.where_self(&keep, &alpha);
		}
		let alpha = alpha + self.end_transitions.unsqueeze(0);
		alpha.logsumexp([1], false)
	}

	fn last_valid_tag(tags: &Tensor, mask: &Tensor) -> Tensor {
		let seq_len = tags.size()[1];
		let lengths = (mask.sum_dim_intlist(&[1i64][..], false, None).to_kind(Kind::Int64) - 1).clamp(0, seq_len - 1);
		tags.gather(1, &lengths.unsqueeze(1), false).squeeze_dim(1)
	}
}
