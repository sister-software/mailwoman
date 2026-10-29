//! `trainer-export`: the Python-free ONNX export and int8 quantization.
//!
//! - `export-onnx --checkpoint <dir> --output <model.onnx>`: the opset-17 float32 graph of a checkpoint directory
//!   (`config.json` and `pytorch_model.bin`).
//! - `quantize --input <model.onnx> --output <model-int8.onnx>`: `quantize_dynamic(QInt8)`'s int8 graph.
//! - `tensors --checkpoint <dir>`: each state-dict tensor's name, storage type and shape, one per line.
//! - `diff-initializers --left <a.onnx> --right <b.onnx>`: the initializers the two graphs share by name, with the
//!   ones whose type, shape or bytes differ listed first. Exits 1 when any differ or either graph has one the other
//!   lacks.
//!
//! Every output file is written beside its destination and renamed into place once complete.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use prost::Message;
use trainer_export::checkpoint::read_state_dict;
use trainer_export::export::export_checkpoint;
use trainer_export::onnx::tensor_proto::DataType;
use trainer_export::onnx::ModelProto;
use trainer_export::quantize::quantize_dynamic_qint8;
use trainer_export::{fail, Result};

fn flags(args: &[String]) -> Result<BTreeMap<String, String>> {
	let mut out = BTreeMap::new();
	let mut iter = args.iter();
	while let Some(flag) = iter.next() {
		let key = flag
			.strip_prefix("--")
			.ok_or_else(|| fail!("unexpected argument {flag}"))?;
		let value = iter.next().ok_or_else(|| fail!("--{key} needs a value"))?;
		out.insert(key.to_owned(), value.clone());
	}
	Ok(out)
}

fn required<'a>(flags: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str> {
	flags
		.get(key)
		.map(String::as_str)
		.ok_or_else(|| fail!("--{key} is required"))
}

fn read_model(path: &Path) -> Result<ModelProto> {
	let bytes = std::fs::read(path).map_err(|error| fail!("{}: {error}", path.display()))?;
	Ok(ModelProto::decode(bytes.as_slice())?)
}

fn write_model(model: &ModelProto, path: &Path) -> Result<()> {
	let staged = PathBuf::from(format!("{}.partial", path.display()));
	std::fs::write(&staged, model.encode_to_vec()).map_err(|error| fail!("{}: {error}", staged.display()))?;
	std::fs::rename(&staged, path).map_err(|error| fail!("{}: {error}", path.display()))?;
	Ok(())
}

/// An initializer's type, dims and elements as `raw_data` would hold them, by name.
type InitializerIndex = BTreeMap<String, (Option<i32>, Vec<i64>, Vec<u8>)>;

fn diff_initializers(left: &Path, right: &Path) -> Result<bool> {
	let index = |model: ModelProto| -> InitializerIndex {
		let graph = model.graph.unwrap_or_default();
		graph
			.initializer
			.into_iter()
			.map(|t| {
				// The elements as `raw_data` would hold them, so a value stored in a typed field compares equal to the
				// same value stored raw. `int32_data` carries every type of 32 bits or fewer, one element per entry.
				let width = match DataType::try_from(t.data_type.unwrap_or_default()) {
					Ok(DataType::Int8 | DataType::Uint8 | DataType::Bool) => 1,
					Ok(DataType::Int16 | DataType::Uint16 | DataType::Float16 | DataType::Bfloat16) => 2,
					_ => 4,
				};
				let bytes = match t.raw_data {
					Some(raw) if !raw.is_empty() => raw,
					_ => {
						let mut bytes: Vec<u8> = t.float_data.iter().flat_map(|v| v.to_le_bytes()).collect();
						bytes.extend(t.int32_data.iter().flat_map(|v| v.to_le_bytes()[..width].to_vec()));
						bytes.extend(t.int64_data.iter().flat_map(|v| v.to_le_bytes()));
						bytes
					}
				};
				(t.name.unwrap_or_default(), (t.data_type, t.dims, bytes))
			})
			.collect()
	};
	let (a, b) = (index(read_model(left)?), index(read_model(right)?));
	let mut equal = 0usize;
	let mut differ = Vec::new();
	for (name, value) in &a {
		match b.get(name) {
			Some(other) if other == value => equal += 1,
			Some(other) => differ.push(format!(
				"differs {name}: {:?}{:?} vs {:?}{:?}, {} of {} bytes differ",
				value.0,
				value.1,
				other.0,
				other.1,
				value.2.iter().zip(&other.2).filter(|(x, y)| x != y).count() + value.2.len().abs_diff(other.2.len()),
				value.2.len().max(other.2.len())
			)),
			None => differ.push(format!("left only {name}")),
		}
	}
	differ.extend(
		b.keys()
			.filter(|name| !a.contains_key(*name))
			.map(|name| format!("right only {name}")),
	);
	for line in &differ {
		println!("{line}");
	}
	println!(
		"{equal} equal, {} differ or are unmatched, of {} left and {} right",
		differ.len(),
		a.len(),
		b.len()
	);
	Ok(differ.is_empty())
}

fn run(args: &[String]) -> Result<bool> {
	let (command, rest) = args
		.split_first()
		.ok_or_else(|| fail!("usage: trainer-export <command> [--flag value]..."))?;
	let flags = flags(rest)?;
	match command.as_str() {
		"export-onnx" => {
			let model = export_checkpoint(Path::new(required(&flags, "checkpoint")?))?;
			write_model(&model, Path::new(required(&flags, "output")?))?;
		}
		"quantize" => {
			let model = quantize_dynamic_qint8(read_model(Path::new(required(&flags, "input")?))?)?;
			write_model(&model, Path::new(required(&flags, "output")?))?;
		}
		"tensors" => {
			let state = read_state_dict(&Path::new(required(&flags, "checkpoint")?).join("pytorch_model.bin"))?;
			for name in &state.order {
				let tensor = &state.tensors[name];
				println!("{name}\t{}\t{:?}", tensor.storage, tensor.shape);
			}
		}
		"diff-initializers" => {
			return diff_initializers(
				Path::new(required(&flags, "left")?),
				Path::new(required(&flags, "right")?),
			);
		}
		other => return Err(fail!("unknown command {other}")),
	}
	Ok(true)
}

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	match run(&args) {
		Ok(true) => ExitCode::SUCCESS,
		Ok(false) => ExitCode::from(1),
		Err(error) => {
			eprintln!("trainer-export: {error}");
			ExitCode::from(2)
		}
	}
}
