// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `mtf-tokenizer`: the Rust half of `packages/mtf/tools/tokenizer`.
//!
//! The TypeScript tools orchestrate; this binary does the work that needs the protobuf model, the parquet corpus,
//! CPython's generator or the training encoder's painter. Each command reads paths and JSON files and writes JSON, a
//! model or a text file, then prints a one-line JSON result. A command that fails prints the reason on stderr and
//! exits 1.
//!
//! - `inspect <model> [--out <json>]`: every piece as `[piece, score, type]`.
//! - `edit <model> --plan <json> --out <model>`: keep, append, and drop spec fields to the wheel's form.
//! - `train-files --corpus <dir>`: the train split's parquet files, in the order the tools read them.
//! - `manifest-train-files --manifest <json>`: a manifest's train paths as listed, unsorted and not re-rooted.
//! - `sample-raws --corpus <dir> --countries <a,b> --per-country <n> --seed <n> --out <txt>`: the balanced raw sample.
//! - `reservoir --file <parquet> --size <n> --seed <n> --out <json>`: a reservoir sample of one file's raws.
//! - `mine-postcodes --corpus <dir> --top-k <n> [--countries <a,b>] [--max-files <n>]`: the mined postcode literals.
//! - `count-pieces --model <model> --files <json> [--threads <n>] --out <json>`: per-piece use counts.
//! - `sample-rows --files <json> --rows <n> --seed <n> --out <json>`: the prune check's random row sample.
//! - `sample-indices --population <n> --count <n> --seed <n>`: `random.Random(seed).sample(range(n), count)`.
//! - `shuffle --seed <n> --input <json> --out <json>`: `random.Random(seed).shuffle` over a JSON list.
//! - `byte-fallback --model <model> --lines <json>`: byte-fallback figures, overall and per script.
//! - `paint --model <model> --lexicon <name>=<json>... --texts <json> --out <json>`: lexicon channels per piece.
//! - `onnx-read --model <onnx> --name <initializer> --raw-out <file>`: an initializer's shape, type and bytes.
//! - `onnx-write --model <onnx> --name <initializer> --dims <a,b> --data-type <n> --raw <file> --out <onnx>`.

mod args;
mod byte_fallback;
mod corpus;
mod model;
mod onnx;
mod paint;

use args::{Args, Result};
use mtf_channels::gazetteer::Lexicon;
use mtf_core::Processor;
use mtf_sampler::corpus_files::manifest_files;
use mtf_sampler::pyrandom::{PyRandom, Seed};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn read(path: &str) -> Result<Vec<u8>> {
	std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

fn read_json(path: &str) -> Result<Value> {
	let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
	serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))
}

fn strings(value: &Value, what: &str) -> Result<Vec<String>> {
	value
		.as_array()
		.ok_or_else(|| format!("{what} is not a JSON array"))?
		.iter()
		.map(|v| {
			v.as_str()
				.map(str::to_owned)
				.ok_or_else(|| format!("{what} holds a non-string"))
		})
		.collect()
}

fn write(path: &str, bytes: &[u8]) -> Result<()> {
	if let Some(parent) = Path::new(path).parent() {
		std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
	}
	std::fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))
}

fn write_json(path: &str, value: &Value) -> Result<()> {
	write(
		path,
		serde_json::to_string(value).map_err(|e| e.to_string())?.as_bytes(),
	)
}

fn emit(value: &Value) {
	println!("{value}");
}

fn processor(path: &str) -> Result<Processor> {
	Processor::from_model_proto(&read(path)?).map_err(|e| format!("{path}: {e}"))
}

fn seed(args: &Args) -> Result<i128> {
	args.number::<i128>("seed")?
		.ok_or_else(|| format!("{}: --seed is required", args.command))
}

fn count(args: &Args, name: &str) -> Result<usize> {
	args.number::<usize>(name)?
		.ok_or_else(|| format!("{}: --{name} is required", args.command))
}

fn countries(value: &str) -> Vec<&str> {
	value.split(',').map(str::trim).filter(|c| !c.is_empty()).collect()
}

fn file_list(args: &Args) -> Result<Vec<PathBuf>> {
	let path = args.required("files")?;
	Ok(strings(&read_json(path)?, path)?
		.into_iter()
		.map(PathBuf::from)
		.collect())
}

fn run(args: &Args) -> Result<()> {
	match args.command.as_str() {
		"inspect" => {
			let path = args.positional(0, "model")?;
			let editor = model::parse(&read(path)?, path)?;
			let out = json!({ "pieces": model::pieces_json(&editor) });
			match args.optional("out") {
				Some(file) => {
					write_json(file, &out)?;
					emit(&json!({ "pieces": editor.pieces().len() }));
				}
				None => emit(&out),
			}
		}
		"edit" => {
			let path = args.positional(0, "model")?;
			let mut editor = model::parse(&read(path)?, path)?;
			let summary = model::apply_plan(&mut editor, &read_json(args.required("plan")?)?)?;
			write(args.required("out")?, &editor.to_bytes())?;
			emit(&summary);
		}
		"train-files" => {
			let files = corpus::train_file_records(Path::new(args.required("corpus")?))?;
			emit(&json!(files
				.iter()
				.map(|f| json!({ "path": f.path.to_string_lossy(), "sha256": f.sha256 }))
				.collect::<Vec<_>>()));
		}
		"manifest-train-files" => {
			let path = args.required("manifest")?;
			let manifest = read_json(path)?;
			let listed = manifest_files(&manifest)
				.iter()
				.filter(|entry| entry.get("split").and_then(Value::as_str) == Some("train"))
				.map(|entry| {
					entry
						.get("path")
						.and_then(Value::as_str)
						.map(str::to_owned)
						.ok_or_else(|| format!("{path}: a train entry has no path"))
				})
				.collect::<Result<Vec<_>>>()?;
			emit(&json!(listed));
		}
		"sample-raws" => {
			let files = corpus::train_files(Path::new(args.required("corpus")?))?;
			let (raws, per_country) = corpus::sample_balanced_raws(
				&files,
				&countries(args.required("countries")?),
				count(args, "per-country")?,
				seed(args)?,
			)?;
			let mut text = String::with_capacity(raws.iter().map(|r| r.len() + 1).sum());
			for raw in &raws {
				text.push_str(&raw.replace('\n', " "));
				text.push('\n');
			}
			write(args.required("out")?, text.as_bytes())?;
			emit(&json!({ "lines": raws.len(), "per_country": per_country }));
		}
		"reservoir" => {
			let raws = corpus::reservoir_raws(Path::new(args.required("file")?), count(args, "size")?, seed(args)?)?;
			write_json(args.required("out")?, &json!(raws))?;
			emit(&json!({ "rows": raws.len() }));
		}
		"mine-postcodes" => {
			let files = corpus::train_files(Path::new(args.required("corpus")?))?;
			let filter = args.optional("countries").map(countries);
			let mined = corpus::mine_postcode_literals(
				&files,
				count(args, "top-k")?,
				filter.as_deref(),
				args.number::<usize>("max-files")?,
			)?;
			emit(&json!(mined));
		}
		"count-pieces" => {
			let processor = processor(args.required("model")?)?;
			let threads = args.number::<usize>("threads")?.unwrap_or(4);
			let counts = corpus::count_pieces(&processor, &file_list(args)?, threads)?;
			write_json(args.required("out")?, &json!({ "counts": counts }))?;
			let fired = counts.iter().filter(|&&n| n > 0).count();
			emit(&json!({ "vocab_size": counts.len(), "fired": fired }));
		}
		"sample-rows" => {
			let rows = corpus::sample_training_rows(&file_list(args)?, count(args, "rows")?, seed(args)?)?;
			write_json(args.required("out")?, &json!(rows))?;
			emit(&json!({ "rows": rows.len() }));
		}
		"sample-indices" => {
			let mut rng = PyRandom::new(Seed::Int(seed(args)?));
			let picked = rng
				.sample_indices(count(args, "population")?, count(args, "count")?)
				.map_err(|e| e.0)?;
			emit(&json!(picked));
		}
		"shuffle" => {
			let input = args.required("input")?;
			let mut items = strings(&read_json(input)?, input)?;
			PyRandom::new(Seed::Int(seed(args)?)).shuffle(&mut items);
			write_json(args.required("out")?, &json!(items))?;
			emit(&json!({ "items": items.len() }));
		}
		"byte-fallback" => {
			let processor = processor(args.required("model")?)?;
			let path = args.required("lines")?;
			emit(&byte_fallback::measure(&processor, &strings(&read_json(path)?, path)?)?);
		}
		"paint" => {
			let processor = processor(args.required("model")?)?;
			let lexicons = args
				.all("lexicon")
				.into_iter()
				.map(|spec| {
					let (name, path) = spec
						.split_once('=')
						.ok_or_else(|| format!("--lexicon {spec:?} is not <name>=<path>"))?;
					let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
					Ok((
						name.to_owned(),
						Lexicon::from_json(&text, path).map_err(|e| e.to_string())?,
					))
				})
				.collect::<Result<Vec<_>>>()?;
			let path = args.required("texts")?;
			let texts = strings(&read_json(path)?, path)?;
			let painted = paint::paint_texts(&processor, &lexicons, &texts)?;
			write_json(args.required("out")?, &painted)?;
			emit(&json!({ "cases": texts.len() }));
		}
		"onnx-read" => {
			let path = args.required("model")?;
			let tensor = onnx::read_initializer(&read(path)?, args.required("name")?)?;
			write(args.required("raw-out")?, &tensor.raw)?;
			emit(&json!({ "dims": tensor.dims, "data_type": tensor.data_type, "bytes": tensor.raw.len() }));
		}
		"onnx-write" => {
			let path = args.required("model")?;
			let dims = args
				.required("dims")?
				.split(',')
				.map(|d| d.parse::<i64>().map_err(|_| format!("--dims holds {d:?}")))
				.collect::<Result<Vec<_>>>()?;
			let tensor = onnx::Tensor {
				dims,
				data_type: count(args, "data-type")? as u64,
				raw: read(args.required("raw")?)?,
			};
			let out = onnx::replace_initializer(&read(path)?, args.required("name")?, &tensor)?;
			write(args.required("out")?, &out)?;
			emit(&json!({ "bytes": out.len() }));
		}
		other => return Err(format!("unknown command {other:?}")),
	}
	Ok(())
}

fn main() {
	let outcome = Args::parse(std::env::args().skip(1).collect()).and_then(|args| run(&args));
	if let Err(message) = outcome {
		eprintln!("mtf-tokenizer: {message}");
		std::process::exit(1);
	}
}
