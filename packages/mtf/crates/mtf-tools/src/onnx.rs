// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Reading and replacing one initializer of a serialized ONNX `ModelProto`.
//!
//! Field numbers follow `onnx/onnx.proto`: `ModelProto.graph` is 7, `GraphProto.initializer` is 5, and a
//! `TensorProto` holds `dims` (1), `data_type` (2), `float_data` (4), `int32_data` (5), `name` (8) and `raw_data`
//! (9). Every other byte of the model is
//! kept as read. A replaced initializer is written with exactly those four fields, in field order and with `dims`
//! unpacked, which is what `onnx.numpy_helper.from_array` builds and protobuf serializes.

use crate::args::Result;

const MODEL_GRAPH: u64 = 7;
const GRAPH_INITIALIZER: u64 = 5;
const TENSOR_DIMS: u64 = 1;
const TENSOR_DATA_TYPE: u64 = 2;
const TENSOR_FLOAT_DATA: u64 = 4;
const TENSOR_INT32_DATA: u64 = 5;
const TENSOR_NAME: u64 = 8;
const TENSOR_RAW_DATA: u64 = 9;

/// One field of a message: its number, its value's wire form, and the byte range of the whole field.
struct Field<'a> {
	number: u64,
	value: Wire<'a>,
	start: usize,
	end: usize,
}

enum Wire<'a> {
	Varint(u64),
	Len(&'a [u8]),
	Fixed,
}

fn varint(buf: &[u8], pos: &mut usize) -> Result<u64> {
	let mut out = 0u64;
	for shift in (0..64).step_by(7) {
		let byte = *buf.get(*pos).ok_or("truncated varint")?;
		*pos += 1;
		out |= u64::from(byte & 0x7f) << shift;
		if byte & 0x80 == 0 {
			return Ok(out);
		}
	}
	Err("varint longer than 10 bytes".to_owned())
}

fn fields(buf: &[u8]) -> Result<Vec<Field<'_>>> {
	let mut out = Vec::new();
	let mut pos = 0;
	while pos < buf.len() {
		let start = pos;
		let key = varint(buf, &mut pos)?;
		let value = match key & 7 {
			0 => Wire::Varint(varint(buf, &mut pos)?),
			1 => {
				pos += 8;
				Wire::Fixed
			}
			2 => {
				let n = varint(buf, &mut pos)? as usize;
				let end = pos
					.checked_add(n)
					.filter(|&e| e <= buf.len())
					.ok_or("truncated field")?;
				let value = Wire::Len(&buf[pos..end]);
				pos = end;
				value
			}
			5 => {
				pos += 4;
				Wire::Fixed
			}
			wire => return Err(format!("unsupported wire type {wire}")),
		};
		if pos > buf.len() {
			return Err("truncated field".to_owned());
		}
		out.push(Field {
			number: key >> 3,
			value,
			start,
			end: pos,
		});
	}
	Ok(out)
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
	while value >= 0x80 {
		out.push((value as u8) | 0x80);
		value >>= 7;
	}
	out.push(value as u8);
}

fn put_len(out: &mut Vec<u8>, number: u64, payload: &[u8]) {
	put_varint(out, (number << 3) | 2);
	put_varint(out, payload.len() as u64);
	out.extend_from_slice(payload);
}

/// An initializer's shape, element type and raw bytes.
pub struct Tensor {
	pub dims: Vec<i64>,
	pub data_type: u64,
	pub raw: Vec<u8>,
}

fn tensor_name<'a>(tensor: &[Field<'a>]) -> Option<&'a [u8]> {
	tensor.iter().find_map(|f| match (f.number, &f.value) {
		(TENSOR_NAME, Wire::Len(name)) => Some(*name),
		_ => None,
	})
}

/// The graph field and the initializer named `name` inside it.
fn locate<'a>(model: &'a [u8], name: &str) -> Result<(Field<'a>, Field<'a>)> {
	let graph = fields(model)?
		.into_iter()
		.find(|f| f.number == MODEL_GRAPH)
		.ok_or("the model has no graph")?;
	let Wire::Len(graph_bytes) = graph.value else {
		return Err("the graph is not a message".to_owned());
	};
	for field in fields(graph_bytes)? {
		if field.number != GRAPH_INITIALIZER {
			continue;
		}
		let Wire::Len(tensor) = field.value else { continue };
		if tensor_name(&fields(tensor)?) == Some(name.as_bytes()) {
			return Ok((graph, field));
		}
	}
	Err(format!("{name} is not an initializer of the graph"))
}

/// `TensorProto.DataType` values whose `int32_data` this module widens back to bytes.
const ONNX_UINT8: u64 = 2;
const ONNX_INT8: u64 = 3;

/// The varints of a repeated field, packed or not.
fn push_varints(out: &mut Vec<u64>, value: &Wire<'_>) -> Result<()> {
	match value {
		Wire::Varint(v) => out.push(*v),
		Wire::Len(packed) => {
			let mut pos = 0;
			while pos < packed.len() {
				out.push(varint(packed, &mut pos)?);
			}
		}
		Wire::Fixed => return Err("a varint field holds a fixed-width value".to_owned()),
	}
	Ok(())
}

/// The initializer named `name`, with its values as little-endian bytes of its element type.
///
/// Values are read from `raw_data`, from `float_data` (a scale is stored there), or from `int32_data` for an 8-bit
/// type (a zero point is stored there). Only `raw_data` initializers are rewritten by [`replace_initializer`].
pub fn read_initializer(model: &[u8], name: &str) -> Result<Tensor> {
	let (_, field) = locate(model, name)?;
	let Wire::Len(bytes) = field.value else {
		unreachable!("located as a message")
	};
	let mut tensor = Tensor {
		dims: Vec::new(),
		data_type: 0,
		raw: Vec::new(),
	};
	let mut dims = Vec::new();
	let mut floats: Vec<u8> = Vec::new();
	let mut ints = Vec::new();
	let mut has_raw = false;
	for f in fields(bytes)? {
		match (f.number, &f.value) {
			(TENSOR_DIMS, value) => push_varints(&mut dims, value)?,
			(TENSOR_DATA_TYPE, Wire::Varint(t)) => tensor.data_type = *t,
			(TENSOR_RAW_DATA, Wire::Len(raw)) => {
				tensor.raw = raw.to_vec();
				has_raw = true;
			}
			(TENSOR_FLOAT_DATA, Wire::Len(packed)) => floats.extend_from_slice(packed),
			(TENSOR_FLOAT_DATA, Wire::Fixed) => floats.extend_from_slice(&bytes[f.end - 4..f.end]),
			(TENSOR_INT32_DATA, value) => push_varints(&mut ints, value)?,
			(TENSOR_NAME, _) => {}
			(other, _) => {
				return Err(format!(
					"{name} carries tensor field {other}, which this tool does not read"
				))
			}
		}
	}
	tensor.dims = dims.into_iter().map(|d| d as i64).collect();
	if !has_raw {
		if !floats.is_empty() {
			tensor.raw = floats;
		} else if matches!(tensor.data_type, ONNX_UINT8 | ONNX_INT8) {
			tensor.raw = ints.into_iter().map(|v| v as u8).collect();
		} else if !ints.is_empty() {
			return Err(format!("{name} keeps type-{} values in int32_data", tensor.data_type));
		}
	}
	Ok(tensor)
}

/// The model with the initializer named `name` replaced by `tensor`, every other byte unchanged.
pub fn replace_initializer(model: &[u8], name: &str, tensor: &Tensor) -> Result<Vec<u8>> {
	let (graph, field) = locate(model, name)?;
	let Wire::Len(graph_bytes) = graph.value else {
		unreachable!("located as a message")
	};
	let mut payload = Vec::with_capacity(tensor.raw.len() + name.len() + 32);
	for &d in &tensor.dims {
		put_varint(&mut payload, TENSOR_DIMS << 3);
		put_varint(&mut payload, d as u64);
	}
	put_varint(&mut payload, TENSOR_DATA_TYPE << 3);
	put_varint(&mut payload, tensor.data_type);
	put_len(&mut payload, TENSOR_NAME, name.as_bytes());
	put_len(&mut payload, TENSOR_RAW_DATA, &tensor.raw);

	let mut new_graph = Vec::with_capacity(graph_bytes.len() + tensor.raw.len());
	new_graph.extend_from_slice(&graph_bytes[..field.start]);
	put_len(&mut new_graph, GRAPH_INITIALIZER, &payload);
	new_graph.extend_from_slice(&graph_bytes[field.end..]);

	let mut out = Vec::with_capacity(model.len() + tensor.raw.len());
	out.extend_from_slice(&model[..graph.start]);
	put_len(&mut out, MODEL_GRAPH, &new_graph);
	out.extend_from_slice(&model[graph.end..]);
	Ok(out)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A model holding a graph with one other field and two initializers.
	fn model() -> Vec<u8> {
		let tensor = |name: &str, raw: &[u8]| {
			let mut t = Vec::new();
			for d in [2u64, 2] {
				put_varint(&mut t, TENSOR_DIMS << 3);
				put_varint(&mut t, d);
			}
			put_varint(&mut t, TENSOR_DATA_TYPE << 3);
			put_varint(&mut t, 2);
			put_len(&mut t, TENSOR_NAME, name.as_bytes());
			put_len(&mut t, TENSOR_RAW_DATA, raw);
			t
		};
		let mut graph = Vec::new();
		put_len(&mut graph, 2, b"graph-name");
		put_len(&mut graph, GRAPH_INITIALIZER, &tensor("a", &[1, 2, 3, 4]));
		put_len(&mut graph, GRAPH_INITIALIZER, &tensor("b", &[5, 6, 7, 8]));
		let mut model = Vec::new();
		put_varint(&mut model, 1 << 3);
		put_varint(&mut model, 8);
		put_len(&mut model, MODEL_GRAPH, &graph);
		model
	}

	#[test]
	fn a_rewrite_with_the_same_tensor_returns_the_input() {
		let model = model();
		let tensor = read_initializer(&model, "b").unwrap();
		assert_eq!(tensor.dims, vec![2, 2]);
		assert_eq!(tensor.raw, vec![5, 6, 7, 8]);
		assert_eq!(replace_initializer(&model, "b", &tensor).unwrap(), model);
	}

	#[test]
	fn a_replaced_initializer_reads_back_and_leaves_the_other() {
		let model = model();
		let grown = Tensor {
			dims: vec![3, 2],
			data_type: 2,
			raw: vec![5, 6, 7, 8, 9, 10],
		};
		let out = replace_initializer(&model, "b", &grown).unwrap();
		assert_eq!(read_initializer(&out, "b").unwrap().raw, grown.raw);
		assert_eq!(read_initializer(&out, "a").unwrap().raw, vec![1, 2, 3, 4]);
		assert!(read_initializer(&out, "c").is_err());
	}
}
