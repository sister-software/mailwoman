//! The supervised run: `train/trainer.py`'s `train`, `train/setup.py`, and `train/loop.py`'s optimizer loop.
//!
//! `step` counts optimizer steps, not micro-batches, so it lines up with `train.max_steps` whatever
//! `grad_accum_steps` is. A resumed run skips the `resume_step * accum` batches its predecessors trained on.

use crate::batch::{RunEncoder, TensorBatch};
use crate::callbacks::{Callback, Checkpointer, Console, CsvMetrics, StepView};
use crate::checkpoint::{
	checkpoint_extras, find_latest_checkpoint, restore_generators, resume_drift, save_checkpoint, RNG_STATE,
	TRAINING_STATE,
};
use crate::config::{sampler_config, DataFiles, RunConfig};
use crate::fisher::{EwcPenalty, FisherAccumulator};
use crate::metrics::{cross_pollution, per_locale_tag_f1, token_f1, Metrics};
use crate::noise::{apply_curricula, Curricula};
use crate::optim::{build_groups, clip_grad_norm, AdamW};
use crate::realized::RealizedRows;
use crate::schedules::{restamp_resume_lrs, LambdaLr, Schedule};
use crate::{fail, Result};
use mtf_sampler::{CancelToken, Sampler, SamplerConfig, TrainingBatches};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tch::{Device, Kind, Tensor};
use trainer_model::autocast::Autocast;
use trainer_model::layers::Mode;
use trainer_model::{CoarseEncoder, EncoderSpec};

/// How the configured precision reaches the model.
#[derive(Clone, Copy, Debug)]
pub struct Precision {
	pub autocast: Option<Kind>,
	pub accum: i64,
}

/// `resolve_precision`: bf16 on an NVIDIA device runs under autocast with fp32 parameters; the CPU runs fp32.
///
/// `autocast_on_cpu` asks for the CPU autocast the staged comparison runs; the Python trainer never autocasts
/// on the CPU. The parameter cast that fp16 and ROCm bf16 take in Python is retired: fp16 on a CUDA device is
/// refused, and the trainer links CPU or CUDA libtorch only, so it has no ROCm device.
pub fn resolve_precision(run: &RunConfig, device: Device, autocast_on_cpu: bool) -> Result<Precision> {
	let accum = run.train_i64("grad_accum_steps")?.max(1);
	let precision = run.train_str("precision")?;
	let kind = match precision.as_str() {
		"bf16" => Some(Kind::BFloat16),
		"fp16" if device.is_cuda() => Some(Kind::Half),
		_ => None,
	};
	match (kind, device) {
		(None, _) => Ok(Precision { autocast: None, accum }),
		(Some(Kind::BFloat16), Device::Cuda(_)) => Ok(Precision {
			autocast: Some(Kind::BFloat16),
			accum,
		}),
		(Some(k), Device::Cpu) if autocast_on_cpu => Ok(Precision {
			autocast: Some(k),
			accum,
		}),
		(Some(_), Device::Cpu) => Ok(Precision { autocast: None, accum }),
		(Some(k), _) => Err(fail!(
			"train.precision={precision:?} on {device:?} cast the parameters to {k:?} in the Python trainer, with no \
			 gradient scaler; the Rust trainer retires that cast, so use bf16, which runs under autocast with fp32 \
			 parameters"
		)),
	}
}

/// The run's device: the first CUDA device when there is one.
pub fn device() -> Device {
	Device::cuda_if_available()
}

/// `build_model`: the encoder a run's config describes, built from the global generator.
pub fn build_model(run: &RunConfig, encoder: &RunEncoder) -> Result<CoarseEncoder> {
	let labels = encoder.labels()?;
	let spec = EncoderSpec::from_model_section(
		&run.model,
		encoder.vocab_size,
		encoder.pad_id,
		encoder.char_vocab_size,
		&labels,
		&encoder.label_set,
		encoder.schema.locale_countries.len() as i64,
		encoder.address_systems.count(),
		&encoder.conventions,
	)?;
	Ok(CoarseEncoder::new(spec)?)
}

/// `load_or_build_model`.
pub fn load_or_build_model(run: &RunConfig, encoder: &RunEncoder, resume_from: Option<&Path>) -> Result<CoarseEncoder> {
	if let Some(dir) = resume_from {
		println!("resuming from {}", dir.display());
		return Ok(CoarseEncoder::from_pretrained(dir, encoder.defaults())?);
	}
	let model = build_model(run, encoder)?;
	let init_from = run.train_str("init_from")?;
	if !init_from.is_empty() {
		let tensors = trainer_model::checkpoint::read_model_tensors(Path::new(&init_from))?;
		let (missing, unexpected) = model.store.load(&tensors, false)?;
		println!(
			"[init_from] loaded encoder from {init_from} (missing={} unexpected={})",
			missing.len(),
			unexpected.len()
		);
	}
	let reinit = run.train_strings("reinit_label_rows")?;
	if !reinit.is_empty() {
		if init_from.is_empty() {
			return Err(fail!("train.reinit_label_rows requires train.init_from"));
		}
		reinit_label_rows(&model, &reinit)?;
	}
	Ok(model)
}

/// `reinit_label_rows`: the selected labels' classifier rows set to the mean of the live rows.
fn reinit_label_rows(model: &CoarseEncoder, labels: &[String]) -> Result<()> {
	let rows: Vec<i64> = labels
		.iter()
		.map(|l| {
			model
				.spec
				.id_to_label
				.iter()
				.position(|x| x == l)
				.map(|i| i as i64)
				.ok_or_else(|| fail!("reinit_label_rows names an unknown label {l}"))
		})
		.collect::<Result<_>>()?;
	let weight = model.store.get("classifier.weight")?;
	let bias = model.store.get("classifier.bias")?;
	tch::no_grad(|| {
		let live: Vec<i64> = (0..weight.size()[0]).filter(|i| !rows.contains(i)).collect();
		let live = Tensor::from_slice(&live);
		let mean_w = weight.index_select(0, &live).mean_dim(&[0i64][..], false, None);
		let mean_b = bias.index_select(0, &live).mean(None);
		for &i in &rows {
			weight.get(i).copy_(&mean_w);
			bias.get(i).copy_(&mean_b);
		}
	});
	println!("[reinit_label_rows] rows {rows:?} ← live-row mean ({labels:?})");
	Ok(())
}

/// `apply_freezes`.
pub fn apply_freezes(run: &RunConfig, model: &CoarseEncoder) -> Result<()> {
	let params = model.store.parameters();
	let freeze_tokens = run.train_bool("freeze_token_embeddings")?;
	if freeze_tokens {
		let mut frozen = 0;
		for (n, p) in &params {
			if n.contains("token_embeddings") {
				let _ = p.set_requires_grad(false);
				frozen += 1;
			}
		}
		if frozen == 0 {
			return Err(fail!(
				"freeze_token_embeddings=True but no token_embeddings params found"
			));
		}
	}
	let prefixes = run.train_strings("trainable_only_prefixes")?;
	if !prefixes.is_empty() {
		if freeze_tokens {
			return Err(fail!(
				"train.trainable_only_prefixes is mutually exclusive with freeze_token_embeddings — \
				 combining them makes setting attribution ambiguous"
			));
		}
		for (n, p) in &params {
			let _ = p.set_requires_grad(prefixes.iter().any(|x| n.starts_with(x)));
		}
		if !params.iter().any(|(_, p)| p.requires_grad()) {
			return Err(fail!("train.trainable_only_prefixes={prefixes:?} matched no params"));
		}
	}
	Ok(())
}

/// `build_optimization`: the groups, the schedule, and the config's rates for a resume's restamp.
pub fn build_optimization(run: &RunConfig, model: &CoarseEncoder) -> Result<(AdamW, LambdaLr, Vec<f64>)> {
	let trainable: Vec<(String, Tensor)> = model
		.store
		.parameters()
		.into_iter()
		.filter(|(_, p)| p.requires_grad())
		.collect();
	let groups = build_groups(
		trainable,
		run.train_f64("learning_rate")?,
		run.train_f64("weight_decay")?,
		run.train_opt_f64("span_head_learning_rate")?,
		run.train_opt_f64("classifier_learning_rate")?,
	)?;
	let live: Vec<f64> = groups.iter().map(|g| g.lr).collect();
	let mut optim = AdamW::new(groups);
	let schedule = Schedule::from_config(
		&run.train_str("lr_schedule")?,
		run.train_i64("warmup_steps")?,
		run.train_i64("max_steps")?,
		run.train_opt_i64("cooldown_start_step")?,
	)?;
	let scheduler = LambdaLr::new(&mut optim, schedule);
	Ok((optim, scheduler, live))
}

/// `restore_training_state`: the optimizer, the step and the schedule of a checkpoint, then the restamp.
pub fn restore_training_state(
	run: &RunConfig,
	resume_from: &Path,
	optim: &mut AdamW,
	scheduler: &mut LambdaLr,
	live: &[f64],
) -> Result<i64> {
	if resume_from.join("optimizer.json").is_file() {
		optim.load(resume_from)?;
	}
	let mut resume_step = 0;
	let state_path = resume_from.join(TRAINING_STATE);
	if state_path.is_file() {
		let state: Value = serde_json::from_str(&std::fs::read_to_string(&state_path)?)?;
		resume_step = state["step"].as_i64().unwrap_or(0);
		let drift = resume_drift(&run.config, &state["config"]);
		if drift.is_empty() {
			println!("[resume-drift] none — live config matches the checkpoint's stamped state");
		} else {
			println!(
				"[resume-drift] {} config field(s) differ from the checkpoint's stamped state:",
				drift.len()
			);
			for line in drift {
				println!("  ! {line}");
			}
		}
	}
	if resume_from.join("scheduler.json").is_file() {
		scheduler.load(resume_from)?;
	} else {
		for _ in 0..resume_step {
			scheduler.step(optim);
		}
	}
	for line in restamp_resume_lrs(optim, scheduler, live)? {
		println!("{line}");
	}
	println!("resumed at step={resume_step}");
	Ok(resume_step)
}

/// `write_corpus_record`: `CORPUS.json`, the corpus directory with its MANIFEST's sha256 and version.
pub fn write_corpus_record(corpus_dir: &str, out: &Path) -> Result<()> {
	let manifest = Path::new(corpus_dir).join("MANIFEST.json");
	let record = if manifest.is_file() {
		let bytes = std::fs::read(&manifest)?;
		let parsed: Value = serde_json::from_slice(&bytes)?;
		json!({
			"corpus_dir": corpus_dir,
			"manifest_sha256": format!("{:x}", Sha256::digest(&bytes)),
			"corpus_version": parsed.get("corpus_version").cloned().unwrap_or(Value::Null),
		})
	} else {
		json!({ "corpus_dir": corpus_dir, "manifest_sha256": null, "corpus_version": null })
	};
	std::fs::write(out.join("CORPUS.json"), serde_json::to_string_pretty(&record)? + "\n")?;
	Ok(())
}

/// The validation draw, encoded once and replayed at every evaluation (`ValidationDraw`).
pub struct ValidationDraw {
	batches: Option<Vec<TensorBatch>>,
}

impl ValidationDraw {
	pub fn new() -> Self {
		Self { batches: None }
	}

	fn batches(
		&mut self,
		sampler: &SamplerConfig,
		encoder: &RunEncoder,
		seed: i128,
		rows: Option<u64>,
		batch_size: usize,
	) -> Result<&[TensorBatch]> {
		if self.batches.is_none() {
			let mut s = Sampler::open(sampler, "val", seed, rows)?;
			let mut out = Vec::new();
			while let Some(rows) = s.next_batch(batch_size)? {
				out.push(encoder.encode(&rows)?);
			}
			self.batches = Some(out);
		}
		Ok(self.batches.as_deref().expect("set above"))
	}
}

impl Default for ValidationDraw {
	fn default() -> Self {
		Self::new()
	}
}

/// `_eval_val`: mean loss, token F1, cross-pollution and per-locale F1 over the validation draw.
pub fn evaluate(
	model: &mut CoarseEncoder,
	batches: &[TensorBatch],
	labels: &[String],
	locales: &[String],
) -> Result<Metrics> {
	model.mode = Mode::Eval;
	let device = model.device();
	let (mut loss_total, mut seen, mut rows) = (0.0, 0usize, 0i64);
	let (mut preds, mut golds, mut locale_ids, mut locale_preds) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
	let mut seq = 0usize;
	let mut has_locale_logits = false;
	for batch in batches {
		let b = batch.to_device(device);
		let out = tch::no_grad(|| model.forward(&b.inputs()))?;
		let loss = out
			.loss
			.ok_or_else(|| fail!("the validation forward returned no loss"))?;
		loss_total += loss.double_value(&[]);
		seen += 1;
		rows += b.rows();
		seq = b.labels.size()[1] as usize;
		preds.extend(Vec::<i64>::try_from(
			out.logits.argmax(-1, false).to_device(Device::Cpu).view([-1]),
		)?);
		golds.extend(Vec::<i64>::try_from(b.labels.to_device(Device::Cpu).view([-1]))?);
		locale_ids.extend(Vec::<i64>::try_from(batch.locale_ids.view([-1]))?);
		if let Some(ll) = out.locale_logits {
			has_locale_logits = true;
			locale_preds.extend(Vec::<i64>::try_from(ll.argmax(-1, false).to_device(Device::Cpu))?);
		}
	}
	if seen == 0 {
		let mut m = Metrics::new();
		m.insert("val_loss".into(), f64::NAN);
		m.insert("val_rows".into(), 0.0);
		m.insert("macro_f1".into(), 0.0);
		return Ok(m);
	}
	let mut m = token_f1(&preds, &golds, labels);
	m.insert("val_loss".into(), loss_total / seen as f64);
	m.insert("val_rows".into(), rows as f64);
	m.extend(cross_pollution(&preds, &golds, seq, Some(&locale_ids), labels, locales));
	m.extend(per_locale_tag_f1(
		&preds,
		&golds,
		seq,
		Some(&locale_ids),
		labels,
		locales,
	));
	if has_locale_logits {
		let valid: Vec<usize> = (0..locale_ids.len()).filter(|&i| locale_ids[i] != -100).collect();
		if !valid.is_empty() {
			let hits = valid.iter().filter(|&&i| locale_preds[i] == locale_ids[i]).count();
			m.insert("locale_acc".into(), f64::from(hits as f32 / valid.len() as f32));
		}
	}
	Ok(m)
}

/// Options a caller sets beside the resolved config.
#[derive(Clone, Debug, Default)]
pub struct TrainOptions {
	/// `--resume`: a checkpoint directory, or `auto` for the newest complete one under the output directory.
	pub resume: Option<String>,
	pub files: Option<DataFiles>,
	/// Run the forward pass under CPU autocast when `train.precision` is bf16 (staged comparison only).
	pub autocast_on_cpu: bool,
}

/// `train`: the supervised run, or the MLM run when `train.objective` is `mlm`.
pub fn train(run: &RunConfig, options: &TrainOptions) -> Result<()> {
	crate::callbacks::refuse_trackio(run)?;
	let seed = run.train_i64("seed")?;
	tch::manual_seed(seed);
	if run.train_str("objective")? == "mlm" {
		return crate::pretrain::pretrain(run, options);
	}
	let files = options.files.clone().unwrap_or_else(DataFiles::discover);
	let output_dir = run.output_dir()?;
	std::fs::create_dir_all(&output_dir)?;
	let corpus_dir = run
		.data_str("corpus_dir")?
		.ok_or_else(|| fail!("data.corpus_dir is empty"))?;
	write_corpus_record(&corpus_dir, &output_dir)?;
	if let Some(reason) = run.data_str("unshippable_reason")? {
		std::fs::write(
			output_dir.join("SOURCE_RIGHTS.json"),
			serde_json::to_string_pretty(&json!({"shippable": false, "unshippable_reason": reason}))? + "\n",
		)?;
		println!("UNSHIPPABLE run: {reason}");
	}
	let resume_from: Option<PathBuf> = match options.resume.as_deref() {
		None => None,
		Some("auto") => find_latest_checkpoint(&output_dir)?,
		Some(dir) => Some(PathBuf::from(dir)),
	};
	let encoder = RunEncoder::build(run, &files)?;
	let sampler = sampler_config(run, &files, &encoder.active_tags()?)?;
	encoder.verify_tokenizer_alignment(&sampler)?;
	let device = device();
	let mut model = load_or_build_model(run, &encoder, resume_from.as_deref())?;
	model.to_device(device);
	println!(
		"device={device:?} param_count={}",
		crate::callbacks::grouped(model.store.parameter_count())
	);
	apply_freezes(run, &model)?;
	let (mut optim, mut scheduler, live) = build_optimization(run, &model)?;
	println!("lr_schedule={}", run.train_str("lr_schedule")?);
	let precision = resolve_precision(run, device, options.autocast_on_cpu)?;
	let resume_step = match &resume_from {
		Some(dir) => {
			let step = restore_training_state(run, dir, &mut optim, &mut scheduler, &live)?;
			if restore_generators(dir, device, &mut [])? {
				println!(
					"[resume] generator states restored from {}",
					dir.join(RNG_STATE).display()
				);
			} else {
				println!(
					"[resume] {} holds no generator states; the generators restart from train.seed",
					dir.display()
				);
			}
			step
		}
		None => 0,
	};
	let max_steps = run.train_i64("max_steps")?;
	let params: Vec<(String, Tensor)> = model.store.parameters();
	let mut fisher = None;
	let mut fisher_window_start = None;
	if run.train_bool("fisher_capture")? {
		fisher = Some(FisherAccumulator::new(&params));
		let start = max_steps - run.train_i64("fisher_capture_last_n_steps")?;
		fisher_window_start = Some(start);
		println!("[fisher] capture armed for steps >= {}", start.max(0));
	}
	let ewc = if run.train_f64("ewc_lambda")? > 0.0 {
		let reference = run
			.train
			.get("ewc_reference")
			.and_then(Value::as_str)
			.filter(|s| !s.is_empty())
			.map(str::to_owned)
			.unwrap_or(run.train_str("init_from")?);
		let fisher_path = run
			.train
			.get("ewc_fisher_path")
			.and_then(Value::as_str)
			.unwrap_or_default();
		if fisher_path.is_empty() || reference.is_empty() {
			return Err(fail!(
				"train.ewc_lambda > 0 requires train.ewc_fisher_path and train.ewc_reference/init_from"
			));
		}
		let e = EwcPenalty::new(
			Path::new(fisher_path),
			Path::new(&reference),
			run.train_f64("ewc_lambda")?,
			device,
		)?;
		println!(
			"[ewc] λ={}, {} params braked against {reference}",
			run.train_f64("ewc_lambda")?,
			e.covered_params
		);
		Some(e)
	} else {
		None
	};

	let log_every = run.train_i64("log_every_steps")?.max(1);
	let tags = encoder.schema.set(&encoder.label_set)?.tags.clone();
	let mut callbacks: Vec<Box<dyn Callback>> = vec![
		Box::new(Console { log_every, max_steps }),
		Box::new(CsvMetrics::open(&run.csv_log_path, log_every, tags, resume_step)?),
		Box::new(Checkpointer {
			save_every: run.train_i64("save_every_steps")?.max(1),
		}),
	];
	let labels = encoder.labels()?;
	let locales = encoder.schema.locale_countries.clone();
	let curricula = Curricula {
		gazetteer: run.train_bool("gazetteer_curriculum")?,
		evidence: run.train_bool("evidence_curriculum")?,
		evidence_noise_prob: run.train_f64("evidence_noise_prob")?,
		max_steps,
	};
	let grad_clip = run.train_f64("grad_clip_norm")?;
	let eval_every = run.train_i64("eval_every_steps")?;
	let accum = precision.accum;
	let batch_size = run.train_i64("batch_size")? as usize;
	let row_limit = run.data_i64("train_rows_per_epoch")?.map(|n| n as u64);
	let mut validation = ValidationDraw::new();
	let val_rows = run.data_i64("val_rows")?.map(|n| n as u64);
	let eval_batch = run.train_i64("eval_batch_size")? as usize;
	let started = Instant::now();
	println!("max_steps={max_steps} batch_size={batch_size}");

	let mut step = resume_step;
	let mut micro_step = 0i64;
	let mut running = 0.0f64;
	let (mut train_loss, mut learning_rate) = (0.0f64, 0.0f64);
	// Every row a consumed batch held: the realized draws the exposure report counts.
	let mut realized = RealizedRows::create(&output_dir, resume_step)?;
	if step < max_steps {
		let mut batches = TrainingBatches::new(
			sampler.clone(),
			batch_size,
			i128::from(seed),
			row_limit,
			(resume_step * accum) as u64,
			CancelToken::default(),
		);
		while step < max_steps {
			let rows = batches.next_batch()?;
			realized.add(&rows)?;
			model.mode = Mode::Train;
			let mut batch = encoder.encode(&rows)?.to_device(device);
			apply_curricula(&curricula, &mut batch, step)?;
			let boundary = (micro_step + 1) % accum == 0;
			if micro_step % accum == 0 {
				optim.zero_grad();
			}
			let out = {
				let _guard = precision.autocast.map(|k| Autocast::enter(device, k)).transpose()?;
				model.forward(&batch.inputs())?
			};
			let mut loss_total = out.loss.ok_or_else(|| fail!("the training forward returned no loss"))?;
			if let Some(e) = &ewc {
				loss_total = loss_total + e.penalty(&params)?;
			}
			let loss = loss_total / accum as f64;
			loss.backward();
			micro_step += 1;
			if !boundary {
				continue;
			}
			if let (Some(f), Some(start)) = (fisher.as_mut(), fisher_window_start) {
				if step >= start {
					f.accumulate(&params);
				}
			}
			if grad_clip > 0.0 {
				let refs: Vec<&Tensor> = params.iter().map(|(_, p)| p).collect();
				clip_grad_norm(&refs, grad_clip)?;
			}
			optim.step();
			scheduler.step(&mut optim);
			step += 1;
			running += loss.double_value(&[]) * accum as f64;
			if step % log_every == 0 {
				train_loss = running / log_every as f64;
				running = 0.0;
			}
			learning_rate = scheduler.get_last_lr()[0];
			let elapsed = started.elapsed().as_secs_f64();
			let view = StepView {
				model: &model,
				optim: &optim,
				scheduler: &scheduler,
				output_dir: &output_dir,
				config: &run.config,
				vocab_size: encoder.vocab_size,
				start_step: resume_step,
				elapsed,
				train_loss,
				learning_rate,
			};
			for c in &mut callbacks {
				c.on_step_end(&view, step)?;
			}
			if step % eval_every == 0 {
				let draw = validation.batches(&sampler, &encoder, i128::from(seed + 1), val_rows, eval_batch)?;
				let metrics = evaluate(&mut model, draw, &labels, &locales)?;
				let view = StepView {
					model: &model,
					optim: &optim,
					scheduler: &scheduler,
					output_dir: &output_dir,
					config: &run.config,
					vocab_size: encoder.vocab_size,
					start_step: resume_step,
					elapsed: started.elapsed().as_secs_f64(),
					train_loss,
					learning_rate,
				};
				for c in &mut callbacks {
					c.on_eval_end(&view, step, &metrics)?;
				}
			}
		}
	}
	let _ = learning_rate;
	let final_ck = save_checkpoint(
		&model,
		&output_dir,
		step,
		&checkpoint_extras(step, &run.config, encoder.vocab_size),
		Some(&optim),
		Some(&scheduler),
		&[],
	)?;
	if let Some(f) = &fisher {
		let mut meta = serde_json::Map::new();
		meta.insert("captured_at_step".into(), step.into());
		meta.insert(
			"window_last_n_steps".into(),
			run.train_i64("fisher_capture_last_n_steps")?.into(),
		);
		meta.insert("corpus_dir".into(), corpus_dir.clone().into());
		meta.insert("seed".into(), seed.into());
		meta.insert("output_dir".into(), output_dir.display().to_string().into());
		let path = f.save(&final_ck, meta)?;
		println!("[fisher] artifact → {} ({} batches)", path.display(), f.count);
	}
	let described = realized.finish(&output_dir, &corpus_dir, &encoder.label_set, step)?;
	println!(
		"[exposure] realized draws → {} (report: node packages/mailwoman/tools/training/exposure/realized.run.ts {})",
		described.display(),
		described.display()
	);
	for c in &mut callbacks {
		c.on_train_end()?;
	}
	Ok(())
}
