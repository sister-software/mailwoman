//! Tensor comparison for the staged comparison: the largest absolute and relative difference, and the first
//! element that breaks a tolerance.

use crate::{fail, Result};
use serde::Serialize;
use std::path::Path;
use tch::{Kind, Tensor};

/// How one tensor compared.
#[derive(Clone, Debug, Serialize)]
pub struct Diff {
	pub name: String,
	pub elements: usize,
	pub max_abs: f64,
	/// `max |a - b| / max(|b|, floor)` over the elements, with `b` the reference.
	pub max_rel: f64,
	pub bitwise_equal: bool,
	/// The first element whose difference breaks the tolerance, with both values.
	pub first_failure: Option<(usize, f64, f64)>,
	pub pass: bool,
}

/// What a tolerance bounds.
#[derive(Clone, Copy, Debug, Serialize)]
pub enum Tolerance {
	/// Every element bit-identical.
	Exact,
	/// `|a - b| <= rel * max(|b|, floor * max|reference|)`: relative per element, with values below `floor` of the
	/// tensor's largest magnitude compared at that magnitude, so a near-zero element is not held to a ratio of
	/// rounding noise.
	Relative { rel: f64, floor: f64 },
	/// `|a - b| <= abs`.
	Absolute { abs: f64 },
}

fn values(t: &Tensor) -> Result<Vec<f64>> {
	let flat = t
		.detach()
		.to_device(tch::Device::Cpu)
		.to_kind(Kind::Double)
		.contiguous()
		.view([-1]);
	Ok(Vec::<f64>::try_from(flat)?)
}

/// Compares `actual` against `reference`; a shape or dtype mismatch is an error rather than a diff.
pub fn diff(name: &str, actual: &Tensor, reference: &Tensor, tolerance: Tolerance) -> Result<Diff> {
	if actual.size() != reference.size() {
		return Err(fail!(
			"{name}: shape {:?} against reference {:?}",
			actual.size(),
			reference.size()
		));
	}
	let bitwise_equal = actual.kind() == reference.kind() && {
		let a = actual.detach().to_device(tch::Device::Cpu).contiguous();
		let b = reference.detach().to_device(tch::Device::Cpu).contiguous();
		a.equal(&b) && {
			// `equal` treats -0.0 and 0.0 as equal and NaN as unequal; compare bytes for floats.
			let ab = a.view_dtype(byte_kind(a.kind()));
			let bb = b.view_dtype(byte_kind(b.kind()));
			ab.equal(&bb)
		}
	};
	let a = values(actual)?;
	let b = values(reference)?;
	let (mut max_abs, mut max_rel, mut first_failure) = (0.0f64, 0.0f64, None);
	let ref_max = b.iter().filter(|v| v.is_finite()).fold(0.0f64, |m, v| m.max(v.abs()));
	let floor = match tolerance {
		Tolerance::Relative { floor, .. } => (floor * ref_max).max(f64::MIN_POSITIVE),
		_ => f64::MIN_POSITIVE,
	};
	for (i, (&x, &y)) in a.iter().zip(&b).enumerate() {
		let same = x == y || (x.is_nan() && y.is_nan());
		let d = if same { 0.0 } else { (x - y).abs() };
		let r = if same { 0.0 } else { d / y.abs().max(floor) };
		max_abs = max_abs.max(if d.is_nan() { f64::INFINITY } else { d });
		max_rel = max_rel.max(if r.is_nan() { f64::INFINITY } else { r });
		let ok = match tolerance {
			Tolerance::Exact => x.to_bits() == y.to_bits() || same,
			Tolerance::Relative { rel, .. } => same || r <= rel,
			Tolerance::Absolute { abs } => same || d <= abs,
		};
		if !ok && first_failure.is_none() {
			first_failure = Some((i, x, y));
		}
	}
	let pass = match tolerance {
		Tolerance::Exact => bitwise_equal,
		_ => first_failure.is_none(),
	};
	Ok(Diff {
		name: name.to_owned(),
		elements: a.len(),
		max_abs,
		max_rel,
		bitwise_equal,
		first_failure,
		pass,
	})
}

fn byte_kind(kind: Kind) -> Kind {
	match kind {
		Kind::Float | Kind::Int => Kind::Int,
		Kind::Double | Kind::Int64 => Kind::Int64,
		Kind::BFloat16 | Kind::Half | Kind::Int16 => Kind::Int16,
		other => other,
	}
}

/// A safetensors file's tensors by name.
pub struct Record(pub Vec<(String, Tensor)>);

impl Record {
	pub fn read(path: &Path) -> Result<Self> {
		Ok(Self(
			Tensor::read_safetensors(path).map_err(|e| fail!("{}: {e}", path.display()))?,
		))
	}

	pub fn get(&self, name: &str) -> Result<&Tensor> {
		self.0
			.iter()
			.find(|(n, _)| n == name)
			.map(|(_, t)| t)
			.ok_or_else(|| fail!("the record has no tensor {name}"))
	}

	pub fn has(&self, name: &str) -> bool {
		self.0.iter().any(|(n, _)| n == name)
	}

	/// The tensors whose names start with `prefix`, with the prefix removed.
	pub fn prefixed(&self, prefix: &str) -> Vec<(String, Tensor)> {
		self.0
			.iter()
			.filter_map(|(n, t)| n.strip_prefix(prefix).map(|rest| (rest.to_owned(), t.shallow_clone())))
			.collect()
	}
}

/// A stage's result: every diff and whether all passed.
#[derive(Clone, Debug, Default, Serialize)]
pub struct StageResult {
	pub stage: String,
	pub tolerance: String,
	pub diffs: Vec<Diff>,
	pub notes: Vec<String>,
}

impl StageResult {
	pub fn new(stage: &str, tolerance: &str) -> Self {
		Self {
			stage: stage.to_owned(),
			tolerance: tolerance.to_owned(),
			..Self::default()
		}
	}

	pub fn pass(&self) -> bool {
		self.diffs.iter().all(|d| d.pass)
	}

	pub fn max_abs(&self) -> f64 {
		self.diffs.iter().map(|d| d.max_abs).fold(0.0, f64::max)
	}

	pub fn max_rel(&self) -> f64 {
		self.diffs.iter().map(|d| d.max_rel).fold(0.0, f64::max)
	}

	pub fn push(&mut self, diff: Diff) {
		self.diffs.push(diff);
	}

	/// One line: the stage, pass or fail, the largest differences, and the worst tensor.
	pub fn summary(&self) -> String {
		let worst = self
			.diffs
			.iter()
			.max_by(|a, b| a.max_rel.total_cmp(&b.max_rel))
			.map(|d| d.name.as_str())
			.unwrap_or("-");
		let failing: Vec<&str> = self.diffs.iter().filter(|d| !d.pass).map(|d| d.name.as_str()).collect();
		format!(
			"{:<28} {:<4} tensors={:<4} max_abs={:.3e} max_rel={:.3e} worst={} tolerance={}{}",
			self.stage,
			if self.pass() { "pass" } else { "FAIL" },
			self.diffs.len(),
			self.max_abs(),
			self.max_rel(),
			worst,
			self.tolerance,
			if failing.is_empty() {
				String::new()
			} else {
				format!(" failing={failing:?}")
			}
		)
	}
}

/// What `compare_checkpoints` leaves uncompared.
pub const CHECKPOINT_SCOPE: &str =
	"compares model weights and the Fisher artifact; optimizer, scheduler and training_state.json are not compared";

/// Compares two named tensor sets over the union of their names. A name only one side holds is a note, and a note
/// fails the comparison, in either direction.
pub fn compare_named(
	stage: &str,
	tolerance_label: &str,
	tolerance: Tolerance,
	(a_label, a): (&str, &[(String, Tensor)]),
	(b_label, b): (&str, &[(String, Tensor)]),
) -> Result<StageResult> {
	let mut result = StageResult::new(stage, tolerance_label);
	for (name, t) in a {
		match b.iter().find(|(n, _)| n == name) {
			Some((_, o)) => result.push(diff(name, t, o, tolerance)?),
			None => result.notes.push(format!("{name} is in the {a_label} only")),
		}
	}
	for (name, _) in b {
		if !a.iter().any(|(n, _)| n == name) {
			result.notes.push(format!("{name} is in the {b_label} only"));
		}
	}
	Ok(result)
}

/// Compares two checkpoint directories' model weights exactly and their Fisher artifacts at 1e-5 relative. A Fisher
/// artifact in one directory only is a failing note.
pub fn compare_checkpoints(a: &Path, b: &Path) -> Result<Vec<StageResult>> {
	let ta = trainer_model::checkpoint::read_model_tensors(a).map_err(|e| fail!("{}: {e}", a.display()))?;
	let tb = trainer_model::checkpoint::read_model_tensors(b).map_err(|e| fail!("{}: {e}", b.display()))?;
	let mut results = vec![compare_named(
		"model weights",
		"exact",
		Tolerance::Exact,
		("first checkpoint", &ta),
		("second checkpoint", &tb),
	)?];
	let fa = a.join(crate::fisher::FISHER_ARTIFACT);
	let fb = b.join(crate::fisher::FISHER_ARTIFACT);
	match (fa.is_file(), fb.is_file()) {
		(true, true) => results.push(compare_named(
			"Fisher artifact",
			"1e-5 rel",
			Tolerance::Relative { rel: 1e-5, floor: 1e-3 },
			("first artifact", &crate::fisher::read_npz(&fa)?),
			("second artifact", &crate::fisher::read_npz(&fb)?),
		)?),
		(false, false) => {}
		(a_has, _) => {
			let (present, absent) = if a_has { (&fa, b) } else { (&fb, a) };
			let mut fisher = StageResult::new("Fisher artifact", "1e-5 rel");
			fisher.notes.push(format!(
				"{} exists and {} holds no {}",
				present.display(),
				absent.display(),
				crate::fisher::FISHER_ARTIFACT
			));
			results.push(fisher);
		}
	}
	Ok(results)
}
