//! Shape inference for the operators the exporter and the quantizer emit, written as `value_info`.
//!
//! `quantize_dynamic` saves its output after onnx's shape inference (`onnx.shape_inference.infer_shapes`, no data
//! propagation), so the shipped int8 graph carries a `value_info` entry for every intermediate tensor. onnxruntime
//! reads those shapes when it optimizes a session: its `SkipLayerNormalization` fusion of the last residual `Add` into
//! `final_ln` applies only when both `Add` inputs carry the same symbolic shape. Without the annotations that fusion
//! does not happen, and the int8 logits move by up to 2.7e-2 on the held-out probe (F2 record in
//! `docs/engineering/reference/2026-10-29-python-removal-plan.mdx`). This module reproduces onnx's rules for the
//! operators below, including its multidirectional broadcast and its naming of every dimension it cannot determine as
//! a fresh `unk__<n>` symbol at the node that produces it, so the same tensors end up sharing symbols.
//!
//! A tensor produced by an operator outside this list gets no entry, and its consumers' shapes are unknown.

use std::collections::HashMap;

use crate::graph::{value_info, Dim};
use crate::onnx::tensor_proto::DataType;
use crate::onnx::type_proto::Value as TypeValue;
use crate::onnx::{GraphProto, NodeProto, TensorProto, ValueInfoProto};

/// A dimension during inference: a value, a symbol, or not yet known.
#[derive(Clone, Debug, PartialEq, Eq)]
enum D {
	Value(i64),
	Param(String),
	Unknown,
}

#[derive(Clone, Debug)]
struct Info {
	elem: i32,
	dims: Vec<D>,
}

struct Inference<'a> {
	known: HashMap<String, Info>,
	constants: HashMap<&'a str, &'a TensorProto>,
	next_symbol: usize,
}

fn ints(tensor: &TensorProto) -> Option<Vec<i64>> {
	if tensor.data_type != Some(DataType::Int64 as i32) {
		return None;
	}
	match &tensor.raw_data {
		Some(raw) if !raw.is_empty() => Some(raw.as_chunks::<8>().0.iter().map(|b| i64::from_le_bytes(*b)).collect()),
		_ => Some(tensor.int64_data.clone()),
	}
}

fn attr_i(node: &NodeProto, name: &str) -> Option<i64> {
	node.attribute
		.iter()
		.find(|a| a.name.as_deref() == Some(name))
		.and_then(|a| a.i)
}

fn attr_ints(node: &NodeProto, name: &str) -> Option<Vec<i64>> {
	node.attribute
		.iter()
		.find(|a| a.name.as_deref() == Some(name))
		.map(|a| a.ints.clone())
}

/// onnx's `multidirectionalBroadcastShapeInference` for one output.
fn broadcast(shapes: &[&[D]]) -> Vec<D> {
	let rank = shapes.iter().map(|s| s.len()).max().unwrap_or(0);
	(0..rank)
		.map(|i| {
			let mut value = 1i64;
			let mut symbolic: Option<&D> = None;
			let mut symbolic_count = 0;
			for shape in shapes {
				let Some(dim) = (i + shape.len()).checked_sub(rank).map(|j| &shape[j]) else {
					continue;
				};
				match dim {
					D::Value(v) => {
						if *v != 1 {
							value = *v;
						}
					}
					other => match symbolic {
						None => {
							symbolic = Some(other);
							symbolic_count = 1;
						}
						Some(seen) if seen != other => symbolic_count += 1,
						Some(_) => {}
					},
				}
			}
			if value != 1 || symbolic_count == 0 {
				D::Value(value)
			} else if symbolic_count == 1 {
				symbolic.cloned().unwrap_or(D::Unknown)
			} else {
				D::Unknown
			}
		})
		.collect()
}

fn normalize(axis: i64, rank: usize) -> usize {
	if axis < 0 {
		(axis + rank as i64).max(0) as usize
	} else {
		axis as usize
	}
}

impl<'a> Inference<'a> {
	fn get(&self, name: &str) -> Option<&Info> {
		self.known.get(name)
	}

	fn constant(&self, name: &str) -> Option<Vec<i64>> {
		self.constants.get(name).and_then(|t| ints(t))
	}

	/// Every output of one node, or `None` where onnx's rule needs an input this pass does not know.
	fn infer(&self, node: &NodeProto) -> Vec<Option<Info>> {
		let op = node.op_type.as_deref().unwrap_or_default();
		let input = |i: usize| node.input.get(i).and_then(|n| self.get(n)).cloned();
		let same = |elem: Option<i32>| {
			input(0).map(|x| Info {
				elem: elem.unwrap_or(x.elem),
				dims: x.dims,
			})
		};
		let single = |info: Option<Info>| vec![info];
		match op {
			"Add" | "Mul" | "Div" | "Sub" | "Equal" | "Where" => {
				let infos: Option<Vec<Info>> = (0..node.input.len()).map(input).collect();
				let Some(infos) = infos else { return vec![None] };
				let dims = broadcast(&infos.iter().map(|i| i.dims.as_slice()).collect::<Vec<_>>());
				let elem = match op {
					"Equal" => DataType::Bool as i32,
					"Where" => infos[1].elem,
					_ => infos[0].elem,
				};
				single(Some(Info { elem, dims }))
			}
			"Erf" | "Softmax" | "LayerNormalization" | "Clip" | "Relu" | "Tanh" => single(same(None)),
			"Conv" => {
				// onnx's `convPoolShapeInference` for a 1-D convolution with explicit pads, unit strides and dilations.
				let (Some(x), Some(w)) = (input(0), input(1)) else {
					return vec![None];
				};
				if x.dims.len() != 3 || w.dims.len() != 3 {
					return vec![None];
				}
				let pads = attr_ints(node, "pads").unwrap_or_else(|| vec![0, 0]);
				let length = match (&x.dims[2], &w.dims[2]) {
					(D::Value(n), D::Value(k)) => D::Value(n + pads[0] + pads[1] - k + 1),
					_ => D::Unknown,
				};
				single(Some(Info {
					elem: x.elem,
					dims: vec![x.dims[0].clone(), w.dims[0].clone(), length],
				}))
			}
			"ReduceMax" => single(input(0).and_then(|x| {
				// Opset 17's `ReduceMax` takes its axes as an attribute.
				let rank = x.dims.len();
				let axes: Vec<usize> = attr_ints(node, "axes")?.iter().map(|a| normalize(*a, rank)).collect();
				let keep = attr_i(node, "keepdims").unwrap_or(1) == 1;
				let dims = x
					.dims
					.iter()
					.enumerate()
					.filter_map(|(i, d)| match (axes.contains(&i), keep) {
						(true, true) => Some(D::Value(1)),
						(true, false) => None,
						_ => Some(d.clone()),
					})
					.collect();
				Some(Info { elem: x.elem, dims })
			})),
			"Cast" => single(same(attr_i(node, "to").map(|v| v as i32))),
			"DequantizeLinear" => single(input(0).zip(input(1)).map(|(x, s)| Info {
				elem: s.elem,
				dims: x.dims,
			})),
			"DynamicQuantizeLinear" => {
				let x = input(0);
				vec![
					x.map(|x| Info {
						elem: DataType::Uint8 as i32,
						dims: x.dims,
					}),
					Some(Info {
						elem: DataType::Float as i32,
						dims: vec![],
					}),
					Some(Info {
						elem: DataType::Uint8 as i32,
						dims: vec![],
					}),
				]
			}
			"Shape" => single(input(0).map(|x| {
				let rank = x.dims.len() as i64;
				let clamp = |v: i64| (if v < 0 { v + rank } else { v }).clamp(0, rank);
				let start = clamp(attr_i(node, "start").unwrap_or(0));
				let end = clamp(attr_i(node, "end").unwrap_or(rank));
				Info {
					elem: DataType::Int64 as i32,
					dims: vec![D::Value((end - start).max(0))],
				}
			})),
			"Squeeze" => single(input(0).map(|x| {
				let axes = node.input.get(1).and_then(|a| self.constant(a));
				let rank = x.dims.len();
				let dims = match axes {
					Some(axes) => {
						let axes: Vec<usize> = axes.iter().map(|a| normalize(*a, rank)).collect();
						x.dims
							.iter()
							.enumerate()
							.filter(|(i, _)| !axes.contains(i))
							.map(|(_, d)| d.clone())
							.collect()
					}
					None => x.dims.iter().filter(|d| **d != D::Value(1)).cloned().collect(),
				};
				Info { elem: x.elem, dims }
			})),
			"Unsqueeze" => {
				let (Some(x), Some(axes)) = (input(0), node.input.get(1).and_then(|a| self.constant(a))) else {
					return vec![None];
				};
				let rank = x.dims.len() + axes.len();
				let mut axes: Vec<usize> = axes.iter().map(|a| normalize(*a, rank)).collect();
				axes.sort_unstable();
				let mut rest = x.dims.into_iter();
				let dims = (0..rank)
					.map(|i| {
						if axes.contains(&i) {
							D::Value(1)
						} else {
							rest.next().unwrap_or(D::Unknown)
						}
					})
					.collect();
				single(Some(Info { elem: x.elem, dims }))
			}
			"Range" => single(input(0).map(|x| Info {
				elem: x.elem,
				dims: vec![D::Unknown],
			})),
			"Concat" => {
				let infos: Option<Vec<Info>> = (0..node.input.len()).map(input).collect();
				let Some(infos) = infos else { return vec![None] };
				let rank = infos[0].dims.len();
				let axis = normalize(attr_i(node, "axis").unwrap_or(0), rank);
				let dims = (0..rank)
					.map(|i| {
						if i == axis {
							let mut total = 0;
							for info in &infos {
								match info.dims[i] {
									D::Value(v) => total += v,
									_ => return D::Unknown,
								}
							}
							D::Value(total)
						} else {
							infos
								.iter()
								.map(|info| info.dims[i].clone())
								.find(|d| *d != D::Unknown)
								.unwrap_or(D::Unknown)
						}
					})
					.collect();
				single(Some(Info {
					elem: infos[0].elem,
					dims,
				}))
			}
			"Expand" => {
				let (Some(x), Some(shape)) = (input(0), input(1)) else {
					return vec![None];
				};
				match node.input.get(1).and_then(|s| self.constant(s)) {
					Some(target) => {
						let target: Vec<D> = target.into_iter().map(D::Value).collect();
						single(Some(Info {
							elem: x.elem,
							dims: broadcast(&[&x.dims, &target]),
						}))
					}
					None => match shape.dims.first() {
						Some(D::Value(n)) => single(Some(Info {
							elem: x.elem,
							dims: vec![D::Unknown; *n as usize],
						})),
						_ => vec![None],
					},
				}
			}
			"Gather" => {
				let (Some(data), Some(indices)) = (input(0), input(1)) else {
					return vec![None];
				};
				let axis = normalize(attr_i(node, "axis").unwrap_or(0), data.dims.len());
				let mut dims = data.dims[..axis].to_vec();
				dims.extend(indices.dims);
				dims.extend_from_slice(&data.dims[axis + 1..]);
				single(Some(Info { elem: data.elem, dims }))
			}
			"MatMul" | "MatMulInteger" => {
				let (Some(a), Some(b)) = (input(0), input(1)) else {
					return vec![None];
				};
				if a.dims.len() < 2 || b.dims.len() < 2 {
					return vec![None];
				}
				let mut dims = broadcast(&[&a.dims[..a.dims.len() - 2], &b.dims[..b.dims.len() - 2]]);
				dims.push(a.dims[a.dims.len() - 2].clone());
				dims.push(b.dims[b.dims.len() - 1].clone());
				let elem = if op == "MatMulInteger" {
					DataType::Int32 as i32
				} else {
					a.elem
				};
				single(Some(Info { elem, dims }))
			}
			"Gemm" => {
				let (Some(a), Some(b)) = (input(0), input(1)) else {
					return vec![None];
				};
				let m = if attr_i(node, "transA") == Some(1) {
					a.dims[1].clone()
				} else {
					a.dims[0].clone()
				};
				let n = if attr_i(node, "transB") == Some(1) {
					b.dims[0].clone()
				} else {
					b.dims[1].clone()
				};
				single(Some(Info {
					elem: a.elem,
					dims: vec![m, n],
				}))
			}
			"Transpose" => single(input(0).map(|x| {
				let rank = x.dims.len();
				let perm = attr_ints(node, "perm").unwrap_or_else(|| (0..rank as i64).rev().collect());
				Info {
					elem: x.elem,
					dims: perm.iter().map(|p| x.dims[*p as usize].clone()).collect(),
				}
			})),
			"Reshape" => {
				let Some(x) = input(0) else { return vec![None] };
				match node.input.get(1).and_then(|s| self.constant(s)) {
					Some(target) => {
						let allow_zero = attr_i(node, "allowzero") == Some(1);
						let mut dims: Vec<D> = target
							.iter()
							.enumerate()
							.map(|(i, v)| match *v {
								0 if !allow_zero => x.dims.get(i).cloned().unwrap_or(D::Unknown),
								-1 => D::Unknown,
								v => D::Value(v),
							})
							.collect();
						if let Some(hole) = target.iter().position(|v| *v == -1) {
							let total: Option<i64> = x
								.dims
								.iter()
								.map(|d| if let D::Value(v) = d { Some(*v) } else { None })
								.product();
							let rest: Option<i64> = dims
								.iter()
								.enumerate()
								.filter(|(i, _)| *i != hole)
								.map(|(_, d)| if let D::Value(v) = d { Some(*v) } else { None })
								.product();
							if let (Some(total), Some(rest)) = (total, rest) {
								if rest != 0 {
									dims[hole] = D::Value(total / rest);
								}
							}
						}
						single(Some(Info { elem: x.elem, dims }))
					}
					None => match input(1).and_then(|s| s.dims.first().cloned()) {
						Some(D::Value(n)) => single(Some(Info {
							elem: x.elem,
							dims: vec![D::Unknown; n as usize],
						})),
						_ => vec![None],
					},
				}
			}
			"ReduceSum" => {
				let (Some(x), Some(axes)) = (input(0), node.input.get(1).and_then(|a| self.constant(a))) else {
					return vec![None];
				};
				let rank = x.dims.len();
				let axes: Vec<usize> = axes.iter().map(|a| normalize(*a, rank)).collect();
				let keep = attr_i(node, "keepdims").unwrap_or(1) == 1;
				let dims = x
					.dims
					.iter()
					.enumerate()
					.filter_map(|(i, d)| match (axes.contains(&i), keep) {
						(true, true) => Some(D::Value(1)),
						(true, false) => None,
						_ => Some(d.clone()),
					})
					.collect();
				single(Some(Info { elem: x.elem, dims }))
			}
			"Slice" => {
				let Some(x) = input(0) else { return vec![None] };
				let consts: Option<Vec<Vec<i64>>> = node.input[1..].iter().map(|n| self.constant(n)).collect();
				let Some(consts) = consts else { return vec![None] };
				let (starts, ends) = (&consts[0], &consts[1]);
				let rank = x.dims.len();
				let axes: Vec<usize> = consts
					.get(2)
					.map(|a| a.iter().map(|v| normalize(*v, rank)).collect())
					.unwrap_or_else(|| (0..starts.len()).collect());
				let steps = consts.get(3).cloned().unwrap_or_else(|| vec![1; starts.len()]);
				let mut dims = x.dims.clone();
				for (k, axis) in axes.iter().enumerate() {
					dims[*axis] = match (&x.dims[*axis], steps[k]) {
						(D::Value(n), 1) => {
							let clamp = |v: i64| (if v < 0 { v + n } else { v }).clamp(0, *n);
							D::Value((clamp(ends[k]) - clamp(starts[k])).max(0))
						}
						_ => D::Unknown,
					};
				}
				single(Some(Info { elem: x.elem, dims }))
			}
			_ => vec![None; node.output.len()],
		}
	}

	/// onnx's `MaterializeSymbolicShape`: each dimension inference could not determine becomes a fresh symbol.
	fn materialize(&mut self, mut info: Info) -> Info {
		for dim in &mut info.dims {
			if *dim == D::Unknown {
				*dim = D::Param(format!("unk__{}", self.next_symbol));
				self.next_symbol += 1;
			}
		}
		info
	}
}

fn info_of(vi: &ValueInfoProto) -> Option<Info> {
	let Some(TypeValue::TensorType(t)) = vi.r#type.as_ref().and_then(|t| t.value.as_ref()) else {
		return None;
	};
	let dims = t
		.shape
		.as_ref()?
		.dim
		.iter()
		.map(|d| match &d.value {
			Some(crate::onnx::tensor_shape_proto::dimension::Value::DimValue(v)) => D::Value(*v),
			Some(crate::onnx::tensor_shape_proto::dimension::Value::DimParam(p)) => D::Param(p.clone()),
			None => D::Unknown,
		})
		.collect();
	Some(Info {
		elem: t.elem_type?,
		dims,
	})
}

/// Replaces the graph's `value_info` with the shapes inferred from its inputs and initializers.
pub fn annotate(graph: &mut GraphProto) {
	let mut inference = Inference {
		known: HashMap::new(),
		constants: graph
			.initializer
			.iter()
			.filter_map(|t| Some((t.name.as_deref()?, t)))
			.collect(),
		next_symbol: 0,
	};
	for vi in &graph.input {
		if let (Some(name), Some(info)) = (&vi.name, info_of(vi)) {
			inference.known.insert(name.clone(), info);
		}
	}
	for t in &graph.initializer {
		if let (Some(name), Some(elem)) = (&t.name, t.data_type) {
			inference.known.insert(
				name.clone(),
				Info {
					elem,
					dims: t.dims.iter().map(|d| D::Value(*d)).collect(),
				},
			);
		}
	}
	let outputs: std::collections::HashSet<&str> = graph.output.iter().filter_map(|o| o.name.as_deref()).collect();
	let mut annotations = Vec::new();
	for node in &graph.node {
		for (name, info) in node.output.iter().zip(inference.infer(node)) {
			let Some(info) = info else { continue };
			let info = inference.materialize(info);
			if !outputs.contains(name.as_str()) {
				let dims: Vec<Dim> = info
					.dims
					.iter()
					.map(|d| match d {
						D::Value(v) => Dim::Fixed(*v),
						D::Param(p) => Dim::Param(p.clone()),
						D::Unknown => unreachable!("materialized"),
					})
					.collect();
				annotations.push(value_info(
					name,
					DataType::try_from(info.elem).unwrap_or(DataType::Undefined),
					&dims,
				));
			}
			inference.known.insert(name.clone(), info);
		}
	}
	graph.value_info = annotations;
}

#[cfg(test)]
mod tests {
	use super::*;

	fn p(s: &str) -> D {
		D::Param(s.into())
	}

	#[test]
	fn broadcast_follows_onnx() {
		// A value above 1 wins; one symbol against 1 keeps the symbol; two different symbols are unknown.
		assert_eq!(
			broadcast(&[&[p("b"), D::Value(1)], &[D::Value(1), D::Value(7)]]),
			vec![p("b"), D::Value(7)]
		);
		assert_eq!(broadcast(&[&[p("a")], &[p("b")]]), vec![D::Unknown]);
		assert_eq!(broadcast(&[&[p("a")], &[p("a")]]), vec![p("a")]);
		assert_eq!(
			broadcast(&[&[p("a"), D::Value(3)], &[D::Value(3)]]),
			vec![p("a"), D::Value(3)]
		);
	}
}
