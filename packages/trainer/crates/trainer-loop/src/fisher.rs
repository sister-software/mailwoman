//! `optim/fisher.py`: Fisher capture and the EWC penalty.
//!
//! The capture keeps the running sum of each trainable parameter's squared gradient over the window and writes the
//! mean as `fisher-diag-v1.npz` (one `<name>.npy` float32 array per parameter, deflated, as
//! `numpy.savez_compressed` writes it) beside `fisher-diag-v1.json`. The penalty reads both kinds of file back.

use crate::{fail, Result};
use serde_json::{Map, Value};
use std::io::{Read, Write};
use std::path::Path;
use tch::{Kind, Tensor};

pub const FISHER_ARTIFACT: &str = "fisher-diag-v1.npz";
pub const FISHER_SIDECAR: &str = "fisher-diag-v1.json";

/// One array as an `.npy` v1.0 file: little-endian float32 in C order.
pub fn npy_bytes(shape: &[i64], data: &[f32]) -> Vec<u8> {
	let dims = match shape.len() {
		0 => "()".to_owned(),
		1 => format!("({},)", shape[0]),
		_ => format!("({})", shape.iter().map(i64::to_string).collect::<Vec<_>>().join(", ")),
	};
	let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': {dims}, }}");
	let total = 10 + header.len() + 1;
	header.push_str(&" ".repeat((64 - total % 64) % 64));
	header.push('\n');
	let mut out = Vec::with_capacity(10 + header.len() + data.len() * 4);
	out.extend_from_slice(b"\x93NUMPY\x01\x00");
	out.extend_from_slice(&(header.len() as u16).to_le_bytes());
	out.extend_from_slice(header.as_bytes());
	for v in data {
		out.extend_from_slice(&v.to_le_bytes());
	}
	out
}

/// Parses a float32 `.npy` (v1 or v2, little-endian, C order).
pub fn parse_npy(bytes: &[u8]) -> Result<(Vec<i64>, Vec<f32>)> {
	if bytes.len() < 10 || &bytes[..6] != b"\x93NUMPY" {
		return Err(fail!("not an .npy array"));
	}
	let (len, start) = match bytes[6] {
		1 => (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10),
		2 | 3 => (
			u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
			12,
		),
		v => return Err(fail!(".npy version {v} is not read")),
	};
	let header = std::str::from_utf8(&bytes[start..start + len]).map_err(|_| fail!(".npy header is not UTF-8"))?;
	if !header.contains("'<f4'") || header.contains("'fortran_order': True") {
		return Err(fail!(".npy array is not C-order little-endian float32: {header}"));
	}
	let shape_text = header
		.split("'shape': (")
		.nth(1)
		.and_then(|s| s.split(')').next())
		.ok_or_else(|| fail!(".npy header has no shape: {header}"))?;
	let shape: Vec<i64> = shape_text
		.split(',')
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.map(|s| s.parse().map_err(|_| fail!(".npy shape {shape_text}")))
		.collect::<Result<_>>()?;
	let data = bytes[start + len..]
		.as_chunks::<4>()
		.0
		.iter()
		.map(|c| f32::from_le_bytes(*c))
		.collect();
	Ok((shape, data))
}

/// Reads every array of an `.npz` archive, in archive order.
pub fn read_npz(path: &Path) -> Result<Vec<(String, Tensor)>> {
	let file = std::fs::File::open(path).map_err(|e| fail!("{}: {e}", path.display()))?;
	let mut archive = zip::ZipArchive::new(file)?;
	let mut out = Vec::new();
	for i in 0..archive.len() {
		let mut entry = archive.by_index(i)?;
		let entry_name = entry.name()?.to_string();
		let name = entry_name
			.strip_suffix(".npy")
			.ok_or_else(|| fail!("{}: entry {entry_name} is not an .npy", path.display()))?
			.to_owned();
		let mut bytes = Vec::new();
		entry.read_to_end(&mut bytes)?;
		let (shape, data) = parse_npy(&bytes)?;
		out.push((name, Tensor::from_slice(&data).view(shape.as_slice())));
	}
	Ok(out)
}

/// `FisherAccumulator`.
pub struct FisherAccumulator {
	sums: Vec<(String, Tensor)>,
	pub count: i64,
}

impl FisherAccumulator {
	/// A zero sum per trainable parameter.
	pub fn new(params: &[(String, Tensor)]) -> Self {
		Self {
			sums: params
				.iter()
				.filter(|(_, p)| p.requires_grad())
				.map(|(n, p)| (n.clone(), p.zeros_like().to_kind(Kind::Float)))
				.collect(),
			count: 0,
		}
	}

	/// Adds the square of every tracked parameter's current gradient.
	pub fn accumulate(&mut self, params: &[(String, Tensor)]) {
		tch::no_grad(|| {
			for (name, p) in params {
				let grad = p.grad();
				if !grad.defined() {
					continue;
				}
				if let Some((_, sum)) = self.sums.iter_mut().find(|(n, _)| n == name) {
					let _ = sum.g_add_(&grad.detach().to_kind(Kind::Float).pow_tensor_scalar(2));
				}
			}
		});
		self.count += 1;
	}

	/// Each parameter's mean squared gradient.
	pub fn finalize(&self) -> Result<Vec<(String, Tensor)>> {
		if self.count == 0 {
			return Err(fail!(
				"FisherAccumulator.finalize() with zero accumulated batches — capture window never ran"
			));
		}
		Ok(self
			.sums
			.iter()
			.map(|(n, s)| (n.clone(), (s / self.count as f64).to_device(tch::Device::Cpu)))
			.collect())
	}

	/// Writes the artifact and its provenance sidecar into `dir`.
	pub fn save(&self, dir: &Path, meta: Map<String, Value>) -> Result<std::path::PathBuf> {
		std::fs::create_dir_all(dir)?;
		let arrays = self.finalize()?;
		let path = dir.join(FISHER_ARTIFACT);
		let file = std::fs::File::create(&path)?;
		let mut zip = zip::ZipWriter::new(file);
		let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
		let mut param_count = 0i64;
		for (name, t) in &arrays {
			let shape = t.size();
			let data: Vec<f32> = Vec::try_from(t.contiguous().view([-1]))?;
			param_count += data.len() as i64;
			zip.start_file(format!("{name}.npy"), options)?;
			zip.write_all(&npy_bytes(&shape, &data))?;
		}
		zip.finish()?;
		let mut sidecar = Map::new();
		sidecar.insert("version".into(), "fisher-diag-v1".into());
		sidecar.insert("kind".into(), "diagonal-empirical-fisher".into());
		sidecar.insert("count_batches".into(), self.count.into());
		sidecar.insert("param_count".into(), param_count.into());
		sidecar.extend(meta);
		std::fs::write(
			dir.join(FISHER_SIDECAR),
			serde_json::to_string_pretty(&Value::Object(sidecar))? + "\n",
		)?;
		Ok(path)
	}
}

/// `EWCPenalty`: `λ/2 · Σ F_i (θ_i − θ*_i)²` over the parameters both the artifact and the reference hold.
pub struct EwcPenalty {
	lam: f64,
	terms: Vec<(String, Tensor, Tensor)>,
	pub covered_params: i64,
}

impl EwcPenalty {
	pub fn new(fisher_path: &Path, reference: &Path, lam: f64, device: tch::Device) -> Result<Self> {
		let fisher = read_npz(fisher_path)?;
		let dir = if reference.is_dir() {
			reference.to_path_buf()
		} else {
			reference.parent().map(Path::to_path_buf).unwrap_or_default()
		};
		let reference_tensors = trainer_model::checkpoint::read_model_tensors(&dir)?;
		let mut terms = Vec::new();
		for (name, f) in fisher {
			let Some((_, theta)) = reference_tensors.iter().find(|(n, _)| *n == name) else {
				continue;
			};
			if theta.size() != f.size() {
				continue;
			}
			terms.push((name, f.to_device(device), theta.to_kind(Kind::Float).to_device(device)));
		}
		if terms.is_empty() {
			return Err(fail!(
				"EWC: no overlapping parameters between {} and {}",
				fisher_path.display(),
				reference.display()
			));
		}
		let covered_params = terms.iter().map(|(_, f, _)| f.numel() as i64).sum();
		Ok(Self {
			lam,
			terms,
			covered_params,
		})
	}

	/// The penalty over `params` in their order.
	pub fn penalty(&self, params: &[(String, Tensor)]) -> Result<Tensor> {
		let mut total: Option<Tensor> = None;
		for (name, p) in params {
			let Some((_, f, theta)) = self.terms.iter().find(|(n, _, _)| n == name) else {
				continue;
			};
			let term = (f * (p.to_kind(Kind::Float) - theta).pow_tensor_scalar(2)).sum(None);
			total = Some(match total {
				None => term,
				Some(t) => t + term,
			});
		}
		let total = total.ok_or_else(|| fail!("EWC: model shares no parameter names with the Fisher artifact"))?;
		Ok(total * (self.lam / 2.0))
	}
}
