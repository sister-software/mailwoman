//! The model half of a checkpoint directory: `model.safetensors` beside `config.json`.
//!
//! A Rust checkpoint stores the state dict in safetensors under the Python state-dict names. A directory the
//! Python trainer wrote holds `pytorch_model.bin` instead; [`read_model_tensors`] reads either, and
//! [`convert_pytorch_checkpoint`] writes the safetensors copy once, so later reads need no pickle reader.

use crate::config::EncoderSpec;
use crate::store::Store;
use crate::{fail, Result};
use std::path::Path;
use tch::{Kind, Tensor};

pub const MODEL_FILE: &str = "model.safetensors";
pub const PYTORCH_MODEL_FILE: &str = "pytorch_model.bin";
pub const CONFIG_FILE: &str = "config.json";

/// Every float tensor of a `pytorch_model.bin`, widened to float32 as `load_state_dict` copies it, in file order.
pub fn read_pytorch_model(path: &Path) -> Result<Vec<(String, Tensor)>> {
	let dict = trainer_export::checkpoint::read_state_dict(path)?;
	dict.order
		.iter()
		.map(|name| {
			let tensor = &dict.tensors[name];
			let data = tensor.data.as_deref().ok_or_else(|| {
				fail!(
					"{}: tensor {name} is {}, not floating point",
					path.display(),
					tensor.storage
				)
			})?;
			let shape: Vec<i64> = tensor.shape.iter().map(|&d| d as i64).collect();
			Ok((name.clone(), Tensor::from_slice(data).view(shape.as_slice())))
		})
		.collect()
}

/// The state dict of a checkpoint directory: `model.safetensors`, or `pytorch_model.bin` when that is all it holds.
pub fn read_model_tensors(dir: &Path) -> Result<Vec<(String, Tensor)>> {
	let safetensors = dir.join(MODEL_FILE);
	if safetensors.is_file() {
		return Ok(Tensor::read_safetensors(&safetensors)?);
	}
	let bin = dir.join(PYTORCH_MODEL_FILE);
	if bin.is_file() {
		return read_pytorch_model(&bin);
	}
	Err(fail!(
		"{} holds neither {MODEL_FILE} nor {PYTORCH_MODEL_FILE}",
		dir.display()
	))
}

/// Writes `store`'s state dict as `model.safetensors` and `spec` as `config.json` into `dir`.
pub fn write_model(dir: &Path, store: &Store, spec: &EncoderSpec) -> Result<()> {
	std::fs::create_dir_all(dir)?;
	let tensors: Vec<(String, Tensor)> = store
		.state_dict()
		.into_iter()
		.map(|(n, t)| (n, t.detach().to_device(tch::Device::Cpu).contiguous()))
		.collect();
	Tensor::write_safetensors(&tensors, dir.join(MODEL_FILE))?;
	let mut config = serde_json::to_string_pretty(&spec.to_config_json())?;
	config.push('\n');
	std::fs::write(dir.join(CONFIG_FILE), config)?;
	Ok(())
}

/// Writes `model.safetensors` beside a Python checkpoint's `pytorch_model.bin`, into `out` (the same directory or
/// another), copying `config.json`. Every tensor keeps its values: a bfloat16 storage widens to float32 exactly.
pub fn convert_pytorch_checkpoint(dir: &Path, out: &Path) -> Result<usize> {
	let tensors = read_pytorch_model(&dir.join(PYTORCH_MODEL_FILE))?;
	std::fs::create_dir_all(out)?;
	Tensor::write_safetensors(&tensors, out.join(MODEL_FILE))?;
	if dir != out {
		std::fs::copy(dir.join(CONFIG_FILE), out.join(CONFIG_FILE))?;
	}
	Ok(tensors.len())
}

/// Whether two tensor lists hold the same names, shapes, dtypes and bytes.
pub fn same_bytes(a: &[(String, Tensor)], b: &[(String, Tensor)]) -> Result<()> {
	if a.len() != b.len() {
		return Err(fail!("{} tensors against {}", a.len(), b.len()));
	}
	for (name, x) in a {
		let (_, y) = b
			.iter()
			.find(|(n, _)| n == name)
			.ok_or_else(|| fail!("{name} is in one list only"))?;
		if x.size() != y.size() || x.kind() != y.kind() {
			return Err(fail!(
				"{name}: {:?} {:?} against {:?} {:?}",
				x.size(),
				x.kind(),
				y.size(),
				y.kind()
			));
		}
		let xs = x.to_kind(Kind::Float).contiguous();
		let ys = y.to_kind(Kind::Float).contiguous();
		let xv: Vec<f32> = Vec::try_from(xs.view([-1]))?;
		let yv: Vec<f32> = Vec::try_from(ys.view([-1]))?;
		if let Some(i) = xv.iter().zip(&yv).position(|(p, q)| p.to_bits() != q.to_bits()) {
			return Err(fail!("{name}: element {i} is {} against {}", xv[i], yv[i]));
		}
	}
	Ok(())
}
