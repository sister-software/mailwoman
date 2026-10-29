//! Reads the tensors of a `pytorch_model.bin` that `torch.save(model.state_dict(), path)` wrote.
//!
//! The file is a zip archive (torch's default format since 1.6). `<prefix>/data.pkl` pickles the state dict, each
//! tensor as `torch._utils._rebuild_tensor_v2(storage, offset, size, stride, requires_grad, hooks)`, where `storage`
//! is the persistent id `("storage", torch.<Type>Storage, key, location, numel)`. `<prefix>/data/<key>` holds that
//! storage's elements and `<prefix>/byteorder` their byte order. The reader resolves the tensors itself rather than
//! converting the file to safetensors first, so an export reads the same file the Python exporter reads.
//!
//! `float32`, `bfloat16` and `float16` storages are decoded and widened to `float32`, which is exact; a trainer that
//! saves in `bfloat16` (the arm B checkpoints do) loads into the float32 model through the same widening. A tensor of
//! another type is listed with its storage type, and taking it as `float32` is an error.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use crate::pickle::{self, Value};
use crate::{fail, Result};

/// One tensor of a state dict.
#[derive(Clone, Debug)]
pub struct Tensor {
	/// The storage class name, such as `FloatStorage`.
	pub storage: String,
	pub shape: Vec<usize>,
	/// The elements in row-major order widened to float32, present for a floating-point storage.
	pub data: Option<Vec<f32>>,
}

impl Tensor {
	pub fn numel(&self) -> usize {
		self.shape.iter().product()
	}
}

/// A state dict: parameter and buffer names to tensors, in the file's order.
#[derive(Debug, Default)]
pub struct StateDict {
	pub order: Vec<String>,
	pub tensors: BTreeMap<String, Tensor>,
}

impl StateDict {
	/// The named `float32` tensor, checked against the expected shape.
	pub fn f32(&self, name: &str, shape: &[usize]) -> Result<&[f32]> {
		let tensor = self
			.tensors
			.get(name)
			.ok_or_else(|| fail!("checkpoint has no tensor {name}"))?;
		if tensor.shape != shape {
			return Err(fail!(
				"checkpoint tensor {name} has shape {:?}, expected {shape:?}",
				tensor.shape
			));
		}
		tensor.data.as_deref().ok_or_else(|| {
			fail!(
				"checkpoint tensor {name} is {}, not a floating-point storage",
				tensor.storage
			)
		})
	}

	/// The named tensor's shape.
	pub fn shape(&self, name: &str) -> Result<&[usize]> {
		Ok(&self
			.tensors
			.get(name)
			.ok_or_else(|| fail!("checkpoint has no tensor {name}"))?
			.shape)
	}

	pub fn contains(&self, name: &str) -> bool {
		self.tensors.contains_key(name)
	}
}

fn usize_tuple(value: &Value, what: &str) -> Result<Vec<usize>> {
	let items = value.as_tuple().ok_or_else(|| fail!("{what} is not a tuple"))?;
	items
		.iter()
		.map(|item| {
			item.as_int()
				.and_then(|i| usize::try_from(i).ok())
				.ok_or_else(|| fail!("{what} holds {item:?}, not a non-negative integer"))
		})
		.collect()
}

/// The storage a `_rebuild_tensor_v2` call names: its key, class and element count.
fn storage_ref(value: &Value) -> Result<(String, String, usize)> {
	let Value::Persistent(pid) = value else {
		return Err(fail!("tensor storage is {value:?}, not a persistent id"));
	};
	let fields = pid
		.as_tuple()
		.ok_or_else(|| fail!("storage persistent id is not a tuple"))?;
	match fields {
		[Value::Str(tag), Value::Global { name: class, .. }, Value::Str(key), _location, numel] if tag == "storage" => {
			let numel = numel.as_int().and_then(|n| usize::try_from(n).ok());
			Ok((
				key.clone(),
				class.clone(),
				numel.ok_or_else(|| fail!("storage {key} has no element count"))?,
			))
		}
		_ => Err(fail!(
			"storage persistent id {fields:?} is not (\"storage\", class, key, location, numel)"
		)),
	}
}

/// Copies a strided view of `storage` into row-major order.
fn gather_strided(storage: &[f32], offset: usize, shape: &[usize], stride: &[usize]) -> Result<Vec<f32>> {
	let numel: usize = shape.iter().product();
	let mut out = Vec::with_capacity(numel);
	if numel == 0 {
		return Ok(out);
	}
	let last: usize = offset + shape.iter().zip(stride).map(|(n, s)| (n - 1) * s).sum::<usize>();
	if last >= storage.len() {
		return Err(fail!(
			"tensor view reaches element {last} of a {}-element storage",
			storage.len()
		));
	}
	let mut index = vec![0usize; shape.len()];
	for _ in 0..numel {
		let at = offset + index.iter().zip(stride).map(|(i, s)| i * s).sum::<usize>();
		out.push(storage[at]);
		for dim in (0..shape.len()).rev() {
			index[dim] += 1;
			if index[dim] < shape[dim] {
				break;
			}
			index[dim] = 0;
		}
	}
	Ok(out)
}

/// The element width of a floating-point storage class this reader widens to float32.
fn float_width(class: &str) -> Option<usize> {
	match class {
		"FloatStorage" => Some(4),
		"BFloat16Storage" | "HalfStorage" => Some(2),
		_ => None,
	}
}

/// IEEE binary16 to float32, exactly.
fn half_to_f32(bits: u16) -> f32 {
	let sign = u32::from(bits >> 15) << 31;
	let exponent = u32::from((bits >> 10) & 0x1f);
	let mantissa = u32::from(bits & 0x3ff);
	let out = match (exponent, mantissa) {
		(0, 0) => sign,
		(0, m) => {
			// A subnormal half is m * 2^-24, a normal float32.
			let value = m as f32 * f32::from_bits(0x3380_0000);
			return if sign != 0 { -value } else { value };
		}
		(0x1f, m) => sign | 0x7f80_0000 | (m << 13),
		(e, m) => sign | ((e + 127 - 15) << 23) | (m << 13),
	};
	f32::from_bits(out)
}

/// A storage's little-endian elements widened to float32. Both 16-bit formats widen exactly, as
/// `load_state_dict` copying them into a float32 parameter does.
fn widen(class: &str, bytes: &[u8]) -> Vec<f32> {
	match class {
		"BFloat16Storage" => bytes
			.as_chunks::<2>()
			.0
			.iter()
			.map(|b| f32::from_bits(u32::from(u16::from_le_bytes(*b)) << 16))
			.collect(),
		"HalfStorage" => bytes
			.as_chunks::<2>()
			.0
			.iter()
			.map(|b| half_to_f32(u16::from_le_bytes(*b)))
			.collect(),
		_ => bytes
			.as_chunks::<4>()
			.0
			.iter()
			.map(|b| f32::from_le_bytes(*b))
			.collect(),
	}
}

fn read_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<Vec<u8>> {
	let mut entry = archive
		.by_name(name)
		.map_err(|error| fail!("checkpoint archive entry {name}: {error}"))?;
	let mut bytes = Vec::with_capacity(entry.size() as usize);
	entry.read_to_end(&mut bytes)?;
	Ok(bytes)
}

/// The state dict of a checkpoint directory: `model.safetensors`, which the Rust trainer writes, or the Python
/// trainer's `pytorch_model.bin`.
pub fn read_checkpoint(dir: &Path) -> Result<StateDict> {
	let safetensors = dir.join("model.safetensors");
	if safetensors.is_file() {
		return read_safetensors(&safetensors);
	}
	read_state_dict(&dir.join("pytorch_model.bin"))
}

/// Reads every tensor of a safetensors file, widening `F32`, `BF16` and `F16` to float32. The order is the file's
/// header order, which `safetensors` sorts by offset.
pub fn read_safetensors(path: &Path) -> Result<StateDict> {
	let bytes = std::fs::read(path).map_err(|error| fail!("{}: {error}", path.display()))?;
	let file = safetensors::SafeTensors::deserialize(&bytes)
		.map_err(|error| fail!("{} is not a safetensors file: {error}", path.display()))?;
	let mut state = StateDict::default();
	let mut names: Vec<(usize, String)> = file
		.tensors()
		.into_iter()
		.map(|(name, view)| (view.data().as_ptr() as usize, name))
		.collect();
	names.sort();
	for (_, name) in names {
		let view = file
			.tensor(&name)
			.map_err(|error| fail!("{}: {error}", path.display()))?;
		let raw = view.data();
		let data = match view.dtype() {
			safetensors::Dtype::F32 => Some(
				raw.chunks_exact(4)
					.map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
					.collect(),
			),
			safetensors::Dtype::BF16 => Some(
				raw.chunks_exact(2)
					.map(|c| f32::from_bits(u32::from(u16::from_le_bytes([c[0], c[1]])) << 16))
					.collect(),
			),
			_ => None,
		};
		let storage = match view.dtype() {
			safetensors::Dtype::F32 => "FloatStorage".to_owned(),
			safetensors::Dtype::BF16 => "BFloat16Storage".to_owned(),
			other => format!("{other:?}"),
		};
		state.order.push(name.clone());
		state.tensors.insert(
			name,
			Tensor {
				storage,
				shape: view.shape().to_vec(),
				data,
			},
		);
	}
	Ok(state)
}

/// Reads every tensor of the state dict at `path`.
pub fn read_state_dict(path: &Path) -> Result<StateDict> {
	let file = std::fs::File::open(path).map_err(|error| fail!("{}: {error}", path.display()))?;
	let mut archive =
		zip::ZipArchive::new(file).map_err(|error| fail!("{} is not a torch zip archive: {error}", path.display()))?;
	let pickle_name = archive
		.file_names()
		.filter_map(|name| name.ok())
		.find(|name| name.ends_with("/data.pkl") && name.matches('/').count() == 1)
		.map(|name| name.into_owned())
		.ok_or_else(|| fail!("{} has no <archive>/data.pkl", path.display()))?;
	let prefix = pickle_name.trim_end_matches("data.pkl").to_owned();

	if let Ok(order) = read_entry(&mut archive, &format!("{prefix}byteorder")) {
		if order != b"little" {
			return Err(fail!(
				"{} stores {} tensors; only little-endian is read",
				path.display(),
				String::from_utf8_lossy(&order)
			));
		}
	}

	let root = pickle::load(&read_entry(&mut archive, &pickle_name)?)?;
	let entries = root
		.entries()
		.ok_or_else(|| fail!("{} does not pickle a dict", path.display()))?;

	let mut storages: BTreeMap<String, Vec<f32>> = BTreeMap::new();
	let mut state = StateDict::default();
	for (key, value) in entries {
		let name = key
			.as_str()
			.ok_or_else(|| fail!("state dict key {key:?} is not a string"))?
			.to_owned();
		let Value::Call { callable, args, .. } = &value else {
			return Err(fail!("state dict entry {name} is {value:?}, not a rebuilt tensor"));
		};
		match callable.as_ref() {
			Value::Global { module, name: function }
				if module == "torch._utils" && function == "_rebuild_tensor_v2" => {}
			other => {
				return Err(fail!(
					"state dict entry {name} is built by {other:?}, not torch._utils._rebuild_tensor_v2"
				))
			}
		}
		let args = args
			.as_tuple()
			.ok_or_else(|| fail!("state dict entry {name} has no argument tuple"))?;
		if args.len() < 4 {
			return Err(fail!("state dict entry {name} has {} rebuild arguments", args.len()));
		}
		let (storage_key, class, storage_numel) = storage_ref(&args[0])?;
		let offset = args[1].as_int().and_then(|o| usize::try_from(o).ok());
		let offset = offset.ok_or_else(|| fail!("state dict entry {name} has no storage offset"))?;
		let shape = usize_tuple(&args[2], &format!("{name} size"))?;
		let stride = usize_tuple(&args[3], &format!("{name} stride"))?;
		if shape.len() != stride.len() {
			return Err(fail!(
				"state dict entry {name} has size {shape:?} and stride {stride:?}"
			));
		}

		let data = if let Some(width) = float_width(&class) {
			if !storages.contains_key(&storage_key) {
				let bytes = read_entry(&mut archive, &format!("{prefix}data/{storage_key}"))?;
				if bytes.len() != storage_numel * width {
					return Err(fail!(
						"storage {storage_key} holds {} bytes, expected {storage_numel} {class} elements",
						bytes.len()
					));
				}
				storages.insert(storage_key.clone(), widen(&class, &bytes));
			}
			Some(gather_strided(&storages[&storage_key], offset, &shape, &stride)?)
		} else {
			None
		};
		state.order.push(name.clone());
		state.tensors.insert(
			name,
			Tensor {
				storage: class,
				shape,
				data,
			},
		);
	}
	Ok(state)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn gathers_a_transposed_view() {
		// A 2x3 storage viewed as its 3x2 transpose: stride (1, 3).
		let storage = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0];
		let out = gather_strided(&storage, 0, &[3, 2], &[1, 3]).unwrap();
		assert_eq!(out, vec![0.0, 3.0, 1.0, 4.0, 2.0, 5.0]);
	}

	#[test]
	fn widens_both_16_bit_formats_exactly() {
		// bfloat16 0x3fc0 is 1.5; binary16 0x3e00 is 1.5, 0xc000 is -2, 0x0001 is 2^-24 and 0x7c00 is infinity.
		assert_eq!(widen("BFloat16Storage", &0x3fc0u16.to_le_bytes()), vec![1.5]);
		let halves: Vec<u8> = [0x3e00u16, 0xc000, 0x0001, 0x7c00]
			.iter()
			.flat_map(|h| h.to_le_bytes())
			.collect();
		assert_eq!(
			widen("HalfStorage", &halves),
			vec![1.5, -2.0, 2f32.powi(-24), f32::INFINITY]
		);
	}

	#[test]
	fn refuses_a_view_past_its_storage() {
		let storage = [0.0, 1.0];
		assert!(gather_strided(&storage, 1, &[2], &[1]).is_err());
	}
}
