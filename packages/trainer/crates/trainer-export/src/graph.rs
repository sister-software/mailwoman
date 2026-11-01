//! Builds an ONNX `GraphProto` one node at a time.
//!
//! Initializers that hold the same type, shape and bytes are stored once, as the onnxscript optimizer behind the
//! dynamo exporter stores them. A checkpoint can hold identical tensors under different names: a soft-feed channel's
//! projection bias and its cue vector start at zero and receive the same gradient, so they stay equal.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use crate::onnx::attribute_proto::AttributeType;
use crate::onnx::tensor_proto::DataType;
use crate::onnx::tensor_shape_proto::{dimension, Dimension};
use crate::onnx::type_proto::{self, Tensor as TensorType};
use crate::onnx::{AttributeProto, NodeProto, TensorProto, TensorShapeProto, TypeProto, ValueInfoProto};

/// One dimension of a declared graph input or output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dim {
	Fixed(i64),
	Param(String),
}

/// A declared graph input or output.
pub fn value_info(name: &str, elem_type: DataType, dims: &[Dim]) -> ValueInfoProto {
	let dim = dims
		.iter()
		.map(|d| Dimension {
			value: Some(match d {
				Dim::Fixed(n) => dimension::Value::DimValue(*n),
				Dim::Param(p) => dimension::Value::DimParam(p.clone()),
			}),
			denotation: None,
		})
		.collect();
	ValueInfoProto {
		name: Some(name.to_owned()),
		r#type: Some(TypeProto {
			value: Some(type_proto::Value::TensorType(TensorType {
				elem_type: Some(elem_type as i32),
				shape: Some(TensorShapeProto { dim }),
			})),
			denotation: None,
		}),
		..Default::default()
	}
}

pub fn attr_int(name: &str, value: i64) -> AttributeProto {
	AttributeProto {
		name: Some(name.to_owned()),
		r#type: Some(AttributeType::Int as i32),
		i: Some(value),
		..Default::default()
	}
}

pub fn attr_float(name: &str, value: f32) -> AttributeProto {
	AttributeProto {
		name: Some(name.to_owned()),
		r#type: Some(AttributeType::Float as i32),
		f: Some(value),
		..Default::default()
	}
}

pub fn attr_ints(name: &str, values: &[i64]) -> AttributeProto {
	AttributeProto {
		name: Some(name.to_owned()),
		r#type: Some(AttributeType::Ints as i32),
		ints: values.to_vec(),
		..Default::default()
	}
}

/// A tensor with its elements in `raw_data`, little-endian.
pub fn raw_tensor(name: &str, data_type: DataType, dims: &[i64], raw: Vec<u8>) -> TensorProto {
	TensorProto {
		dims: dims.to_vec(),
		data_type: Some(data_type as i32),
		name: Some(name.to_owned()),
		raw_data: Some(raw),
		..Default::default()
	}
}

pub fn f32_bytes(data: &[f32]) -> Vec<u8> {
	data.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn i64_bytes(data: &[i64]) -> Vec<u8> {
	data.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The nodes and initializers of a graph under construction.
#[derive(Default)]
pub struct GraphBuilder {
	pub nodes: Vec<NodeProto>,
	pub initializers: Vec<TensorProto>,
	/// (type, dims, hash of the bytes) to the indices of the initializers that have them.
	dedup: HashMap<(i32, Vec<i64>, u64), Vec<usize>>,
	names: HashSet<String>,
}

impl GraphBuilder {
	fn unique(&mut self, hint: &str) -> String {
		let mut name = hint.to_owned();
		let mut n = 1;
		while self.names.contains(&name) {
			name = format!("{hint}_{n}");
			n += 1;
		}
		self.names.insert(name.clone());
		name
	}

	/// Adds an initializer, or returns the name of an equal one already added.
	pub fn initializer(&mut self, hint: &str, data_type: DataType, dims: &[i64], raw: Vec<u8>) -> String {
		let mut hasher = DefaultHasher::new();
		raw.hash(&mut hasher);
		let key = (data_type as i32, dims.to_vec(), hasher.finish());
		if let Some(candidates) = self.dedup.get(&key) {
			for index in candidates {
				let existing = &self.initializers[*index];
				if existing.raw_data.as_deref() == Some(raw.as_slice()) {
					return existing.name.clone().unwrap_or_default();
				}
			}
		}
		let name = self.unique(hint);
		self.dedup.entry(key).or_default().push(self.initializers.len());
		self.initializers.push(raw_tensor(&name, data_type, dims, raw));
		name
	}

	pub fn f32(&mut self, hint: &str, dims: &[i64], data: &[f32]) -> String {
		self.initializer(hint, DataType::Float, dims, f32_bytes(data))
	}

	/// A scalar float constant.
	pub fn scalar_f32(&mut self, value: f32) -> String {
		self.f32(&format!("const_f32_{:08x}", value.to_bits()), &[], &[value])
	}

	/// A scalar int64 constant.
	pub fn scalar_i64(&mut self, value: i64) -> String {
		self.initializer(&format!("const_i64_{value}"), DataType::Int64, &[], i64_bytes(&[value]))
	}

	/// A one-dimensional int64 constant.
	pub fn ints(&mut self, values: &[i64]) -> String {
		let hint = format!(
			"const_ints_{}",
			values.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("_")
		);
		self.initializer(
			&hint.replace('-', "m"),
			DataType::Int64,
			&[values.len() as i64],
			i64_bytes(values),
		)
	}

	/// Adds a node with one output named after `hint`, and returns the output's name.
	pub fn op(&mut self, op_type: &str, inputs: &[&str], attributes: Vec<AttributeProto>, hint: &str) -> String {
		let output = self.unique(hint);
		self.op_into(op_type, inputs, attributes, &output);
		output
	}

	/// Adds a node whose one output has the given name, such as a graph output.
	pub fn op_into(&mut self, op_type: &str, inputs: &[&str], attributes: Vec<AttributeProto>, output: &str) {
		self.names.insert(output.to_owned());
		let name = format!("node_{}", self.nodes.len());
		self.nodes.push(NodeProto {
			input: inputs.iter().map(|s| (*s).to_owned()).collect(),
			output: vec![output.to_owned()],
			name: Some(name),
			op_type: Some(op_type.to_owned()),
			domain: Some(String::new()),
			attribute: attributes,
			..Default::default()
		});
	}

	/// Reserves a name used by a graph input, so no node output takes it.
	pub fn reserve(&mut self, name: &str) {
		self.names.insert(name.to_owned());
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn equal_initializers_are_stored_once() {
		let mut g = GraphBuilder::default();
		let a = g.f32("a", &[2], &[1.0, 2.0]);
		let b = g.f32("b", &[2], &[1.0, 2.0]);
		let c = g.f32("c", &[1, 2], &[1.0, 2.0]);
		assert_eq!(a, b);
		assert_ne!(a, c);
		assert_eq!(g.initializers.len(), 2);
	}

	#[test]
	fn node_outputs_never_collide() {
		let mut g = GraphBuilder::default();
		g.reserve("x");
		let first = g.op("Relu", &["x"], vec![], "x");
		let second = g.op("Relu", &[&first], vec![], "x");
		assert_ne!(first, "x");
		assert_ne!(first, second);
	}
}
