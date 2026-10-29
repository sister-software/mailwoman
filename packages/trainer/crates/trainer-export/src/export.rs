//! Writes the coarse encoder's forward pass as an opset-17 ONNX graph.
//!
//! The graph computes `MailwomanCoarseEncoder.forward` in eval mode (every dropout is the identity) for the channel
//! combination the checkpoint was trained with, behind the inputs that `export/graph.py::build_export_graph` declares
//! for it. Each step uses the operator sequence the dynamo exporter emits for the same PyTorch operation, so that
//! onnxruntime runs the same kernels in the same order:
//!
//! - `nn.Linear` on a rank-3 input is `MatMul` against the transposed weight, then `Add` of the bias; on a rank-2
//!   input it is `Gemm` with `transB = 1`.
//! - `nn.LayerNormalization` is `LayerNormalization` with `epsilon = 1e-5`, `axis = -1` and `stash_type = 1`.
//! - `nn.GELU` is `x * (0.5 * (erf(x / sqrt(2)) + 1))`.
//! - Scaled dot-product attention scales both the query and the transposed key by `head_dim ** -0.25` before their
//!   product, adds the key-padding mask (`-inf` where `attention_mask == 0`), and applies `Softmax` on the last axis.
//! - The char path (`use_char_embed`) reads `char_ids (batch, sequence, window)` in place of `input_ids`, as
//!   `LogitsOnlyChar` declares it, and computes `CharCNNEmbedding` with `Conv`, `Relu`, `Where` and `ReduceMax`.
//!   The window is the training config's `data.max_unit_width`, which the checkpoint does not store, so the caller
//!   passes it in [`ExportOptions`].
//!
//! - The span scorer (`use_span_scorer`) adds the `span_scores` output `[batch, sequence, max_span, types]` from the
//!   classifier's input, with `Pad`, `Slice`, `Concat` and `Tanh` for the shifted end projections.
//!
//! The declared output shapes are the pinned exporter's: dimension 0 of every output is the literal 1, because
//! torch.export specializes the traced batch of one inside the attention blocks. The computation here does not
//! specialize it; see the F2 record in `docs/engineering/reference/2026-10-29-python-removal-plan.mdx`.

use std::path::Path;

use crate::checkpoint::{read_checkpoint, StateDict};
use crate::config::ModelConfig;
use crate::graph::{attr_float, attr_int, attr_ints, value_info, Dim, GraphBuilder};
use crate::onnx::tensor_proto::DataType;
use crate::onnx::{GraphProto, ModelProto, OperatorSetIdProto};
use crate::{fail, Result};

/// The opset the Python exporter targets (`export_to_onnx(opset=17)`).
pub const OPSET: i64 = 17;

/// The IR version torch 2.12.0's exporter writes for opset 17.
pub const IR_VERSION: i64 = 10;

/// `nn.LayerNorm`'s default epsilon, as the float32 the graph stores.
const LAYER_NORM_EPSILON: f32 = 1e-5;

/// The soft-feed channels in the order `build_export_graph` declares their inputs.
const CHANNELS: [&str; 6] = [
	"anchor",
	"gazetteer",
	"country",
	"street_type",
	"locality_surface",
	"code_unit",
];

/// One soft-feed channel the checkpoint enables.
struct Channel {
	prefix: &'static str,
	width: usize,
	/// The per-feature scale applied before the projection: `country_feature_scale`, a buffer the state dict does not
	/// persist, rebuilt from `country_ambiguous_scale`.
	scale: Option<Vec<f32>>,
}

/// The char path's front-end: `CharCNNEmbedding` over `char_ids (batch, sequence, window)`.
struct CharFront {
	/// The config's `max_unit_width`, the declared size of `char_ids`' last axis. The checkpoint does not store it.
	window: usize,
	vocab: usize,
	embed: usize,
	/// Each convolution's kernel size and output channels.
	convs: Vec<(usize, usize)>,
}

/// What the export needs that the checkpoint does not record.
#[derive(Clone, Debug, Default)]
pub struct ExportOptions {
	/// The char path's unit window: the training config's `data.max_unit_width` (`export_to_onnx(char_window=…)`).
	pub char_window: Option<usize>,
}

/// The channel flags read from a checkpoint, as `export/graph.py::detect_channels` reads them from the model.
pub struct Interface {
	char: Option<CharFront>,
	channels: Vec<Channel>,
	locale: bool,
	address_system: bool,
	locale_hint: bool,
	phrase_width: usize,
	span: Option<SpanHead>,
}

/// The span scorer's widths: the projection width, the segment-type count and the longest span.
struct SpanHead {
	dim: usize,
	types: usize,
	max_span: usize,
}

fn enabled(config: &ModelConfig, prefix: &str) -> bool {
	match prefix {
		"anchor" => config.use_postcode_anchor,
		"gazetteer" => config.use_gazetteer_anchor,
		"country" => config.use_country_anchor,
		"street_type" => config.use_street_type_anchor,
		"locality_surface" => config.use_locality_surface_anchor,
		"code_unit" => config.use_code_unit_anchor,
		_ => false,
	}
}

/// Reads the char path's convolutions from the checkpoint and refuses a char model without its window.
fn char_front(config: &ModelConfig, state: &StateDict, options: &ExportOptions) -> Result<CharFront> {
	let window = match options.char_window {
		Some(w) if w > 0 => w,
		_ => {
			return Err(fail!(
				"a char-path model needs char_window (the config's data.max_unit_width) to export"
			))
		}
	};
	let table = state.shape("char_cnn.char_embeddings.weight")?;
	let [vocab, embed] = table else {
		return Err(fail!("char_cnn.char_embeddings.weight has shape {table:?}"));
	};
	if config.char_vocab_size != 0 && config.char_vocab_size != *vocab {
		return Err(fail!(
			"char_cnn.char_embeddings.weight has {vocab} rows, config char_vocab_size is {}",
			config.char_vocab_size
		));
	}
	let mut convs = Vec::new();
	for (i, k) in config.char_kernel_sizes.iter().enumerate() {
		let shape = state.shape(&format!("char_cnn.convs.{i}.weight"))?;
		match shape {
			[out, inp, kernel] if inp == embed && kernel == k => convs.push((*k, *out)),
			_ => {
				return Err(fail!(
					"char_cnn.convs.{i}.weight has shape {shape:?}, expected [out, {embed}, {k}]"
				))
			}
		}
	}
	if convs.is_empty() {
		return Err(fail!("config char_kernel_sizes is empty"));
	}
	Ok(CharFront {
		window,
		vocab: *vocab,
		embed: *embed,
		convs,
	})
}

/// Reads the interface and refuses a combination the Python exporter refuses or this writer does not build.
pub fn interface(config: &ModelConfig, state: &StateDict, options: &ExportOptions) -> Result<Interface> {
	let unsupported = [
		(config.use_affix_head, "use_affix_head"),
		(config.use_deploc_head, "use_deploc_head"),
		(config.inject_first_token, "inject_first_token"),
	];
	if let Some((_, what)) = unsupported.iter().find(|(on, _)| *on) {
		return Err(fail!(
			"the Rust exporter does not build {what} yet; export it with corpus-python's exporter"
		));
	}

	let hidden = config.hidden_size;
	let mut channels = Vec::new();
	for prefix in CHANNELS {
		if !enabled(config, prefix) {
			continue;
		}
		let shape = state.shape(&format!("{prefix}_projection.weight"))?;
		let [rows, width] = shape else {
			return Err(fail!("{prefix}_projection.weight has shape {shape:?}"));
		};
		if *rows != hidden {
			return Err(fail!(
				"{prefix}_projection.weight has {rows} rows, expected hidden_size {hidden}"
			));
		}
		let scale = (prefix == "country").then(|| {
			let mut scale = vec![1.0f32; *width];
			if *width >= 2 {
				scale[1] = config.country_ambiguous_scale;
			}
			scale
		});
		channels.push(Channel {
			prefix,
			width: *width,
			scale,
		});
	}

	let has = |p: &str| channels.iter().any(|c| c.prefix == p);
	let bundle = has("street_type") || has("locality_surface");
	let locale_hint = config.use_locale_hint;
	let char = if config.use_char_embed {
		// The char path is channel-free by interface: `LogitsOnlyChar` declares `char_ids` and `attention_mask` only.
		// The Python exporter would drop a trained channel's inputs from such a graph; this writer refuses instead.
		if let Some(channel) = channels.first() {
			return Err(fail!(
				"a char-path model exports behind char_ids and attention_mask only; it also enables the {} channel",
				channel.prefix
			));
		}
		if locale_hint {
			return Err(fail!("use_locale_hint is only exportable on the full evidence bundle"));
		}
		Some(char_front(config, state, options)?)
	} else {
		None
	};
	if has("code_unit") && !(bundle && locale_hint) {
		return Err(fail!(
			"use_code_unit_anchor is only exportable on the hinted evidence bundle"
		));
	}
	if locale_hint && !bundle {
		return Err(fail!("use_locale_hint is only exportable on the full evidence bundle"));
	}
	if has("country") && !(has("anchor") && has("gazetteer")) {
		return Err(fail!(
			"use_country_anchor is only exportable alongside the anchor + gazetteer channels"
		));
	}
	if bundle && !CHANNELS[..5].iter().all(|p| has(p)) {
		return Err(fail!(
			"the evidence bundle is only exportable as both channels on top of anchor+gazetteer+country"
		));
	}

	let span = if config.use_span_scorer {
		let shape = state.shape("span_scorer.start_proj.weight")?;
		let [dim, cols] = shape else {
			return Err(fail!("span_scorer.start_proj.weight has shape {shape:?}"));
		};
		if *cols != hidden {
			return Err(fail!(
				"span_scorer.start_proj.weight has {cols} columns, expected hidden_size {hidden}"
			));
		}
		let shape = state.shape("span_scorer.type_out.weight")?;
		let [types, _] = shape else {
			return Err(fail!("span_scorer.type_out.weight has shape {shape:?}"));
		};
		if config.max_span == 0 {
			return Err(fail!("config max_span is 0"));
		}
		Some(SpanHead {
			dim: *dim,
			types: *types,
			max_span: config.max_span,
		})
	} else {
		None
	};

	let phrase_width = if config.use_phrase_priors {
		let shape = state.shape("phrase_input_projection.weight")?;
		match shape {
			[rows, cols] if *rows == hidden && *cols > hidden => cols - hidden,
			_ => return Err(fail!("phrase_input_projection.weight has shape {shape:?}")),
		}
	} else {
		0
	};

	Ok(Interface {
		char,
		channels,
		locale: config.use_locale_conditioning,
		address_system: config.use_address_system_head,
		locale_hint,
		phrase_width,
		span,
	})
}

/// `weight` [out, in] transposed to [in, out], the right-hand side of a `MatMul`.
fn transposed(weight: &[f32], out: usize, inp: usize) -> Vec<f32> {
	let mut t = vec![0.0f32; weight.len()];
	for o in 0..out {
		for i in 0..inp {
			t[i * out + o] = weight[o * inp + i];
		}
	}
	t
}

struct Writer<'a> {
	g: GraphBuilder,
	state: &'a StateDict,
	hidden: usize,
}

impl Writer<'_> {
	fn param(&mut self, name: &str, shape: &[usize]) -> Result<String> {
		let data = self.state.f32(name, shape)?;
		let dims: Vec<i64> = shape.iter().map(|d| *d as i64).collect();
		Ok(self.g.f32(name, &dims, data))
	}

	/// `nn.Linear` on a rank-3 input: `MatMul` with the transposed weight, then `Add` of the bias.
	fn linear3(&mut self, x: &str, prefix: &str, out: usize, inp: usize, hint: &str) -> Result<String> {
		let weight = self.state.f32(&format!("{prefix}.weight"), &[out, inp])?;
		let wt = transposed(weight, out, inp);
		let wt = self
			.g
			.f32(&format!("{prefix}.weight.T"), &[inp as i64, out as i64], &wt);
		let bias = self.param(&format!("{prefix}.bias"), &[out])?;
		let product = self.g.op("MatMul", &[x, &wt], vec![], &format!("{hint}.matmul"));
		Ok(self.g.op("Add", &[&product, &bias], vec![], hint))
	}

	/// `nn.Linear` on a rank-2 input: `Gemm(x, W, b, transB=1)`.
	fn gemm(&mut self, x: &str, prefix: &str, out: usize, inp: usize, output: Option<&str>) -> Result<String> {
		let weight = self.param(&format!("{prefix}.weight"), &[out, inp])?;
		let bias = self.param(&format!("{prefix}.bias"), &[out])?;
		let attrs = vec![
			attr_float("alpha", 1.0),
			attr_float("beta", 1.0),
			attr_int("transA", 0),
			attr_int("transB", 1),
		];
		Ok(match output {
			Some(name) => {
				self.g.op_into("Gemm", &[x, &weight, &bias], attrs, name);
				name.to_owned()
			}
			None => self.g.op("Gemm", &[x, &weight, &bias], attrs, prefix),
		})
	}

	fn layer_norm(&mut self, x: &str, prefix: &str) -> Result<String> {
		let weight = self.param(&format!("{prefix}.weight"), &[self.hidden])?;
		let bias = self.param(&format!("{prefix}.bias"), &[self.hidden])?;
		let attrs = vec![
			attr_int("axis", -1),
			attr_float("epsilon", LAYER_NORM_EPSILON),
			attr_int("stash_type", 1),
		];
		Ok(self.g.op("LayerNormalization", &[x, &weight, &bias], attrs, prefix))
	}

	fn unsqueeze(&mut self, x: &str, axes: &[i64], hint: &str) -> String {
		let axes = self.g.ints(axes);
		self.g.op("Unsqueeze", &[x, &axes], vec![], hint)
	}

	/// One pre-norm block of `nn/blocks.py::EncoderBlock`.
	fn block(&mut self, x: &str, layer: usize, heads: usize, intermediate: usize, mask: &str) -> Result<String> {
		let e = self.hidden;
		let d = e / heads;
		let p = format!("blocks.{layer}");

		let h = self.layer_norm(x, &format!("{p}.ln1"))?;
		let in_weight = self.state.f32(&format!("{p}.attn.in_proj_weight"), &[3 * e, e])?;
		let in_weight = transposed(in_weight, 3 * e, e);
		let in_weight = self.g.f32(
			&format!("{p}.attn.in_proj_weight.T"),
			&[e as i64, 3 * e as i64],
			&in_weight,
		);
		let in_bias = self.param(&format!("{p}.attn.in_proj_bias"), &[3 * e])?;
		let qkv = self
			.g
			.op("MatMul", &[&h, &in_weight], vec![], &format!("{p}.attn.qkv.matmul"));
		let qkv = self.g.op("Add", &[&qkv, &in_bias], vec![], &format!("{p}.attn.qkv"));

		// [B, S, 3E] -> [B, S, 3, H, D] -> [3, B, H, S, D], then q, k and v by index along the first axis.
		let split_shape = self.g.ints(&[0, 0, 3, heads as i64, d as i64]);
		let qkv = self
			.g
			.op("Reshape", &[&qkv, &split_shape], vec![], &format!("{p}.attn.qkv.heads"));
		let qkv = self.g.op(
			"Transpose",
			&[&qkv],
			vec![attr_ints("perm", &[2, 0, 3, 1, 4])],
			&format!("{p}.attn.qkv.t"),
		);
		let mut parts = Vec::new();
		for (index, name) in ["q", "k", "v"].iter().enumerate() {
			let i = self.g.scalar_i64(index as i64);
			parts.push(self.g.op(
				"Gather",
				&[&qkv, &i],
				vec![attr_int("axis", 0)],
				&format!("{p}.attn.{name}"),
			));
		}
		let key_t = self.g.op(
			"Transpose",
			&[&parts[1]],
			vec![attr_ints("perm", &[0, 1, 3, 2])],
			&format!("{p}.attn.k.t"),
		);
		let scale = self
			.g
			.f32("attn.sqrt_scale", &[1], &[(1.0f64 / (d as f64).sqrt()).sqrt() as f32]);
		let query = self
			.g
			.op("Mul", &[&parts[0], &scale], vec![], &format!("{p}.attn.q.scaled"));
		let key_t = self
			.g
			.op("Mul", &[&key_t, &scale], vec![], &format!("{p}.attn.k.scaled"));
		let scores = self
			.g
			.op("MatMul", &[&query, &key_t], vec![], &format!("{p}.attn.scores"));
		let scores = self
			.g
			.op("Add", &[&scores, mask], vec![], &format!("{p}.attn.scores.masked"));
		let weights = self.g.op(
			"Softmax",
			&[&scores],
			vec![attr_int("axis", -1)],
			&format!("{p}.attn.weights"),
		);
		let context = self
			.g
			.op("MatMul", &[&weights, &parts[2]], vec![], &format!("{p}.attn.context"));

		// [B, H, S, D] -> [B, S, H, D] -> [B * S, E] for the output projection's Gemm, then back to [B, S, E].
		let context = self.g.op(
			"Transpose",
			&[&context],
			vec![attr_ints("perm", &[0, 2, 1, 3])],
			&format!("{p}.attn.context.t"),
		);
		let rows = self.g.ints(&[-1, e as i64]);
		let context = self
			.g
			.op("Reshape", &[&context, &rows], vec![], &format!("{p}.attn.context.rows"));
		let projected = self.gemm(&context, &format!("{p}.attn.out_proj"), e, e, None)?;
		let x_shape = self.g.op("Shape", &[x], vec![], &format!("{p}.shape"));
		let projected = self
			.g
			.op("Reshape", &[&projected, &x_shape], vec![], &format!("{p}.attn.out"));
		let x = self
			.g
			.op("Add", &[x, &projected], vec![], &format!("{p}.attn.residual"));

		let h = self.layer_norm(&x, &format!("{p}.ln2"))?;
		let f = self.linear3(&h, &format!("{p}.ff.0"), intermediate, e, &format!("{p}.ff.0"))?;
		let root2 = self.g.scalar_f32(std::f32::consts::SQRT_2);
		let one = self.g.scalar_f32(1.0);
		let half = self.g.scalar_f32(0.5);
		let scaled = self.g.op("Div", &[&f, &root2], vec![], &format!("{p}.gelu.div"));
		let erf = self.g.op("Erf", &[&scaled], vec![], &format!("{p}.gelu.erf"));
		let erf = self.g.op("Add", &[&erf, &one], vec![], &format!("{p}.gelu.add"));
		let factor = self.g.op("Mul", &[&half, &erf], vec![], &format!("{p}.gelu.factor"));
		let gelu = self.g.op("Mul", &[&f, &factor], vec![], &format!("{p}.gelu"));
		let f = self.linear3(&gelu, &format!("{p}.ff.3"), e, intermediate, &format!("{p}.ff.3"))?;
		Ok(self.g.op("Add", &[&x, &f], vec![], &format!("{p}.ff.residual")))
	}
}

impl Writer<'_> {
	/// `CharCNNEmbedding.forward` in eval mode: each unit's vector from its character window, `[B, S, hidden]`.
	///
	/// The window's characters are embedded and convolved per kernel size (`padding = k // 2`, clipped back to the
	/// window), the padding characters are set to `-1e4` after the ReLU, and each channel keeps its maximum over the
	/// window. The concatenated maxima pass through `proj`.
	fn char_front(&mut self, front: &CharFront, batch_seq: &str) -> Result<String> {
		let w = front.window as i64;
		let rows = self.g.ints(&[-1, w]);
		let flat = self.g.op("Reshape", &["char_ids", &rows], vec![], "char_ids.rows");
		let table = self.param("char_cnn.char_embeddings.weight", &[front.vocab, front.embed])?;
		let embedded = self.g.op(
			"Gather",
			&[&table, &flat],
			vec![attr_int("axis", 0)],
			"char_cnn.embedded",
		);
		let x = self.g.op(
			"Transpose",
			&[&embedded],
			vec![attr_ints("perm", &[0, 2, 1])],
			"char_cnn.channels",
		);
		let pad = self.g.scalar_i64(0);
		let padded = self.g.op("Equal", &[&flat, &pad], vec![], "char_cnn.padding");
		let padded = self.unsqueeze(&padded, &[1], "char_cnn.padding.row");
		let floor = self.g.scalar_f32(-1e4);
		let (start, end, axis) = (self.g.ints(&[0]), self.g.ints(&[w]), self.g.ints(&[2]));
		let mut features = Vec::new();
		let mut width = 0;
		for (i, (k, out)) in front.convs.iter().enumerate() {
			let p = format!("char_cnn.convs.{i}");
			let weight = self.param(&format!("{p}.weight"), &[*out, front.embed, *k])?;
			let bias = self.param(&format!("{p}.bias"), &[*out])?;
			let half = (*k / 2) as i64;
			let conv = self.g.op(
				"Conv",
				&[&x, &weight, &bias],
				vec![
					attr_ints("dilations", &[1]),
					attr_int("group", 1),
					attr_ints("kernel_shape", &[*k as i64]),
					attr_ints("pads", &[half, half]),
					attr_ints("strides", &[1]),
				],
				&p,
			);
			let relu = self.g.op("Relu", &[&conv], vec![], &format!("{p}.relu"));
			let clipped = self
				.g
				.op("Slice", &[&relu, &start, &end, &axis], vec![], &format!("{p}.window"));
			let masked = self
				.g
				.op("Where", &[&padded, &floor, &clipped], vec![], &format!("{p}.masked"));
			features.push(self.g.op(
				"ReduceMax",
				&[&masked],
				vec![attr_ints("axes", &[2]), attr_int("keepdims", 0)],
				&format!("{p}.max"),
			));
			width += out;
		}
		let refs: Vec<&str> = features.iter().map(String::as_str).collect();
		let joined = self
			.g
			.op("Concat", &refs, vec![attr_int("axis", -1)], "char_cnn.features");
		let projected = self.gemm(&joined, "char_cnn.proj", self.hidden, width, None)?;
		let hidden = self.g.ints(&[self.hidden as i64]);
		let shape = self.g.op(
			"Concat",
			&[batch_seq, &hidden],
			vec![attr_int("axis", 0)],
			"char_cnn.shape",
		);
		Ok(self.g.op("Reshape", &[&projected, &shape], vec![], "char_embedding"))
	}
}

impl Writer<'_> {
	/// `SpanScorer.forward`: `type_out(tanh(start_proj(h)[:, i] + end_proj(h)[:, i + l]))` for every start `i` and
	/// length offset `l`, as `[B, S, max_span, types]`.
	///
	/// The end projections are padded with `max_span - 1` zero rows after the sequence, as `F.pad` pads them, and the
	/// window for offset `l` is rows `l .. l + S` of the padded tensor.
	fn span_scores(&mut self, h: &str, span: &SpanHead, seq_dim: &str) -> Result<()> {
		let (e, d, l) = (self.hidden, span.dim, span.max_span as i64);
		let starts = self.linear3(h, "span_scorer.start_proj", d, e, "span.starts")?;
		let ends = self.linear3(h, "span_scorer.end_proj", d, e, "span.ends")?;
		let pads = self.g.ints(&[0, 0, 0, 0, l - 1, 0]);
		let padded = self.g.op("Pad", &[&ends, &pads], vec![], "span.ends.padded");
		let axis = self.g.ints(&[1]);
		let mut windows = Vec::new();
		for offset in 0..l {
			let begin = self.g.ints(&[offset]);
			let end = self
				.g
				.op("Add", &[seq_dim, &begin], vec![], &format!("span.window{offset}.end"));
			let window = self.g.op(
				"Slice",
				&[&padded, &begin, &end, &axis],
				vec![],
				&format!("span.window{offset}"),
			);
			windows.push(self.unsqueeze(&window, &[2], &format!("span.window{offset}.column")));
		}
		let refs: Vec<&str> = windows.iter().map(String::as_str).collect();
		let shifted = self.g.op("Concat", &refs, vec![attr_int("axis", 2)], "span.shifted");
		let starts = self.unsqueeze(&starts, &[2], "span.starts.column");
		let summed = self.g.op("Add", &[&starts, &shifted], vec![], "span.summed");
		let activated = self.g.op("Tanh", &[&summed], vec![], "span.tanh");
		let weight = self.state.f32("span_scorer.type_out.weight", &[span.types, d])?;
		let wt = transposed(weight, span.types, d);
		let wt = self
			.g
			.f32("span_scorer.type_out.weight.T", &[d as i64, span.types as i64], &wt);
		let bias = self.param("span_scorer.type_out.bias", &[span.types])?;
		let product = self.g.op("MatMul", &[&activated, &wt], vec![], "span.type_out.matmul");
		self.g.op_into("Add", &[&product, &bias], vec![], "span_scores");
		Ok(())
	}
}

/// Builds the ONNX model for a checkpoint already read.
pub fn build_model(config: &ModelConfig, state: &StateDict, options: &ExportOptions) -> Result<ModelProto> {
	let iface = interface(config, state, options)?;
	let e = config.hidden_size;
	if config.num_attention_heads == 0 || !e.is_multiple_of(config.num_attention_heads) {
		return Err(fail!(
			"hidden_size {e} is not divisible by num_attention_heads {}",
			config.num_attention_heads
		));
	}
	let labels = config.labels()?;
	if !labels.is_empty() && labels.len() != config.num_labels {
		return Err(fail!(
			"config id2label has {} labels, num_labels is {}",
			labels.len(),
			config.num_labels
		));
	}

	let mut w = Writer {
		g: GraphBuilder::default(),
		state,
		hidden: e,
	};
	let batch = || Dim::Param("batch".into());
	let sequence = || Dim::Param("sequence".into());

	// The char path reads no token ids: an `input_ids` input would bind the runtime to a vocabulary the model lacks.
	let units = match &iface.char {
		Some(front) => value_info(
			"char_ids",
			DataType::Int64,
			&[batch(), sequence(), Dim::Fixed(front.window as i64)],
		),
		None => value_info("input_ids", DataType::Int64, &[batch(), sequence()]),
	};
	let units_name = units.name.clone().unwrap_or_default();
	let mut inputs = vec![
		units,
		value_info("attention_mask", DataType::Int64, &[batch(), sequence()]),
	];
	for channel in &iface.channels {
		let width = Dim::Fixed(channel.width as i64);
		inputs.push(value_info(
			&format!("{}_features", channel.prefix),
			DataType::Float,
			&[batch(), sequence(), width],
		));
		inputs.push(value_info(
			&format!("{}_confidence", channel.prefix),
			DataType::Float,
			&[batch(), sequence()],
		));
	}
	if iface.locale_hint {
		inputs.push(value_info("locale_hint", DataType::Int64, &[batch()]));
	}
	for input in &inputs {
		w.g.reserve(input.name.as_deref().unwrap_or_default());
	}

	// The token (or character-window) and position embeddings. The token path's node order is the one F2 measured.
	let token_gather = |w: &mut Writer| -> Result<String> {
		let token_table = w.param("token_embeddings.weight", &[config.vocab_size, e])?;
		Ok(w.g.op(
			"Gather",
			&[&token_table, "input_ids"],
			vec![attr_int("axis", 0)],
			"embedding",
		))
	};
	let mut tokens = match iface.char {
		Some(_) => String::new(),
		None => token_gather(&mut w)?,
	};
	let batch_dim = w.g.op(
		"Shape",
		&[&units_name],
		vec![attr_int("start", 0), attr_int("end", 1)],
		"batch_dim",
	);
	let seq_dim = w.g.op(
		"Shape",
		&[&units_name],
		vec![attr_int("start", 1), attr_int("end", 2)],
		"sequence_dim",
	);
	let mut batch_seq = String::new();
	if let Some(front) = &iface.char {
		batch_seq = w.g.op(
			"Concat",
			&[&batch_dim, &seq_dim],
			vec![attr_int("axis", 0)],
			"batch_sequence",
		);
		tokens = w.char_front(front, &batch_seq)?;
	}
	let seq_len = w.g.op("Squeeze", &[&seq_dim], vec![], "sequence_len");
	let zero = w.g.scalar_i64(0);
	let step = w.g.scalar_i64(1);
	let positions = w.g.op("Range", &[&zero, &seq_len, &step], vec![], "positions");
	let positions = w.unsqueeze(&positions, &[0], "positions.row");
	if iface.char.is_none() {
		batch_seq = w.g.op(
			"Concat",
			&[&batch_dim, &seq_dim],
			vec![attr_int("axis", 0)],
			"batch_sequence",
		);
	}
	let positions = w.g.op("Expand", &[&positions, &batch_seq], vec![], "position_ids");
	let position_table = w.param("position_embeddings.weight", &[config.max_position_embeddings, e])?;
	let positions = w.g.op(
		"Gather",
		&[&position_table, &positions],
		vec![attr_int("axis", 0)],
		"position_embedding",
	);
	let mut h = w.g.op("Add", &[&tokens, &positions], vec![], "embedded");

	// The phrase-prior projection reads zeros: the export interface feeds no phrase features.
	if iface.phrase_width > 0 {
		let width = w.g.ints(&[iface.phrase_width as i64]);
		let shape = w.g.op(
			"Concat",
			&[&batch_dim, &seq_dim, &width],
			vec![attr_int("axis", 0)],
			"phrase_features.shape",
		);
		let zero_f = w.g.scalar_f32(0.0);
		let zeros = w.g.op("Expand", &[&zero_f, &shape], vec![], "phrase_features");
		let joined =
			w.g.op("Concat", &[&h, &zeros], vec![attr_int("axis", -1)], "phrase_input");
		h = w.linear3(
			&joined,
			"phrase_input_projection",
			e,
			e + iface.phrase_width,
			"phrase_projected",
		)?;
	}

	// Each channel adds confidence * (W @ features + b + cue).
	for channel in &iface.channels {
		let prefix = channel.prefix;
		let mut features = format!("{prefix}_features");
		if let Some(scale) = &channel.scale {
			let scale = w.g.f32("country_feature_scale", &[scale.len() as i64], scale);
			features = w.g.op(
				"Mul",
				&[&features, &scale],
				vec![],
				&format!("{prefix}_features.scaled"),
			);
		}
		let projected = w.linear3(
			&features,
			&format!("{prefix}_projection"),
			e,
			channel.width,
			&format!("{prefix}.projected"),
		)?;
		let cue = w.param(&format!("{prefix}_token_embedding"), &[e])?;
		let vector = w.g.op("Add", &[&projected, &cue], vec![], &format!("{prefix}.vector"));
		let confidence = w.unsqueeze(&format!("{prefix}_confidence"), &[-1], &format!("{prefix}.confidence"));
		let signal =
			w.g.op("Mul", &[&confidence, &vector], vec![], &format!("{prefix}.signal"));
		h = w.g.op("Add", &[&h, &signal], vec![], &format!("{prefix}.added"));
	}
	h = w.layer_norm(&h, "input_ln")?;

	if iface.locale_hint {
		let systems = config.num_address_systems + 1;
		let table = w.param("locale_hint_embedding.weight", &[systems, e])?;
		let hint = w.g.op(
			"Gather",
			&[&table, "locale_hint"],
			vec![attr_int("axis", 0)],
			"locale_hint.embedding",
		);
		let hint = w.unsqueeze(&hint, &[1], "locale_hint.row");
		h = w.g.op("Add", &[&h, &hint], vec![], "hinted");
	}

	// The key-padding mask, [B, 1, 1, S], added to every head's scores.
	let padded = w.g.op("Equal", &["attention_mask", &zero], vec![], "padding");
	let minus_inf = w.g.scalar_f32(f32::NEG_INFINITY);
	let zero_f = w.g.scalar_f32(0.0);
	let mask =
		w.g.op("Where", &[&padded, &minus_inf, &zero_f], vec![], "padding.additive");
	let mask = w.unsqueeze(&mask, &[1, 2], "padding.mask");

	for layer in 0..config.num_hidden_layers {
		h = w.block(&h, layer, config.num_attention_heads, config.intermediate_size, &mask)?;
	}
	h = w.layer_norm(&h, "final_ln")?;

	let mut outputs = vec![value_info(
		"logits",
		DataType::Float,
		&[Dim::Fixed(1), sequence(), Dim::Fixed(config.num_labels as i64)],
	)];
	if iface.locale || iface.address_system {
		// The masked mean over the sequence: sum(h * m) / max(sum(m), 1).
		let m = w.g.op(
			"Cast",
			&["attention_mask"],
			vec![attr_int("to", DataType::Float as i64)],
			"mask.float",
		);
		let m = w.unsqueeze(&m, &[-1], "mask.column");
		let masked = w.g.op("Mul", &[&h, &m], vec![], "pool.masked");
		let axis = w.g.ints(&[1]);
		let attrs = || vec![attr_int("keepdims", 0), attr_int("noop_with_empty_axes", 0)];
		let total = w.g.op("ReduceSum", &[&masked, &axis], attrs(), "pool.sum");
		let count = w.g.op("ReduceSum", &[&m, &axis], attrs(), "pool.count");
		let one = w.g.scalar_f32(1.0);
		let count = w.g.op("Clip", &[&count, &one], vec![], "pool.count.clamped");
		let pooled = w.g.op("Div", &[&total, &count], vec![], "pooled");

		if iface.address_system {
			let n = config.num_address_systems;
			w.gemm(&pooled, "address_system_head", n, e, Some("address_system_logits"))?;
			outputs.push(value_info(
				"address_system_logits",
				DataType::Float,
				&[Dim::Fixed(1), Dim::Fixed(n as i64)],
			));
		}
		if iface.locale {
			let n = w.state.shape("locale_head.weight")?.first().copied().unwrap_or(0);
			if let Some(declared) = config.num_locales {
				if declared != n {
					return Err(fail!(
						"locale_head.weight has {n} rows, config num_locales is {declared}"
					));
				}
			}
			w.gemm(&pooled, "locale_head", n, e, Some("locale_logits"))?;
			outputs.insert(
				1,
				value_info("locale_logits", DataType::Float, &[Dim::Fixed(1), Dim::Fixed(n as i64)]),
			);

			// FiLM: h = (1 + gamma) * h + beta, gamma and beta the two halves of locale_film(pooled).
			let film = w.gemm(&pooled, "locale_film", 2 * e, e, None)?;
			let (start, middle, end, axes, steps) = (
				w.g.ints(&[0]),
				w.g.ints(&[e as i64]),
				w.g.ints(&[i64::MAX]),
				w.g.ints(&[1]),
				w.g.ints(&[1]),
			);
			let gamma =
				w.g.op("Slice", &[&film, &start, &middle, &axes, &steps], vec![], "film.gamma");
			let beta =
				w.g.op("Slice", &[&film, &middle, &end, &axes, &steps], vec![], "film.beta");
			let gamma = w.g.op("Add", &[&gamma, &one], vec![], "film.gain");
			let gamma = w.unsqueeze(&gamma, &[1], "film.gain.row");
			let beta = w.unsqueeze(&beta, &[1], "film.beta.row");
			let scaled = w.g.op("Mul", &[&gamma, &h], vec![], "film.scaled");
			h = w.g.op("Add", &[&scaled, &beta], vec![], "film");
		}
	}

	let weight = w.state.f32("classifier.weight", &[config.num_labels, e])?;
	let wt = transposed(weight, config.num_labels, e);
	let wt =
		w.g.f32("classifier.weight.T", &[e as i64, config.num_labels as i64], &wt);
	let bias = w.param("classifier.bias", &[config.num_labels])?;
	let product = w.g.op("MatMul", &[&h, &wt], vec![], "classifier.matmul");
	w.g.op_into("Add", &[&product, &bias], vec![], "logits");

	// The span scores read the classifier's input. They come after `locale_logits` and before
	// `address_system_logits`, as `PlainOutputs._outputs` orders them.
	if let Some(span) = &iface.span {
		w.span_scores(&h, span, &seq_dim)?;
		outputs.insert(
			1 + usize::from(iface.locale),
			value_info(
				"span_scores",
				DataType::Float,
				&[
					Dim::Fixed(1),
					sequence(),
					Dim::Fixed(span.max_span as i64),
					Dim::Fixed(span.types as i64),
				],
			),
		);
	}

	let mut graph = GraphProto {
		node: w.g.nodes,
		name: Some("mailwoman_coarse_encoder".into()),
		initializer: w.g.initializers,
		input: inputs,
		output: outputs,
		..Default::default()
	};
	// The intermediate shapes, which onnxruntime's optimizer reads, as the dynamo exporter writes its own.
	crate::shape::annotate(&mut graph);
	Ok(ModelProto {
		ir_version: Some(IR_VERSION),
		opset_import: vec![OperatorSetIdProto {
			domain: Some(String::new()),
			version: Some(OPSET),
		}],
		producer_name: Some("mailwoman-trainer-export".into()),
		producer_version: Some(env!("CARGO_PKG_VERSION").into()),
		graph: Some(graph),
		..Default::default()
	})
}

/// Reads `<checkpoint>/config.json` and the checkpoint's weights (`model.safetensors` or `pytorch_model.bin`) and
/// builds the model.
pub fn export_checkpoint(checkpoint: &Path, options: &ExportOptions) -> Result<ModelProto> {
	let config = ModelConfig::read(&checkpoint.join("config.json"))?;
	let state = read_checkpoint(checkpoint)?;
	build_model(&config, &state, options)
}
