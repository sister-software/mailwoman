//! `optim/schedules.py`'s three schedules under `torch.optim.lr_scheduler.LambdaLR`'s stepping, and the resume
//! restamp.
//!
//! `LambdaLR` steps once on construction, so `last_epoch` starts at 0 and every group's rate is its base rate times
//! the multiplier at 0. Each `step()` advances `last_epoch` and sets every group's rate to `base * lambda(epoch)`.

use crate::optim::AdamW;
use crate::{fail, Result};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use std::path::Path;

/// A schedule's multiplier as a function of the step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
	Cosine { warmup_steps: i64, max_steps: i64 },
	Constant { warmup_steps: i64 },
	LinearCooldown { cooldown_start: i64, max_steps: i64 },
}

impl Schedule {
	/// `build_scheduler`'s choice for `train.lr_schedule`.
	pub fn from_config(name: &str, warmup_steps: i64, max_steps: i64, cooldown_start: Option<i64>) -> Result<Self> {
		match name {
			"cosine" => Ok(Self::Cosine {
				warmup_steps,
				max_steps,
			}),
			"constant" => Ok(Self::Constant { warmup_steps }),
			"linear_cooldown" => Ok(Self::LinearCooldown {
				cooldown_start: cooldown_start
					.ok_or_else(|| fail!("train.lr_schedule='linear_cooldown' requires train.cooldown_start_step"))?,
				max_steps,
			}),
			other => Err(fail!(
				"unknown train.lr_schedule={other:?}; expected 'cosine', 'constant', or 'linear_cooldown'"
			)),
		}
	}

	pub fn multiplier(&self, step: i64) -> f64 {
		match *self {
			Self::Cosine {
				warmup_steps,
				max_steps,
			} => {
				if step < warmup_steps {
					return step as f64 / warmup_steps.max(1) as f64;
				}
				let progress = (step - warmup_steps) as f64 / (max_steps - warmup_steps).max(1) as f64;
				let progress = progress.min(1.0);
				(0.5 * (1.0 + (PI * progress).cos())).max(0.0)
			}
			Self::Constant { warmup_steps } => {
				if step < warmup_steps {
					step as f64 / warmup_steps.max(1) as f64
				} else {
					1.0
				}
			}
			Self::LinearCooldown {
				cooldown_start,
				max_steps,
			} => {
				let span = (max_steps - cooldown_start).max(1);
				if step <= cooldown_start {
					1.0
				} else {
					((max_steps - step) as f64 / span as f64).max(0.0)
				}
			}
		}
	}
}

/// `LambdaLR` over an optimizer's groups.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LambdaLr {
	pub schedule: Schedule,
	pub base_lrs: Vec<f64>,
	pub last_epoch: i64,
	pub last_lr: Vec<f64>,
}

impl LambdaLr {
	/// Constructs the scheduler and takes its initial step, setting every group's rate for step 0.
	pub fn new(optim: &mut AdamW, schedule: Schedule) -> Self {
		let base_lrs: Vec<f64> = optim.groups.iter().map(|g| g.initial_lr).collect();
		let mut out = Self {
			schedule,
			base_lrs,
			last_epoch: -1,
			last_lr: Vec::new(),
		};
		out.step(optim);
		out
	}

	pub fn step(&mut self, optim: &mut AdamW) {
		self.last_epoch += 1;
		let mult = self.schedule.multiplier(self.last_epoch);
		self.last_lr = self.base_lrs.iter().map(|b| b * mult).collect();
		for (group, &lr) in optim.groups.iter_mut().zip(&self.last_lr) {
			group.lr = lr;
		}
	}

	pub fn get_last_lr(&self) -> &[f64] {
		&self.last_lr
	}

	pub fn save(&self, dir: &Path) -> Result<()> {
		std::fs::write(dir.join("scheduler.json"), serde_json::to_string_pretty(self)? + "\n")?;
		Ok(())
	}

	/// `scheduler.load_state_dict`.
	pub fn load(&mut self, dir: &Path) -> Result<()> {
		let saved: LambdaLr = serde_json::from_str(&std::fs::read_to_string(dir.join("scheduler.json"))?)?;
		*self = saved;
		Ok(())
	}
}

/// `restamp_resume_lrs`: the config's peak rates in the base fields, and the current rate from the multiplier at
/// the resumed step. Returns one line per group whose checkpoint rate differs.
pub fn restamp_resume_lrs(optim: &mut AdamW, scheduler: &mut LambdaLr, live_lrs: &[f64]) -> Result<Vec<String>> {
	if live_lrs.len() != optim.groups.len() {
		return Err(fail!("{} live rates for {} groups", live_lrs.len(), optim.groups.len()));
	}
	let mult = scheduler.schedule.multiplier(scheduler.last_epoch);
	let mut lines = Vec::new();
	for (i, (group, &live)) in optim.groups.iter_mut().zip(live_lrs).enumerate() {
		let current = live * mult;
		if group.lr != current {
			lines.push(format!(
				"[resume-lr] group {i} ({}): checkpoint {} -> config {}",
				group.label, group.lr, current
			));
		}
		group.lr = current;
		group.initial_lr = live;
	}
	scheduler.base_lrs = live_lrs.to_vec();
	Ok(lines)
}
