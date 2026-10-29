//! Int8 dynamic quantization, reproducing onnxruntime 1.30.0's
//! `quantize_dynamic(model_input, model_output, weight_type=QuantType.QInt8)` with its defaults: per-tensor scales
//! (`per_channel=False`), the full integer range (`reduce_range=False`), symmetric int8 weights
//! (`WeightSymmetric` unset, so a signed weight type is symmetric), asymmetric uint8 activations, and
//! `MatMulConstBOnly=True`. The rules below cite the onnxruntime 1.30.0 module each one reproduces.
//!
//! - `quantize.py` loads the model, then `onnx_quantizer.py::ONNXQuantizer.__init__` rewrites every
//!   `Gemm(alpha=1, beta=1, transA=0)` as `MatMul` plus `Add` (`onnx_model.py::replace_gemm_with_matmul`), storing a
//!   `transB=1` initializer transposed under its own name.
//! - A `MatMul` whose right-hand side is an initializer becomes `DynamicQuantizeLinear` of the left-hand side,
//!   `MatMulInteger` against the int8 weight, `Cast` to float, and `Mul` by the product of the two scales
//!   (`operators/matmul.py::MatMulInteger`). One `DynamicQuantizeLinear` serves every consumer of a tensor.
//! - A `Gather` from a float initializer reads the table quantized to uint8 with the activation scheme and leaves
//!   its output quantized (`operators/gather.py::GatherQuant`). A consumer that cannot read the quantized value gets a
//!   `DequantizeLinear` in front of it (`operators/base_operator.py`, `onnx_quantizer.py::_dequantize_value`).
//! - A `Transpose` of a quantized value transposes the quantized tensor (`operators/direct_q8.py::Direct8BitOp`).
//! - Scale and zero point follow `quant_utils.py::compute_scale_zp` and the elements `quant_utils.py::quantize_nparray`,
//!   with the same float32 and float64 steps, so the stored integers and scales equal onnxruntime's bit for bit.
//!
//! Before any of it the graph's `value_info` is cleared, the guard `corpus-python/src/mailwoman_train/export/quantize.py`
//! applies: an exporter can leave an intermediate shape annotation that onnx's shape inference rejects (the stale
//! `locale_film` annotation, `[768]` against an inferred `384`). The output then carries the shapes
//! [`crate::shape::annotate`] infers, as `quantize_dynamic` saves the shapes onnx infers: onnxruntime's
//! optimizer reads them, and without them it fuses differently and the int8 logits move.
//!
//! The other operators of onnxruntime's `IntegerOpsRegistry` (`Conv`, `Attention`, `LSTM`,
//! `EmbedLayerNormalization`) are refused by name rather than passed through unquantized.

use std::collections::{HashMap, HashSet};

use crate::onnx::tensor_proto::DataType;
use crate::onnx::{attribute_proto::AttributeType, AttributeProto, GraphProto, ModelProto, NodeProto, TensorProto};
use crate::{fail, Result};

const FLOAT: i32 = DataType::Float as i32;
const UINT8: i32 = DataType::Uint8 as i32;
const INT8: i32 = DataType::Int8 as i32;
const INT32: i32 = DataType::Int32 as i32;
const INT64: i32 = DataType::Int64 as i32;
const BOOL: i32 = DataType::Bool as i32;

/// The operators onnxruntime's dynamic mode quantizes that this module does not implement.
const UNIMPLEMENTED_OPS: [&str; 4] = ["Conv", "Attention", "LSTM", "EmbedLayerNormalization"];

/// The integer range and symmetry of one quantization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
	/// Weights: int8, symmetric over [-127, 127], zero point 0.
	WeightInt8Symmetric,
	/// Activations and gathered tables: uint8 over [0, 255] with a computed zero point.
	ActivationUint8,
}

impl Scheme {
	fn qrange(self) -> (i32, i32) {
		match self {
			Scheme::WeightInt8Symmetric => (-127, 127),
			Scheme::ActivationUint8 => (0, 255),
		}
	}

	/// The range `quantize_nparray` clips to: the type's full range regardless of symmetry.
	fn clip(self) -> (f32, f32) {
		match self {
			Scheme::WeightInt8Symmetric => (-128.0, 127.0),
			Scheme::ActivationUint8 => (0.0, 255.0),
		}
	}

	fn data_type(self) -> i32 {
		match self {
			Scheme::WeightInt8Symmetric => INT8,
			Scheme::ActivationUint8 => UINT8,
		}
	}

	fn symmetric(self) -> bool {
		matches!(self, Scheme::WeightInt8Symmetric)
	}
}

/// A tensor quantized per tensor: its integers (as stored, one byte each), scale and zero point.
#[derive(Clone, Debug, PartialEq)]
pub struct Quantized {
	pub values: Vec<u8>,
	pub scale: f32,
	pub zero_point: i32,
}

/// numpy's `round` on float64: halves to even.
fn round_f64(x: f64) -> f64 {
	x.round_ties_even()
}

/// `compute_data_quant_params` then `quantize_nparray` for one float32 tensor.
pub fn quantize_tensor(data: &[f32], scheme: Scheme) -> Quantized {
	let (qmin, qmax) = scheme.qrange();
	let (mut zero_point, mut scale) = (0i32, 1.0f32);
	if !data.is_empty() {
		// numpy's min and max over float32, then the range widened to include zero.
		let mut rmin = data.iter().copied().fold(f32::INFINITY, f32::min);
		let mut rmax = data.iter().copied().fold(f32::NEG_INFINITY, f32::max);
		rmin = rmin.min(0.0);
		rmax = rmax.max(0.0);
		if scheme.symmetric() {
			let absmax = rmin.abs().max(rmax.abs());
			rmin = -absmax;
			rmax = absmax;
		}
		// `dr` is the float32 difference widened to float64, `dq` the integer span in float64.
		let dr = f64::from(rmax - rmin);
		let dq = f64::from(qmax) - f64::from(qmin);
		let scale64 = dr / dq;
		if scale64 < f64::from(f32::MIN_POSITIVE) {
			scale = 1.0;
			zero_point = 0;
		} else {
			zero_point = if scheme.symmetric() {
				round_f64(f64::from(qmin + qmax) / 2.0) as i32
			} else {
				round_f64(f64::from(qmin) - f64::from(rmin) / scale64) as i32
			};
			scale = scale64 as f32;
		}
	}
	let (low, high) = scheme.clip();
	let zp = zero_point as f32;
	let values = data
		.iter()
		.map(|x| {
			let q = ((x / scale).round_ties_even() + zp).clamp(low, high);
			match scheme {
				Scheme::WeightInt8Symmetric => (q as i8) as u8,
				Scheme::ActivationUint8 => q as u8,
			}
		})
		.collect();
	Quantized {
		values,
		scale,
		zero_point,
	}
}

/// The float32 elements of an initializer, from `raw_data` or `float_data`.
pub fn tensor_f32(tensor: &TensorProto) -> Result<Vec<f32>> {
	let name = tensor.name.as_deref().unwrap_or_default();
	if tensor.data_type != Some(FLOAT) {
		return Err(fail!("initializer {name} is not float32"));
	}
	if !tensor.external_data.is_empty() {
		return Err(fail!("initializer {name} stores its data externally"));
	}
	let count: i64 = tensor.dims.iter().product();
	let data: Vec<f32> = match &tensor.raw_data {
		Some(raw) if !raw.is_empty() || tensor.float_data.is_empty() => {
			raw.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
		}
		_ => tensor.float_data.clone(),
	};
	if data.len() as i64 != count {
		return Err(fail!(
			"initializer {name} holds {} elements, its dims {:?} need {count}",
			data.len(),
			tensor.dims
		));
	}
	Ok(data)
}

fn attr<'a>(node: &'a NodeProto, name: &str) -> Option<&'a AttributeProto> {
	node.attribute.iter().find(|a| a.name.as_deref() == Some(name))
}

fn attr_i(node: &NodeProto, name: &str, default: i64) -> i64 {
	attr(node, name).and_then(|a| a.i).unwrap_or(default)
}

fn attr_f(node: &NodeProto, name: &str, default: f32) -> f32 {
	attr(node, name).and_then(|a| a.f).unwrap_or(default)
}

fn node(op_type: &str, inputs: &[&str], outputs: &[&str], name: &str) -> NodeProto {
	NodeProto {
		input: inputs.iter().map(|s| (*s).to_owned()).collect(),
		output: outputs.iter().map(|s| (*s).to_owned()).collect(),
		name: Some(name.to_owned()),
		op_type: Some(op_type.to_owned()),
		..Default::default()
	}
}

fn scalar_tensor(name: &str, data_type: i32, raw: Vec<u8>) -> TensorProto {
	TensorProto {
		data_type: Some(data_type),
		name: Some(name.to_owned()),
		raw_data: Some(raw),
		..Default::default()
	}
}

fn name_of(node: &NodeProto) -> &str {
	node.name.as_deref().unwrap_or_default()
}

/// `onnx_model.py::replace_gemm_with_matmul` over the top-level graph.
fn replace_gemm_with_matmul(graph: &mut GraphProto) -> Result<()> {
	let mut uses: HashMap<String, usize> = HashMap::new();
	for n in &graph.node {
		for input in &n.input {
			*uses.entry(input.clone()).or_default() += 1;
		}
	}
	let mut nodes = Vec::with_capacity(graph.node.len());
	for n in std::mem::take(&mut graph.node) {
		if n.op_type.as_deref() != Some("Gemm") {
			nodes.push(n);
			continue;
		}
		let (alpha, beta) = (attr_f(&n, "alpha", 1.0), attr_f(&n, "beta", 1.0));
		let (trans_a, trans_b) = (attr_i(&n, "transA", 0), attr_i(&n, "transB", 0));
		if !(alpha == 1.0 && beta == 1.0 && trans_a == 0) {
			nodes.push(n);
			continue;
		}
		let name = name_of(&n).to_owned();
		let mut input_b = n.input[1].clone();
		if trans_b == 1 {
			if let Some(index) = graph
				.initializer
				.iter()
				.position(|t| t.name.as_deref() == Some(input_b.as_str()))
			{
				let b = &graph.initializer[index];
				let [rows, cols] = b.dims[..] else {
					return Err(fail!("Gemm {name} has a rank-{} initializer B", b.dims.len()));
				};
				let data = tensor_f32(b)?;
				let (rows, cols) = (rows as usize, cols as usize);
				let mut t = vec![0.0f32; data.len()];
				for r in 0..rows {
					for c in 0..cols {
						t[c * rows + r] = data[r * cols + c];
					}
				}
				let raw = t.iter().flat_map(|v| v.to_le_bytes()).collect();
				// onnxruntime replaces B under its own name and assumes no other node reads it. A B another node
				// reads gets a transposed copy instead, so that node keeps the original.
				if uses.get(&input_b).copied().unwrap_or(0) > 1 {
					input_b = format!("{input_b}_Transposed");
				} else {
					graph.initializer.remove(index);
				}
				graph.initializer.push(TensorProto {
					dims: vec![cols as i64, rows as i64],
					data_type: Some(FLOAT),
					name: Some(input_b.clone()),
					raw_data: Some(raw),
					..Default::default()
				});
			} else {
				let transposed = format!("{input_b}_Transposed");
				let t_name = if name.is_empty() {
					String::new()
				} else {
					format!("{name}_Transpose")
				};
				nodes.push(node("Transpose", &[&input_b], &[&transposed], &t_name));
				input_b = transposed;
			}
		}
		let output = n.output[0].clone();
		let with_bias = n.input.len() > 2;
		let matmul_out = if with_bias {
			format!("{output}_MatMul")
		} else {
			output.clone()
		};
		let mm_name = if name.is_empty() {
			String::new()
		} else {
			format!("{name}_MatMul")
		};
		nodes.push(node("MatMul", &[&n.input[0], &input_b], &[&matmul_out], &mm_name));
		if with_bias {
			let add_name = if name.is_empty() {
				String::new()
			} else {
				format!("{name}_Add")
			};
			nodes.push(node("Add", &[&matmul_out, &n.input[2]], &[&output], &add_name));
		}
	}
	graph.node = nodes;
	Ok(())
}

/// The element type of every tensor the graph names, propagated through the operators these graphs use.
fn infer_types(graph: &GraphProto) -> HashMap<String, i32> {
	let mut types: HashMap<String, i32> = HashMap::new();
	for vi in graph.input.iter().chain(&graph.output) {
		if let Some(crate::onnx::type_proto::Value::TensorType(t)) = vi.r#type.as_ref().and_then(|t| t.value.as_ref()) {
			if let (Some(name), Some(elem)) = (&vi.name, t.elem_type) {
				types.insert(name.clone(), elem);
			}
		}
	}
	for t in &graph.initializer {
		if let (Some(name), Some(dt)) = (&t.name, t.data_type) {
			types.insert(name.clone(), dt);
		}
	}
	for n in &graph.node {
		let first = n.input.first().and_then(|i| types.get(i)).copied();
		let op = n.op_type.as_deref().unwrap_or_default();
		let out: Vec<Option<i32>> = match op {
			"Shape" | "Size" => vec![Some(INT64)],
			"Equal" | "Less" | "Greater" | "Not" | "And" | "Or" => vec![Some(BOOL)],
			"Where" => vec![n.input.get(1).and_then(|i| types.get(i)).copied()],
			"Cast" => vec![attr(n, "to").and_then(|a| a.i).map(|v| v as i32)],
			"MatMulInteger" => vec![Some(INT32)],
			"DynamicQuantizeLinear" => vec![Some(UINT8), Some(FLOAT), Some(UINT8)],
			"DequantizeLinear" => vec![n.input.get(1).and_then(|i| types.get(i)).copied()],
			_ => vec![first; n.output.len().max(1)],
		};
		for (name, ty) in n.output.iter().zip(out) {
			if let Some(ty) = ty {
				types.insert(name.clone(), ty);
			}
		}
	}
	types
}

#[derive(Clone)]
struct QValue {
	q_name: String,
	scale: String,
	zero_point: String,
}

struct Quantizer {
	initializers: Vec<TensorProto>,
	index: HashMap<String, usize>,
	types: HashMap<String, i32>,
	quantized: HashMap<String, QValue>,
	generated: HashSet<String>,
	new_nodes: Vec<NodeProto>,
}

impl Quantizer {
	fn initializer(&self, name: &str) -> Option<&TensorProto> {
		self.index.get(name).map(|i| &self.initializers[*i])
	}

	fn is_float(&self, name: &str) -> bool {
		self.types.get(name) == Some(&FLOAT)
	}

	fn add_initializer(&mut self, tensor: TensorProto) {
		let name = tensor.name.clone().unwrap_or_default();
		self.index.insert(name, self.initializers.len());
		self.initializers.push(tensor);
	}

	/// `quantize_initializer`: the quantized tensor, scale and zero point, made once per initializer.
	fn quantize_initializer(&mut self, name: &str, scheme: Scheme) -> Result<QValue> {
		if let Some(existing) = self.quantized.get(name) {
			return Ok(existing.clone());
		}
		let tensor = self
			.initializer(name)
			.ok_or_else(|| fail!("{name} is not an initializer"))?;
		let dims = tensor.dims.clone();
		let q = quantize_tensor(&tensor_f32(tensor)?, scheme);
		let value = QValue {
			q_name: format!("{name}_quantized"),
			scale: format!("{name}_scale"),
			zero_point: format!("{name}_zero_point"),
		};
		self.add_initializer(scalar_tensor(&value.scale, FLOAT, q.scale.to_le_bytes().to_vec()));
		let zp_byte = match scheme {
			Scheme::WeightInt8Symmetric => (q.zero_point as i8) as u8,
			Scheme::ActivationUint8 => q.zero_point as u8,
		};
		self.add_initializer(scalar_tensor(&value.zero_point, scheme.data_type(), vec![zp_byte]));
		self.add_initializer(TensorProto {
			dims,
			data_type: Some(scheme.data_type()),
			name: Some(value.q_name.clone()),
			raw_data: Some(q.values),
			..Default::default()
		});
		self.quantized.insert(name.to_owned(), value.clone());
		Ok(value)
	}

	/// `quantize_activation` for one input: a quantized value already made, an initializer quantized as an
	/// activation, or a new `DynamicQuantizeLinear`.
	fn quantize_activation(&mut self, input: &str, nodes: &mut Vec<NodeProto>) -> Result<QValue> {
		if let Some(existing) = self.quantized.get(input) {
			return Ok(existing.clone());
		}
		if self.initializer(input).is_some() {
			return self.quantize_initializer(input, Scheme::ActivationUint8);
		}
		let value = QValue {
			q_name: format!("{input}_quantized"),
			scale: format!("{input}_scale"),
			zero_point: format!("{input}_zero_point"),
		};
		nodes.push(node(
			"DynamicQuantizeLinear",
			&[input],
			&[&value.q_name, &value.scale, &value.zero_point],
			&format!("{input}_QuantizeLinear"),
		));
		self.quantized.insert(input.to_owned(), value.clone());
		Ok(value)
	}

	/// `_dequantize_value`: a `DequantizeLinear` for a quantized value a float consumer reads, made once.
	fn dequantize(&mut self, name: &str) {
		if self.generated.contains(name) {
			return;
		}
		let Some(value) = self.quantized.get(name).cloned() else {
			return;
		};
		let dq_name = format!("{name}_DequantizeLinear");
		if self.new_nodes.iter().any(|n| name_of(n) == dq_name) {
			return;
		}
		self.new_nodes.push(node(
			"DequantizeLinear",
			&[&value.q_name, &value.scale, &value.zero_point],
			&[name],
			&dq_name,
		));
	}

	fn pass_through(&mut self, n: NodeProto) {
		for input in n.input.clone() {
			self.dequantize(&input);
		}
		self.new_nodes.push(n);
	}

	fn matmul(&mut self, n: NodeProto) -> Result<()> {
		let mut nodes = Vec::new();
		let a = self.quantize_activation(&n.input[0], &mut nodes)?;
		let b = self.quantize_initializer(&n.input[1], Scheme::WeightInt8Symmetric)?;
		let output = n.output[0].clone();
		let base = name_of(&n);
		let mm_name = if base.is_empty() {
			String::new()
		} else {
			format!("{base}_quant")
		};
		let mm_out = format!("{output}_output_quantized");
		nodes.push(node(
			"MatMulInteger",
			&[&a.q_name, &b.q_name, &a.zero_point, &b.zero_point],
			&[&mm_out],
			&mm_name,
		));
		let otype = *self
			.types
			.get(&output)
			.ok_or_else(|| fail!("the element type of {output} is unknown"))?;
		let cast_out = format!("{mm_out}_cast_output");
		let mut cast = node("Cast", &[&mm_out], &[&cast_out], &format!("{mm_out}_cast"));
		cast.attribute.push(AttributeProto {
			name: Some("to".into()),
			r#type: Some(AttributeType::Int as i32),
			i: Some(i64::from(otype)),
			..Default::default()
		});
		nodes.push(cast);
		let scales_name = if mm_name.is_empty() {
			format!("{}_{}_mul", a.scale, b.scale)
		} else {
			format!("{mm_name}_scales_mul")
		};
		let scales_out = format!("{scales_name}:0");
		let exists = self.new_nodes.iter().chain(&nodes).any(|n| name_of(n) == scales_name);
		if !exists {
			nodes.push(node("Mul", &[&a.scale, &b.scale], &[&scales_out], &scales_name));
		}
		let out_name = if mm_name.is_empty() {
			String::new()
		} else {
			format!("{mm_name}_output_scale_mul")
		};
		nodes.push(node("Mul", &[&cast_out, &scales_out], &[&output], &out_name));
		self.new_nodes.extend(nodes);
		Ok(())
	}

	fn gather(&mut self, mut n: NodeProto) -> Result<()> {
		let table = self.quantize_activation(&n.input[0], &mut Vec::new())?;
		let output = n.output[0].clone();
		let q_output = format!("{output}_quantized");
		self.quantized.insert(
			output,
			QValue {
				q_name: q_output.clone(),
				scale: table.scale.clone(),
				zero_point: table.zero_point.clone(),
			},
		);
		n.output[0] = q_output;
		n.input[0] = table.q_name;
		self.new_nodes.push(n);
		Ok(())
	}

	fn transpose(&mut self, mut n: NodeProto) {
		let Some(input) = self.quantized.get(&n.input[0]).cloned() else {
			self.new_nodes.push(n);
			return;
		};
		let output = n.output[0].clone();
		let q_output = format!("{output}_quantized");
		self.quantized.insert(
			output,
			QValue {
				q_name: q_output.clone(),
				..input.clone()
			},
		);
		n.input[0] = input.q_name;
		n.output[0] = q_output;
		self.new_nodes.push(n);
	}
}

/// Quantizes a float32 model to int8 the way `quantize_dynamic(weight_type=QuantType.QInt8)` does.
pub fn quantize_dynamic_qint8(mut model: ModelProto) -> Result<ModelProto> {
	let opset = model
		.opset_import
		.iter()
		.find(|o| o.domain.as_deref().unwrap_or_default().is_empty() || o.domain.as_deref() == Some("ai.onnx"))
		.and_then(|o| o.version)
		.ok_or_else(|| fail!("the model imports no default-domain opset"))?;
	if opset <= 10 {
		return Err(fail!("opset {opset}: DynamicQuantizeLinear needs opset 11 or later"));
	}
	let graph = model.graph.as_mut().ok_or_else(|| fail!("the model has no graph"))?;
	if let Some(op) = graph
		.node
		.iter()
		.filter_map(|n| n.op_type.as_deref())
		.find(|op| UNIMPLEMENTED_OPS.contains(op))
	{
		return Err(fail!(
			"the graph has a {op} node; this quantizer does not implement onnxruntime's {op} rule"
		));
	}
	if graph
		.node
		.iter()
		.any(|n| !n.attribute.iter().all(|a| a.g.is_none() && a.graphs.is_empty()))
	{
		return Err(fail!(
			"the graph has a subgraph; this quantizer reads the top-level graph only"
		));
	}

	graph.value_info.clear();
	replace_gemm_with_matmul(graph)?;
	let types = infer_types(graph);

	let initializers = std::mem::take(&mut graph.initializer);
	let index = initializers
		.iter()
		.enumerate()
		.map(|(i, t)| (t.name.clone().unwrap_or_default(), i))
		.collect();
	let mut generated: HashSet<String> = graph.input.iter().filter_map(|i| i.name.clone()).collect();
	for t in &initializers {
		if let Some(name) = &t.name {
			generated.remove(name);
		}
	}
	let mut q = Quantizer {
		initializers,
		index,
		types,
		quantized: HashMap::new(),
		generated,
		new_nodes: Vec::new(),
	};

	for n in std::mem::take(&mut graph.node) {
		let before = q.new_nodes.len();
		let op = n.op_type.clone().unwrap_or_default();
		match op.as_str() {
			"MatMul" => {
				let b_const = q.initializer(&n.input[1]).is_some();
				let float = q.is_float(&n.input[0]) || q.is_float(&n.input[1]);
				if b_const && float {
					q.matmul(n)?;
				} else {
					q.pass_through(n);
				}
			}
			"Gather" => {
				let table = q
					.initializer(&n.input[0])
					.map(|t| t.data_type == Some(FLOAT))
					.unwrap_or(false);
				if table {
					q.gather(n)?;
				} else {
					q.pass_through(n);
				}
			}
			"Transpose" if q.is_float(&n.input[0]) => q.transpose(n),
			_ => q.pass_through(n),
		}
		let added: Vec<String> = q.new_nodes[before..].iter().flat_map(|n| n.output.clone()).collect();
		q.generated.extend(added);
	}
	for output in graph.output.iter().filter_map(|o| o.name.clone()).collect::<Vec<_>>() {
		q.dequantize(&output);
	}

	// `clean_initializers`: drop every initializer no node reads, and refuse a read of a tensor nothing defines.
	let read: HashSet<&str> = q
		.new_nodes
		.iter()
		.flat_map(|n| n.input.iter().map(String::as_str))
		.collect();
	let mut defined: HashSet<&str> = graph.input.iter().filter_map(|i| i.name.as_deref()).collect();
	defined.extend(q.initializers.iter().filter_map(|t| t.name.as_deref()));
	defined.extend(q.new_nodes.iter().flat_map(|n| n.output.iter().map(String::as_str)));
	if let Some(missing) = read.iter().find(|name| !name.is_empty() && !defined.contains(**name)) {
		return Err(fail!("the quantized graph reads {missing}, which nothing defines"));
	}
	let (kept, dropped): (Vec<TensorProto>, Vec<TensorProto>) = q
		.initializers
		.into_iter()
		.partition(|t| read.contains(t.name.as_deref().unwrap_or_default()));
	let dropped: HashSet<Option<String>> = dropped.into_iter().map(|t| t.name).collect();
	graph.input.retain(|i| !dropped.contains(&i.name));
	graph.initializer = kept;
	graph.node = q.new_nodes;
	crate::shape::annotate(graph);
	model.producer_name = Some("mailwoman-trainer-export".into());
	model.producer_version = Some(env!("CARGO_PKG_VERSION").into());
	Ok(model)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::graph::{raw_tensor, value_info, Dim};

	#[test]
	fn symmetric_int8_scale_and_rounding_match_numpy() {
		// absmax 1.27: scale = float32(2.54 widened to float64 / 254), zero point 0. 0.005 / scale is exactly 0.5 in
		// float32 and rounds to even, 0.
		let q = quantize_tensor(&[1.27, -0.635, 0.005, 0.0], Scheme::WeightInt8Symmetric);
		let expected_scale = (f64::from(1.27f32 - (-1.27f32)) / 254.0) as f32;
		assert_eq!(q.scale.to_bits(), expected_scale.to_bits());
		assert_eq!(q.zero_point, 0);
		let ints: Vec<i8> = q.values.iter().map(|v| *v as i8).collect();
		assert_eq!(ints[0], 127);
		assert_eq!(ints[1], (-0.635f32 / expected_scale).round_ties_even() as i8);
		assert_eq!(ints[3], 0);
	}

	#[test]
	fn uint8_zero_point_comes_from_the_widened_minimum() {
		// rmin -1, rmax 3: scale = 4 / 255, zero point = round(0 - (-1) / scale) = round(63.75) = 64.
		let q = quantize_tensor(&[-1.0, 3.0, 0.5], Scheme::ActivationUint8);
		assert_eq!(q.scale, (4.0f64 / 255.0) as f32);
		assert_eq!(q.zero_point, 64);
		assert_eq!(q.values[0], 0);
		assert_eq!(q.values[1], 255);
	}

	#[test]
	fn an_all_zero_tensor_takes_scale_one() {
		let q = quantize_tensor(&[0.0, 0.0], Scheme::WeightInt8Symmetric);
		assert_eq!((q.scale, q.zero_point), (1.0, 0));
	}

	fn tiny_model(stale_value_info: bool) -> ModelProto {
		let weight: Vec<f32> = (0..6).map(|i| i as f32 * 0.25 - 0.5).collect();
		let mut graph = GraphProto {
			node: vec![
				node("Gemm", &["x", "w", "b"], &["y"], "gemm"),
				node("Gather", &["table", "ids"], &["looked_up"], "gather"),
				node("Add", &["looked_up", "y"], &["z"], "add"),
			],
			initializer: vec![
				raw_tensor(
					"w",
					DataType::Float,
					&[3, 2],
					weight.iter().flat_map(|v| v.to_le_bytes()).collect(),
				),
				raw_tensor(
					"b",
					DataType::Float,
					&[3],
					[0.1f32, 0.2, 0.3].iter().flat_map(|v| v.to_le_bytes()).collect(),
				),
				raw_tensor(
					"table",
					DataType::Float,
					&[4, 3],
					(0..12).flat_map(|i| (i as f32).to_le_bytes()).collect(),
				),
			],
			input: vec![
				value_info("x", DataType::Float, &[Dim::Fixed(1), Dim::Fixed(2)]),
				value_info("ids", DataType::Int64, &[Dim::Fixed(1)]),
			],
			output: vec![value_info("z", DataType::Float, &[Dim::Fixed(1), Dim::Fixed(3)])],
			..Default::default()
		};
		graph.node[0].attribute.push(AttributeProto {
			name: Some("transB".into()),
			r#type: Some(AttributeType::Int as i32),
			i: Some(1),
			..Default::default()
		});
		if stale_value_info {
			// An annotation onnx's shape inference would reject: `y` is [1, 3], not [7].
			graph
				.value_info
				.push(value_info("y", DataType::Float, &[Dim::Fixed(7)]));
		}
		ModelProto {
			ir_version: Some(10),
			opset_import: vec![crate::onnx::OperatorSetIdProto {
				domain: Some(String::new()),
				version: Some(17),
			}],
			graph: Some(graph),
			..Default::default()
		}
	}

	#[test]
	fn rewrites_gemm_and_quantizes_matmul_and_gather() {
		let model = quantize_dynamic_qint8(tiny_model(false)).unwrap();
		let graph = model.graph.unwrap();
		let ops: Vec<&str> = graph.node.iter().filter_map(|n| n.op_type.as_deref()).collect();
		assert_eq!(
			ops,
			[
				"DynamicQuantizeLinear",
				"MatMulInteger",
				"Cast",
				"Mul",
				"Mul",
				"Add",
				"Gather",
				"DequantizeLinear",
				"Add"
			]
		);
		let w = graph
			.initializer
			.iter()
			.find(|t| t.name.as_deref() == Some("w_quantized"))
			.unwrap();
		assert_eq!(w.dims, [2, 3], "the transB weight is stored transposed");
		assert_eq!(w.data_type, Some(INT8));
		let table = graph
			.initializer
			.iter()
			.find(|t| t.name.as_deref() == Some("table_quantized"))
			.unwrap();
		assert_eq!(table.data_type, Some(UINT8));
		assert!(
			graph.initializer.iter().all(|t| t.name.as_deref() != Some("w")),
			"the float weight is dropped"
		);
	}

	#[test]
	fn a_stale_value_info_annotation_is_stripped_rather_than_failing() {
		let clean = quantize_dynamic_qint8(tiny_model(false)).unwrap();
		let stale = quantize_dynamic_qint8(tiny_model(true)).unwrap();
		assert_eq!(clean, stale);
		let graph = stale.graph.unwrap();
		let y = graph
			.value_info
			.iter()
			.find(|v| v.name.as_deref() == Some("y"))
			.expect("y is annotated");
		assert_eq!(
			y,
			&value_info("y", DataType::Float, &[Dim::Fixed(1), Dim::Fixed(3)]),
			"the inferred shape replaces [7]"
		);
	}

	#[test]
	fn refuses_an_operator_it_does_not_implement() {
		let mut model = tiny_model(false);
		model
			.graph
			.as_mut()
			.unwrap()
			.node
			.push(node("Conv", &["x", "w"], &["c"], "conv"));
		let error = quantize_dynamic_qint8(model).unwrap_err();
		assert!(error.0.contains("Conv"), "{error}");
	}
}
