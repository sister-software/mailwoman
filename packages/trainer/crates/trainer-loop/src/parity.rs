//! The staged comparison of plan §3.3 against the records the Python trainer's `audits.trainer_parity` wrote.

pub mod f1;
pub mod stages;

use crate::compare::StageResult;
use crate::Result;
use serde::Serialize;
use trainer_model::runtime::Runtime;

/// The report a parity run writes: the runtime it ran on, then one result per compared stage. The runtime block
/// pairs with the Python record's `runtime`, so a record states both sides' library versions and thread counts.
#[derive(Debug, Serialize)]
pub struct Report<'a> {
	pub runtime: Runtime,
	pub stages: &'a [StageResult],
}

impl<'a> Report<'a> {
	/// Reads the runtime from the loaded libtorch when the report is written, after any `--threads` setting.
	pub fn new(stages: &'a [StageResult]) -> Result<Self> {
		Ok(Self {
			runtime: trainer_model::runtime::read()?,
			stages,
		})
	}
}
