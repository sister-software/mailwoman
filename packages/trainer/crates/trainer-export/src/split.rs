//! Splits the quantized token-embedding table out of an int8 `model.onnx`.
//!
//! The quantized graph reads its embedding table in two nodes: a `Gather` of `input_ids` over a UINT8
//! `[vocab, hidden]` initializer, then one per-tensor `DequantizeLinear`. The split removes both nodes and the table,
//! and declares a float `inputs_embeds [batch, seq, hidden]` input in place of `input_ids`. The runtime computes the
//! same tensor as `(row - zero_point) * scale` (`packages/neural/lib/embedding/rows.ts`).
//!
//! The table is written in the `MWE1` row-file layout, little-endian:
//!
//! | offset | type | field                                              |
//! | ------ | ---- | -------------------------------------------------- |
//! | 0      | 4 B  | magic `MWE1`                                       |
//! | 4      | u32  | header bytes, always 32                            |
//! | 8      | u32  | vocabulary size                                    |
//! | 12     | u32  | hidden width (bytes per row)                       |
//! | 16     | f32  | dequantization scale                               |
//! | 20     | u32  | dequantization zero point (0..255)                 |
//! | 24     | u32  | row count in this file                             |
//! | 28     | u32  | layout: 0 = every row in id order, 1 = a subset    |
//!
//! A full file (layout 0) holds `vocab` rows from offset 32, so row `i` sits at `32 + i * hidden` and an HTTP range
//! read fetches that one row without the others. A subset file (layout 1) holds `row count` u32 ids in ascending
//! order from offset 32, then the rows in the same order.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::graph::{value_info, Dim};
use crate::onnx::tensor_proto::DataType;
use crate::onnx::tensor_shape_proto::dimension;
use crate::onnx::type_proto::Value as TypeValue;
use crate::onnx::{ModelProto, TensorProto};
use crate::{fail, Result};

pub const MAGIC: &[u8; 4] = b"MWE1";
pub const HEADER_BYTES: u32 = 32;
pub const LAYOUT_FULL: u32 = 0;
pub const LAYOUT_SUBSET: u32 = 1;
const INPUT_IDS: &str = "input_ids";
const INPUTS_EMBEDS: &str = "inputs_embeds";

/// The quantized table and its per-tensor dequantization pair.
pub struct EmbeddingTable {
	/// `vocab * hidden` bytes, row-major.
	pub rows: Vec<u8>,
	pub vocab: usize,
	pub hidden: usize,
	pub scale: f32,
	pub zero_point: u8,
}

/// The bytes of a UINT8 initializer, from `raw_data` or, one element per entry, `int32_data`.
fn uint8_elements(tensor: &TensorProto) -> Vec<u8> {
	match &tensor.raw_data {
		Some(raw) if !raw.is_empty() || tensor.int32_data.is_empty() => raw.clone(),
		_ => tensor.int32_data.iter().map(|v| *v as u8).collect(),
	}
}

fn element_count(tensor: &TensorProto) -> i64 {
	tensor.dims.iter().product()
}

fn scalar_f32(tensor: &TensorProto, name: &str) -> Result<f32> {
	if element_count(tensor) != 1 {
		return Err(fail!(
			"{name} has shape {:?}; the split supports a per-tensor scale and zero point only",
			tensor.dims
		));
	}
	let values = crate::quantize::tensor_f32(tensor)?;
	Ok(values[0])
}

fn scalar_u8(tensor: &TensorProto, name: &str) -> Result<u8> {
	if element_count(tensor) != 1 {
		return Err(fail!(
			"{name} has shape {:?}; the split supports a per-tensor scale and zero point only",
			tensor.dims
		));
	}
	if tensor.data_type != Some(DataType::Uint8 as i32) {
		return Err(fail!("{name} is not a UINT8 zero point"));
	}
	uint8_elements(tensor)
		.first()
		.copied()
		.ok_or_else(|| fail!("{name} holds no element"))
}

/// Rewrites `model` in place into the encoder and returns the table it no longer contains.
///
/// Refuses a graph where `input_ids` feeds anything other than one `Gather` over a UINT8 initializer followed by one
/// `DequantizeLinear` with scalar parameters.
pub fn split_embeddings(model: &mut ModelProto) -> Result<EmbeddingTable> {
	let graph = model.graph.as_mut().ok_or_else(|| fail!("the model has no graph"))?;
	let find = |graph: &crate::onnx::GraphProto, name: &str| {
		graph.initializer.iter().position(|t| t.name.as_deref() == Some(name))
	};

	let readers: Vec<usize> = (0..graph.node.len())
		.filter(|i| graph.node[*i].input.iter().any(|n| n == INPUT_IDS))
		.collect();
	if readers.len() != 1 || graph.node[readers[0]].op_type.as_deref() != Some("Gather") {
		let ops: Vec<_> = readers
			.iter()
			.map(|i| graph.node[*i].op_type.clone().unwrap_or_default())
			.collect();
		return Err(fail!("{INPUT_IDS} must feed exactly one Gather; read by {ops:?}"));
	}
	let gather = graph.node[readers[0]].clone();
	let table_name = gather.input[0].clone();
	let table_index = find(graph, &table_name)
		.ok_or_else(|| fail!("the Gather over {INPUT_IDS} reads {table_name}, which is not an initializer"))?;
	let table = &graph.initializer[table_index];
	if table.data_type != Some(DataType::Uint8 as i32) || table.dims.len() != 2 {
		return Err(fail!(
			"{table_name} is type {:?} {:?}; the split expects a UINT8 [vocab, hidden] table",
			table.data_type,
			table.dims
		));
	}
	let (vocab, hidden) = (table.dims[0] as usize, table.dims[1] as usize);
	let rows = uint8_elements(table);
	if rows.len() != vocab * hidden {
		return Err(fail!(
			"{table_name} holds {} bytes, its dims need {}",
			rows.len(),
			vocab * hidden
		));
	}

	let gathered = gather.output[0].clone();
	let dequantizers: Vec<usize> = (0..graph.node.len())
		.filter(|i| graph.node[*i].input.contains(&gathered))
		.collect();
	if dequantizers.len() != 1 || graph.node[dequantizers[0]].op_type.as_deref() != Some("DequantizeLinear") {
		let ops: Vec<_> = dequantizers
			.iter()
			.map(|i| graph.node[*i].op_type.clone().unwrap_or_default())
			.collect();
		return Err(fail!(
			"the embedding Gather must feed exactly one DequantizeLinear; feeds {ops:?}"
		));
	}
	let dequantize = graph.node[dequantizers[0]].clone();
	fn parameter<'g>(graph: &'g crate::onnx::GraphProto, name: &str) -> Result<&'g TensorProto> {
		graph
			.initializer
			.iter()
			.find(|t| t.name.as_deref() == Some(name))
			.ok_or_else(|| fail!("{name} is not an initializer"))
	}
	let scale_name = dequantize.input.get(1).cloned().unwrap_or_default();
	let scale = scalar_f32(parameter(graph, &scale_name)?, &scale_name)?;
	let zero_point = match dequantize.input.get(2) {
		Some(name) if !name.is_empty() => scalar_u8(parameter(graph, name)?, name)?,
		_ => 0,
	};

	let embedded = dequantize.output[0].clone();
	if graph
		.output
		.iter()
		.any(|o| o.name.as_deref() == Some(embedded.as_str()))
	{
		return Err(fail!("{embedded} is a graph output; the split cannot remove it"));
	}
	graph.node.retain(|n| *n != gather && *n != dequantize);
	for node in &mut graph.node {
		for name in &mut node.input {
			if *name == embedded {
				*name = INPUTS_EMBEDS.to_owned();
			}
		}
	}

	let still_read: BTreeSet<&String> = graph.node.iter().flat_map(|n| n.input.iter()).collect();
	let mut removable: BTreeSet<String> = dequantize.input[1..].iter().cloned().collect();
	removable.insert(table_name);
	removable.retain(|name| !still_read.contains(name));
	graph
		.initializer
		.retain(|t| !removable.contains(t.name.as_deref().unwrap_or_default()));

	let position = graph
		.input
		.iter()
		.position(|i| i.name.as_deref() == Some(INPUT_IDS))
		.ok_or_else(|| fail!("the graph declares no {INPUT_IDS} input"))?;
	let Some(TypeValue::TensorType(ids_type)) = graph.input[position].r#type.as_ref().and_then(|t| t.value.as_ref())
	else {
		return Err(fail!("{INPUT_IDS} is not a tensor input"));
	};
	let ids_dims = ids_type.shape.as_ref().map(|s| s.dim.as_slice()).unwrap_or_default();
	if ids_dims.len() < 2 {
		return Err(fail!(
			"{INPUT_IDS} declares {} dimensions, not [batch, seq]",
			ids_dims.len()
		));
	}
	// The symbol when there is one, else the value (0 when neither is set).
	let dim = |d: &crate::onnx::tensor_shape_proto::Dimension| match &d.value {
		Some(dimension::Value::DimParam(p)) if !p.is_empty() => Dim::Param(p.clone()),
		Some(dimension::Value::DimValue(v)) => Dim::Fixed(*v),
		_ => Dim::Fixed(0),
	};
	let embeds = value_info(
		INPUTS_EMBEDS,
		DataType::Float,
		&[dim(&ids_dims[0]), dim(&ids_dims[1]), Dim::Fixed(hidden as i64)],
	);
	graph.input[position] = embeds;
	graph.value_info.clear();

	Ok(EmbeddingTable {
		rows,
		vocab,
		hidden,
		scale,
		zero_point,
	})
}

fn header(table: &EmbeddingTable, row_count: u32, layout: u32) -> Vec<u8> {
	let mut out = Vec::with_capacity(HEADER_BYTES as usize);
	out.extend_from_slice(MAGIC);
	for v in [HEADER_BYTES, table.vocab as u32, table.hidden as u32] {
		out.extend_from_slice(&v.to_le_bytes());
	}
	out.extend_from_slice(&table.scale.to_le_bytes());
	for v in [table.zero_point as u32, row_count, layout] {
		out.extend_from_slice(&v.to_le_bytes());
	}
	out
}

/// Every row in id order (layout 0).
pub fn full_rows(table: &EmbeddingTable) -> Vec<u8> {
	let mut out = header(table, table.vocab as u32, LAYOUT_FULL);
	out.extend_from_slice(&table.rows);
	out
}

/// The rows of `ids` (layout 1), sorted ascending and deduplicated.
pub fn subset_rows(table: &EmbeddingTable, ids: &BTreeSet<usize>) -> Result<Vec<u8>> {
	if ids.iter().any(|i| *i >= table.vocab) {
		return Err(fail!("subset ids must lie in [0, {})", table.vocab));
	}
	let mut out = header(table, ids.len() as u32, LAYOUT_SUBSET);
	for id in ids {
		out.extend_from_slice(&(*id as u32).to_le_bytes());
	}
	for id in ids {
		out.extend_from_slice(&table.rows[id * table.hidden..(id + 1) * table.hidden]);
	}
	Ok(out)
}

/// The fewest ids whose counts reach `coverage` of all occurrences, plus `always`.
///
/// The ids are ranked by count, highest first, ties in id order (`np.argsort(-counts, kind="stable")`). The running
/// share is the float64 `cumsum / total`, and the selection ends at the first rank whose share reaches
/// `coverage - 1e-12` (`np.searchsorted`'s left side), so a coverage of 1 takes every id with a nonzero count.
pub fn hot_ids(counts: &[i64], coverage: f64, always: &[usize]) -> Result<BTreeSet<usize>> {
	if !(coverage > 0.0 && coverage <= 1.0) {
		return Err(fail!("coverage must lie in (0, 1]"));
	}
	let total: i64 = counts.iter().sum();
	if total <= 0 {
		return Err(fail!("the piece counts sum to zero"));
	}
	let mut order: Vec<usize> = (0..counts.len()).collect();
	order.sort_by_key(|i| std::cmp::Reverse(counts[*i]));
	let target = coverage - 1e-12;
	let mut running = 0i64;
	let mut take = order.len();
	for (rank, id) in order.iter().enumerate() {
		running += counts[*id];
		if running as f64 / total as f64 >= target {
			take = rank + 1;
			break;
		}
	}
	// `searchsorted` past the end returns `len`, and `order[:len + 1]` is every id.
	let mut ids: BTreeSet<usize> = order[..take.min(order.len())].iter().copied().collect();
	ids.extend(always.iter().copied());
	Ok(ids)
}

/// Reads per-piece occurrence counts: an integer `.npy` vector, or a JSON array of integers.
pub fn read_counts(path: &Path) -> Result<Vec<i64>> {
	let bytes = std::fs::read(path).map_err(|error| fail!("{}: {error}", path.display()))?;
	if bytes.starts_with(b"\x93NUMPY") {
		return crate::npy::read_integer_vector(&bytes).map_err(|error| fail!("{}: {error}", path.display()));
	}
	serde_json::from_slice(&bytes)
		.map_err(|error| fail!("{}: not an .npy or a JSON integer array: {error}", path.display()))
}

/// What `split_model_file` wrote, as `split-embeddings` prints it.
#[derive(Serialize)]
pub struct SplitSummary {
	pub encoder: PathBuf,
	pub encoder_bytes: u64,
	pub embeddings: PathBuf,
	pub embeddings_bytes: u64,
	pub vocab_size: usize,
	pub hidden: usize,
	/// The float32 scale widened to float64, so it prints as the float64 the Python summary printed.
	pub scale: f64,
	pub zero_point: u8,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub hot: Option<PathBuf>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub hot_bytes: Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub hot_rows: Option<usize>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub coverage: Option<f64>,
}

/// The hot subset's selection: per-piece counts, the share of occurrences to cover, and the ids every subset holds.
pub struct HotSelection<'a> {
	pub counts: &'a [i64],
	pub coverage: f64,
	pub always: &'a [usize],
}

fn write_staged(path: &Path, bytes: &[u8]) -> Result<u64> {
	let staged = PathBuf::from(format!("{}.partial", path.display()));
	std::fs::write(&staged, bytes).map_err(|error| fail!("{}: {error}", staged.display()))?;
	std::fs::rename(&staged, path).map_err(|error| fail!("{}: {error}", path.display()))?;
	Ok(bytes.len() as u64)
}

/// Writes `encoder.onnx`, `embeddings.rows` and, given a selection, `embeddings-hot.bin` into `out_dir`.
///
/// The full file is read by HTTP range, so its extension keeps it out of the publisher's whole-fetch gzip encoding.
/// The hot subset is fetched whole and keeps `.bin`.
pub fn split_model_file(model: ModelProto, out_dir: &Path, hot: Option<HotSelection>) -> Result<SplitSummary> {
	use prost::Message;
	let mut model = model;
	let table = split_embeddings(&mut model)?;
	std::fs::create_dir_all(out_dir).map_err(|error| fail!("{}: {error}", out_dir.display()))?;
	let encoder = out_dir.join("encoder.onnx");
	let embeddings = out_dir.join("embeddings.rows");
	let encoder_bytes = write_staged(&encoder, &model.encode_to_vec())?;
	let embeddings_bytes = write_staged(&embeddings, &full_rows(&table))?;
	let mut summary = SplitSummary {
		encoder,
		encoder_bytes,
		embeddings,
		embeddings_bytes,
		vocab_size: table.vocab,
		hidden: table.hidden,
		scale: table.scale as f64,
		zero_point: table.zero_point,
		hot: None,
		hot_bytes: None,
		hot_rows: None,
		coverage: None,
	};
	if let Some(selection) = hot {
		if selection.counts.len() != table.vocab {
			return Err(fail!(
				"counts has {} entries; the table has {} rows",
				selection.counts.len(),
				table.vocab
			));
		}
		let ids = hot_ids(selection.counts, selection.coverage, selection.always)?;
		let path = out_dir.join("embeddings-hot.bin");
		summary.hot_bytes = Some(write_staged(&path, &subset_rows(&table, &ids)?)?);
		summary.hot = Some(path);
		summary.hot_rows = Some(ids.len());
		summary.coverage = Some(selection.coverage);
	}
	Ok(summary)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn hot_ids_takes_the_fewest_rows_reaching_coverage() {
		let counts = [5, 0, 3, 2];
		assert_eq!(
			hot_ids(&counts, 0.5, &[1]).unwrap().into_iter().collect::<Vec<_>>(),
			[0, 1]
		);
		assert_eq!(
			hot_ids(&counts, 1.0, &[]).unwrap().into_iter().collect::<Vec<_>>(),
			[0, 2, 3]
		);
	}

	#[test]
	fn hot_ids_breaks_ties_in_id_order() {
		// Ids 1 and 2 tie; the stable descending sort keeps 1 first, so 0.5 coverage takes 1 alone.
		let counts = [0, 4, 4];
		assert_eq!(hot_ids(&counts, 0.5, &[]).unwrap().into_iter().collect::<Vec<_>>(), [1]);
	}

	#[test]
	fn hot_ids_refuses_an_empty_count_or_a_bad_coverage() {
		assert!(hot_ids(&[0, 0], 0.5, &[]).is_err());
		assert!(hot_ids(&[1], 0.0, &[]).is_err());
		assert!(hot_ids(&[1], 1.5, &[]).is_err());
	}
}
