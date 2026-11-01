//! `data/masking.py`'s `mask_tokens`: BERT's 80/10/10 masking, drawn from the MLM loop's own generator.

use crate::Result;
use tch::{Device, Kind, Tensor};
use trainer_model::autocast::Generator;
use trainer_model::encoder::IGNORE_INDEX;

/// `(masked_input_ids, mlm_labels)` for a `(batch, seq)` CPU batch.
pub fn mask_tokens(
	input_ids: &Tensor,
	attention_mask: &Tensor,
	mask_prob: f64,
	mask_token_id: i64,
	vocab_size: i64,
	generator: &mut Generator,
) -> Result<(Tensor, Tensor)> {
	let shape = input_ids.size();
	let attended = attention_mask.to_kind(Kind::Bool);
	let probs = Tensor::full(shape.as_slice(), mask_prob, (Kind::Float, Device::Cpu)) * attended.to_kind(Kind::Float);
	let selected = generator.bernoulli(&probs)?.to_kind(Kind::Bool);
	let labels = input_ids.copy().masked_fill(&selected.logical_not(), IGNORE_INDEX);
	let to_mask = generator
		.bernoulli(&Tensor::full(shape.as_slice(), 0.8, (Kind::Float, Device::Cpu)))?
		.to_kind(Kind::Bool)
		.logical_and(&selected);
	let masked = input_ids.copy().masked_fill(&to_mask, mask_token_id);
	let to_random = generator
		.bernoulli(&Tensor::full(shape.as_slice(), 0.5, (Kind::Float, Device::Cpu)))?
		.to_kind(Kind::Bool)
		.logical_and(&selected)
		.logical_and(&to_mask.logical_not());
	let random_ids = generator.randint(0, vocab_size, &shape)?;
	let masked = random_ids.where_self(&to_random, &masked);
	Ok((masked, labels))
}
