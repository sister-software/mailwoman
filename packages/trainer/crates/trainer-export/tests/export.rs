//! The exporter and quantizer against fixtures torch 2.12.0 wrote.
//!
//! `fixtures/tiny-bundle` is a `MailwomanCoarseEncoder` with hidden size 8 and one block, built with every channel of
//! the shipped interface (the evidence bundle, the locale head and the locale hint, four address systems) and saved
//! with `save_pretrained`. `reference-fp32.onnx` beside it is that model exported by
//! `mailwoman_train.export.onnx.export_to_onnx(opset=17, max_length=16)` with torch 2.12.0 and onnxscript 0.7.2.
//! `fixtures/storages.bin` is `torch.save` of one 2x3 float32 tensor in float32, bfloat16 and float16, its
//! transpose, and a view at storage offset 2. The fixtures were written once with the pinned Python stack; the numeric
//! comparison of full checkpoints is `packages/neural/tools/onnx-export-parity.run.ts`.

use std::path::{Path, PathBuf};

use prost::Message;
use trainer_export::checkpoint::read_state_dict;
use trainer_export::export::export_checkpoint;
use trainer_export::onnx::{ModelProto, ValueInfoProto};
use trainer_export::quantize::quantize_dynamic_qint8;

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
	let ours = export_checkpoint(&fixtures().join("tiny-bundle")).unwrap();
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
	let model = quantize_dynamic_qint8(export_checkpoint(&fixtures().join("tiny-bundle")).unwrap()).unwrap();
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
	let error = export_checkpoint(dir.path()).unwrap_err();
	assert!(error.0.contains("has no tensor"), "{error}");
}
