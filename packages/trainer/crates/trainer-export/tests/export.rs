//! The exporter and quantizer against fixtures torch 2.12.0 wrote.
//!
//! `fixtures/tiny-bundle` is a `MailwomanCoarseEncoder` with hidden size 8 and one block, built with every channel of
//! the shipped interface (the evidence bundle, the locale head and the locale hint, four address systems) and saved
//! with `save_pretrained`. `reference-fp32.onnx` beside it is that model exported by
//! the Python exporter's `export_to_onnx(opset=17, max_length=16)` with torch 2.12.0 and onnxscript 0.7.2.
//! `fixtures/storages.bin` is `torch.save` of one 2x3 float32 tensor in float32, bfloat16 and float16, its
//! transpose, and a view at storage offset 2. The fixtures were written once with the pinned Python stack; the numeric
//! comparison of full checkpoints is `packages/neural/tools/onnx/export-parity.run.ts`.

use std::path::{Path, PathBuf};

use prost::Message;
use trainer_export::checkpoint::read_state_dict;
use trainer_export::export::{export_checkpoint, ExportOptions};
use trainer_export::onnx::{ModelProto, ValueInfoProto};
use trainer_export::quantize::quantize_dynamic_qint8;
use trainer_export::split::{split_model_file, HotSelection};

fn fixtures() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Each declared tensor's name, element type and dimensions. The dynamo exporter's `metadata_props`
/// (`pkg.torch.onnx.original_node_name`) are provenance notes rather than interface, and are left out.
fn interface(values: &[ValueInfoProto]) -> Vec<String> {
	values.iter().map(|v| format!("{:?} {:?}", v.name, v.r#type)).collect()
}

#[test]
fn the_tiny_bundle_declares_the_pinned_exporters_interface() {
	let ours = export_checkpoint(&fixtures().join("tiny-bundle"), &ExportOptions::default()).unwrap();
	let bytes = std::fs::read(fixtures().join("tiny-bundle/reference-fp32.onnx")).unwrap();
	let reference = ModelProto::decode(bytes.as_slice()).unwrap();
	let (ours_graph, reference_graph) = (ours.graph.as_ref().unwrap(), reference.graph.as_ref().unwrap());

	assert_eq!(
		interface(&ours_graph.input),
		interface(&reference_graph.input),
		"graph inputs"
	);
	assert_eq!(
		interface(&ours_graph.output),
		interface(&reference_graph.output),
		"graph outputs"
	);
	assert_eq!(ours.opset_import, reference.opset_import);
	assert_eq!(ours.ir_version, reference.ir_version);
}

#[test]
fn the_tiny_bundle_quantizes_every_weight_matmul_and_table() {
	let model =
		quantize_dynamic_qint8(export_checkpoint(&fixtures().join("tiny-bundle"), &ExportOptions::default()).unwrap())
			.unwrap();
	let graph = model.graph.unwrap();
	let count = |op: &str| graph.node.iter().filter(|n| n.op_type.as_deref() == Some(op)).count();
	// Phrase projection, five channel projections, per block qkv, out_proj, ff.0 and ff.3, three pooled heads and
	// the classifier: 6 + 4 + 4 = 14. Gemm is gone: the four Gemms became MatMul plus Add.
	assert_eq!(count("MatMulInteger"), 14);
	assert_eq!(count("Gemm"), 0);
	// The token, position and hint tables are read as uint8 and dequantized once each.
	assert_eq!(count("DequantizeLinear"), 3);
	assert!(
		!graph.value_info.is_empty(),
		"the quantized graph carries inferred shapes"
	);
}

#[test]
fn reads_float32_bfloat16_float16_and_strided_views() {
	let state = read_state_dict(&fixtures().join("storages.bin")).unwrap();
	let expected = [0.0, 0.25, 0.5, 0.75, 1.0, 1.25];
	for name in ["float", "bfloat16", "half"] {
		assert_eq!(state.f32(name, &[2, 3]).unwrap(), expected, "{name}");
	}
	assert_eq!(
		state.f32("transposed", &[3, 2]).unwrap(),
		[0.0, 0.75, 0.25, 1.0, 0.5, 1.25]
	);
	assert_eq!(state.f32("offset", &[3]).unwrap(), [0.5, 0.75, 1.0]);
}

#[test]
fn refuses_a_checkpoint_missing_a_tensor() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::copy(
		fixtures().join("tiny-bundle/config.json"),
		dir.path().join("config.json"),
	)
	.unwrap();
	std::fs::copy(fixtures().join("storages.bin"), dir.path().join("pytorch_model.bin")).unwrap();
	let error = export_checkpoint(dir.path(), &ExportOptions::default()).unwrap_err();
	assert!(error.0.contains("has no tensor"), "{error}");
}

/// A char-path checkpoint with hidden size 8, one block, kernels 3, 4 and 5 over a 64-entry character table, and
/// deterministic weights, written as `model.safetensors` the way the Rust trainer writes one.
fn char_checkpoint(dir: &Path) {
	let (hidden, labels, units, chars, embed) = (8usize, 33usize, 16usize, 64usize, 6usize);
	let per_kernel = hidden / 3;
	let mut shapes: Vec<(String, Vec<usize>)> = vec![
		("token_embeddings.weight".into(), vec![2, hidden]),
		("position_embeddings.weight".into(), vec![units, hidden]),
		("input_ln.weight".into(), vec![hidden]),
		("input_ln.bias".into(), vec![hidden]),
		("char_cnn.char_embeddings.weight".into(), vec![chars, embed]),
	];
	for (i, k) in [3usize, 4, 5].iter().enumerate() {
		shapes.push((format!("char_cnn.convs.{i}.weight"), vec![per_kernel, embed, *k]));
		shapes.push((format!("char_cnn.convs.{i}.bias"), vec![per_kernel]));
	}
	shapes.push(("char_cnn.proj.weight".into(), vec![hidden, per_kernel * 3]));
	shapes.push(("char_cnn.proj.bias".into(), vec![hidden]));
	for (name, shape) in [
		("ln1.weight", vec![hidden]),
		("ln1.bias", vec![hidden]),
		("attn.in_proj_weight", vec![3 * hidden, hidden]),
		("attn.in_proj_bias", vec![3 * hidden]),
		("attn.out_proj.weight", vec![hidden, hidden]),
		("attn.out_proj.bias", vec![hidden]),
		("ln2.weight", vec![hidden]),
		("ln2.bias", vec![hidden]),
		("ff.0.weight", vec![16, hidden]),
		("ff.0.bias", vec![16]),
		("ff.3.weight", vec![hidden, 16]),
		("ff.3.bias", vec![hidden]),
	] {
		shapes.push((format!("blocks.0.{name}"), shape));
	}
	shapes.push(("final_ln.weight".into(), vec![hidden]));
	shapes.push(("final_ln.bias".into(), vec![hidden]));
	shapes.push(("classifier.weight".into(), vec![labels, hidden]));
	shapes.push(("classifier.bias".into(), vec![labels]));

	let mut state = 0x2545_f491_4f6c_dd1du64;
	let buffers: Vec<(String, Vec<usize>, Vec<u8>)> = shapes
		.into_iter()
		.map(|(name, shape)| {
			let n: usize = shape.iter().product();
			let bytes = (0..n)
				.flat_map(|_| {
					state ^= state << 13;
					state ^= state >> 7;
					state ^= state << 17;
					((state >> 40) as f32 / (1u64 << 24) as f32 - 0.5).to_le_bytes()
				})
				.collect();
			(name, shape, bytes)
		})
		.collect();
	let views: Vec<(String, safetensors::tensor::TensorView)> = buffers
		.iter()
		.map(|(name, shape, bytes)| {
			let view = safetensors::tensor::TensorView::new(safetensors::Dtype::F32, shape.clone(), bytes).unwrap();
			(name.clone(), view)
		})
		.collect();
	std::fs::write(
		dir.join("model.safetensors"),
		safetensors::serialize(views, None).unwrap(),
	)
	.unwrap();
	let config = serde_json::json!({
		"vocab_size": 2, "hidden_size": hidden, "num_hidden_layers": 1, "num_attention_heads": 2,
		"intermediate_size": 16, "max_position_embeddings": units, "num_labels": labels, "pad_token_id": 0,
		"use_crf": false, "use_char_embed": true, "char_vocab_size": chars, "char_embed_dim": embed,
		"char_kernel_sizes": [3, 4, 5],
	});
	std::fs::write(dir.join("config.json"), config.to_string()).unwrap();
}

#[test]
fn a_char_checkpoint_exports_char_ids_and_no_input_ids() {
	let dir = tempfile::tempdir().unwrap();
	char_checkpoint(dir.path());
	let options = ExportOptions { char_window: Some(7) };
	let model = export_checkpoint(dir.path(), &options).unwrap();
	let graph = model.graph.unwrap();
	let names: Vec<_> = graph.input.iter().map(|v| v.name.clone().unwrap()).collect();
	assert_eq!(names, ["char_ids", "attention_mask"]);
	let dims = |v: &ValueInfoProto| format!("{:?}", v.r#type);
	assert!(
		dims(&graph.input[0]).contains("DimValue(7)"),
		"{}",
		dims(&graph.input[0])
	);
	let outputs: Vec<_> = graph.output.iter().map(|v| v.name.clone().unwrap()).collect();
	assert_eq!(outputs, ["logits"]);
	let count = |op: &str| graph.node.iter().filter(|n| n.op_type.as_deref() == Some(op)).count();
	assert_eq!(count("Conv"), 3);
	assert_eq!(count("ReduceMax"), 3);
	assert!(
		!graph
			.initializer
			.iter()
			.any(|t| t.name.as_deref() == Some("token_embeddings.weight")),
		"the char graph reads no token table"
	);
	// Every char-front tensor carries an inferred shape, the window clipped back to 7 after each convolution.
	assert!(graph
		.value_info
		.iter()
		.any(|v| v.name.as_deref() == Some("char_cnn.convs.1.window") && dims(v).contains("DimValue(7)")));
}

#[test]
fn a_float16_safetensors_tensor_widens_to_float32() {
	let dir = tempfile::tempdir().unwrap();
	// 1.0, -2.0 and 0.5 in IEEE binary16.
	let bytes: Vec<u8> = [0x3c00u16, 0xc000, 0x3800]
		.iter()
		.flat_map(|bits| bits.to_le_bytes())
		.collect();
	let view = safetensors::tensor::TensorView::new(safetensors::Dtype::F16, vec![3], &bytes).unwrap();
	let path = dir.path().join("model.safetensors");
	std::fs::write(&path, safetensors::serialize([("w".to_owned(), view)], None).unwrap()).unwrap();
	let state = trainer_export::checkpoint::read_safetensors(&path).unwrap();
	let tensor = &state.tensors["w"];
	assert_eq!(tensor.storage, "HalfStorage");
	assert_eq!(tensor.data.as_deref(), Some(&[1.0f32, -2.0, 0.5][..]));
}

#[test]
fn a_char_checkpoint_refuses_to_export_without_its_window() {
	let dir = tempfile::tempdir().unwrap();
	char_checkpoint(dir.path());
	let error = export_checkpoint(dir.path(), &ExportOptions::default()).unwrap_err();
	assert!(error.0.contains("char_window"), "{error}");
}

#[test]
fn the_quantizer_rewrites_the_char_paths_convolutions_as_conv_integer() {
	let dir = tempfile::tempdir().unwrap();
	char_checkpoint(dir.path());
	let model = export_checkpoint(dir.path(), &ExportOptions { char_window: Some(7) }).unwrap();
	let convs = count_ops(&model, "Conv");
	assert!(convs > 0, "the char checkpoint exports no Conv node");
	let quantized = quantize_dynamic_qint8(model).unwrap();
	assert_eq!(count_ops(&quantized, "Conv"), 0);
	assert_eq!(count_ops(&quantized, "ConvInteger"), convs);
	let graph = quantized.graph.as_ref().unwrap();
	let bias_adds = graph
		.node
		.iter()
		.filter(|n| {
			n.op_type.as_deref() == Some("Add") && n.name.as_deref().is_some_and(|name| name.ends_with("_bias_add"))
		})
		.count();
	assert_eq!(bias_adds, convs, "each biased Conv adds its bias after the scale");
}

fn count_ops(model: &ModelProto, op: &str) -> usize {
	model
		.graph
		.as_ref()
		.map(|g| g.node.iter().filter(|n| n.op_type.as_deref() == Some(op)).count())
		.unwrap_or(0)
}

fn split_fixture(name: &str) -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("../../../neural/test/fixtures/split-embeddings")
		.join(name)
}

/// `packages/neural/test/fixtures/split-embeddings/` holds a 64 x 8 int8-shaped graph (`model.onnx`) and the three
/// files the Python splitter wrote from it with counts 40, 30, 20 and 10 on ids 5 to 8, coverage 1 and ids 0 to 3
/// always kept. The Rust split of the same graph writes the same bytes.
#[test]
fn the_split_reproduces_the_committed_fixture_byte_for_byte() {
	let bytes = std::fs::read(split_fixture("model.onnx")).unwrap();
	let model = ModelProto::decode(bytes.as_slice()).unwrap();
	let mut counts = vec![0i64; 64];
	counts[5..9].copy_from_slice(&[40, 30, 20, 10]);
	let out = tempfile::tempdir().unwrap();
	let summary = split_model_file(
		model,
		out.path(),
		Some(HotSelection {
			counts: &counts,
			coverage: 1.0,
			always: &[0, 1, 2, 3],
		}),
	)
	.unwrap();
	assert_eq!(summary.hot_rows, Some(8));
	for name in ["encoder.onnx", "embeddings.rows", "embeddings-hot.bin"] {
		let ours = std::fs::read(out.path().join(name)).unwrap();
		let theirs = std::fs::read(split_fixture(name)).unwrap();
		assert!(ours == theirs, "{name}: {} bytes against {}", ours.len(), theirs.len());
	}
}

#[test]
fn the_split_drops_every_value_info_annotation() {
	let bytes = std::fs::read(split_fixture("model.onnx")).unwrap();
	let mut model = ModelProto::decode(bytes.as_slice()).unwrap();
	let graph = model.graph.as_mut().unwrap();
	// An annotation of the removed `embedding` tensor with a hidden width the table contradicts.
	graph.value_info.push(trainer_export::graph::value_info(
		"embedding",
		trainer_export::onnx::tensor_proto::DataType::Float,
		&[
			trainer_export::graph::Dim::Fixed(1),
			trainer_export::graph::Dim::Fixed(16),
		],
	));
	let out = tempfile::tempdir().unwrap();
	split_model_file(model, out.path(), None).unwrap();
	let encoder = ModelProto::decode(std::fs::read(out.path().join("encoder.onnx")).unwrap().as_slice()).unwrap();
	let graph = encoder.graph.unwrap();
	assert!(graph.value_info.is_empty());
	assert_eq!(graph.input[0].name.as_deref(), Some("inputs_embeds"));
	assert_eq!(
		std::fs::read(out.path().join("encoder.onnx")).unwrap(),
		std::fs::read(split_fixture("encoder.onnx")).unwrap()
	);
}

#[test]
fn refuses_a_label_map_shorter_than_the_head() {
	let dir = tempfile::tempdir().unwrap();
	let source = fixtures().join("tiny-bundle");
	let mut config: serde_json::Value =
		serde_json::from_str(&std::fs::read_to_string(source.join("config.json")).unwrap()).unwrap();
	config["id2label"].as_object_mut().unwrap().remove("32");
	std::fs::write(dir.path().join("config.json"), config.to_string()).unwrap();
	std::fs::copy(source.join("pytorch_model.bin"), dir.path().join("pytorch_model.bin")).unwrap();
	let error = export_checkpoint(dir.path(), &ExportOptions::default()).unwrap_err();
	assert!(error.0.contains("id2label"), "{error}");
}

#[test]
fn the_split_refuses_a_per_axis_scale() {
	let bytes = std::fs::read(split_fixture("model.onnx")).unwrap();
	let mut model = ModelProto::decode(bytes.as_slice()).unwrap();
	let graph = model.graph.as_mut().unwrap();
	let scale = graph
		.initializer
		.iter_mut()
		.find(|t| t.name.as_deref() == Some("scale"))
		.unwrap();
	scale.dims = vec![8];
	scale.raw_data = Some(0.01f32.to_le_bytes().repeat(8));
	scale.float_data.clear();
	let out = tempfile::tempdir().unwrap();
	let error = split_model_file(model, out.path(), None).err().unwrap();
	assert!(error.0.contains("per-tensor"), "{error}");
}

#[test]
fn the_split_refuses_a_graph_whose_ids_feed_more_than_the_table() {
	let bytes = std::fs::read(split_fixture("model.onnx")).unwrap();
	let mut model = ModelProto::decode(bytes.as_slice()).unwrap();
	let graph = model.graph.as_mut().unwrap();
	let mut extra = graph.node[0].clone();
	extra.output = vec!["second".into()];
	graph.node.push(extra);
	let out = tempfile::tempdir().unwrap();
	let error = split_model_file(model, out.path(), None).err().unwrap();
	assert!(error.0.contains("exactly one Gather"), "{error}");
}
