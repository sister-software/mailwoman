//! `train/noise.py`'s evidence curricula and `loop.py`'s `apply_curricula`, drawing from the global generator in
//! Python's order.

use crate::batch::TensorBatch;
use crate::Result;
use tch::{Kind, Tensor};

const START_FRAC: f64 = 0.25;
const RAMP_FRAC: f64 = 0.50;
const ZERO_OUT_MAX: f64 = 0.15;

/// How far into the curriculum `step` is, or `None` before it starts.
fn ramp(step: i64, max_steps: i64) -> Option<f64> {
	let start = START_FRAC * max_steps as f64;
	if (step as f64) < start {
		return None;
	}
	let span = (RAMP_FRAC - START_FRAC) * max_steps as f64;
	Some(1.0f64.min((step as f64 - start) / span.max(1.0)))
}

/// `perturb_anchor_confidence` (and `perturb_gazetteer_confidence`, the same curriculum).
pub fn perturb_confidence(conf: &Tensor, step: i64, max_steps: i64) -> Tensor {
	let Some(ramp) = ramp(step, max_steps) else {
		return conf.shallow_clone();
	};
	let alpha = conf.rand_like() * 0.4 + 0.8;
	let out = (conf * alpha).clamp(0.0, 1.0);
	let rows = Tensor::rand([conf.size()[0]], (Kind::Float, conf.device()));
	let row_zero = rows.lt(ZERO_OUT_MAX * ramp).unsqueeze(1);
	out.masked_fill(&row_zero, 0.0)
}

/// `perturb_evidence_noise`: a roll of a row's painted evidence, or a one-token false hit on a clean row.
pub fn perturb_evidence_noise(
	features: &Tensor,
	conf: &Tensor,
	step: i64,
	max_steps: i64,
	p_noise: f64,
) -> Result<(Tensor, Tensor)> {
	if p_noise <= 0.0 {
		return Ok((features.shallow_clone(), conf.shallow_clone()));
	}
	let Some(ramp) = ramp(step, max_steps) else {
		return Ok((features.shallow_clone(), conf.shallow_clone()));
	};
	let size = conf.size();
	let (bsz, seq) = (size[0], size[1]);
	let noised = Tensor::rand([bsz], (Kind::Float, conf.device())).lt(p_noise * ramp);
	if noised.any().int64_value(&[]) == 0 {
		return Ok((features.shallow_clone(), conf.shallow_clone()));
	}
	let features = features.copy();
	let conf = conf.copy();
	let rows: Vec<i64> = Vec::try_from(noised.nonzero().flatten(0, -1))?;
	for i in rows {
		if conf.get(i).gt(0).any().int64_value(&[]) != 0 {
			let shift = Tensor::randint_low(1, seq, [1], (Kind::Int64, conf.device())).int64_value(&[0]);
			let f = features.get(i).roll([shift], [0]);
			let c = conf.get(i).roll([shift], [0]);
			features.get(i).copy_(&f);
			conf.get(i).copy_(&c);
		} else {
			let pos = Tensor::randint_low(0, seq, [1], (Kind::Int64, conf.device())).int64_value(&[0]);
			let _ = features.get(i).get(pos).fill_(1.0);
			let _ = conf.get(i).get(pos).fill_(1.0);
		}
	}
	Ok((features, conf))
}

/// The curriculum switches `apply_curricula` reads.
#[derive(Clone, Copy, Debug)]
pub struct Curricula {
	pub gazetteer: bool,
	pub evidence: bool,
	pub evidence_noise_prob: f64,
	pub max_steps: i64,
}

/// `apply_curricula`: the anchor's curriculum always, the gazetteer's and the evidence channels' when configured.
pub fn apply_curricula(c: &Curricula, batch: &mut TensorBatch, step: i64) -> Result<()> {
	if let Some(ch) = batch.channel_mut("anchor") {
		ch.2 = perturb_confidence(&ch.2, step, c.max_steps);
	}
	if c.gazetteer {
		if let Some(ch) = batch.channel_mut("gazetteer") {
			ch.2 = perturb_confidence(&ch.2, step, c.max_steps);
		}
	}
	if c.evidence {
		if c.evidence_noise_prob > 0.0 {
			for prefix in ["street_type", "locality_surface"] {
				if let Some(ch) = batch.channel_mut(prefix) {
					let (f, conf) = perturb_evidence_noise(&ch.1, &ch.2, step, c.max_steps, c.evidence_noise_prob)?;
					ch.1 = f;
					ch.2 = conf;
				}
			}
		}
		for prefix in ["street_type", "locality_surface"] {
			if let Some(ch) = batch.channel_mut(prefix) {
				ch.2 = perturb_confidence(&ch.2, step, c.max_steps);
			}
		}
	}
	Ok(())
}
