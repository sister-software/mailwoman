//! The MLM pre-training run: `train/pretrain.py`.
//!
//! Every batch is masked on the CPU from the loop's own generator (`torch.Generator().manual_seed(seed)`), which
//! restarts from the seed on a resume, as in Python. One optimizer step consumes one batch: the MLM loop does not
//! accumulate gradients.

use crate::batch::RunEncoder;
use crate::checkpoint::{checkpoint_extras, find_latest_checkpoint, save_checkpoint, TRAINING_STATE};
use crate::config::{sampler_config, DataFiles, RunConfig};
use crate::masking::mask_tokens;
use crate::optim::{clip_grad_norm, AdamW, Group};
use crate::schedules::{LambdaLr, Schedule};
use crate::supervised::{build_model, device, resolve_precision, TrainOptions};
use crate::{fail, Result};
use mtf_sampler::{CancelToken, Sampler, TrainingBatches};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Instant;
use tch::{Device, Tensor};
use trainer_model::autocast::{Autocast, Generator};
use trainer_model::layers::Mode;
use trainer_model::CoarseEncoder;

/// `pretrain`.
pub fn pretrain(run: &RunConfig, options: &TrainOptions) -> Result<()> {
	let files = options.files.clone().unwrap_or_else(DataFiles::discover);
	let output_dir = run.output_dir()?;
	std::fs::create_dir_all(&output_dir)?;
	let resume: Option<PathBuf> = match options.resume.as_deref() {
		None => None,
		Some("auto") => find_latest_checkpoint(&output_dir)?,
		Some(dir) => Some(PathBuf::from(dir)),
	};
	let encoder = RunEncoder::build(run, &files)?;
	if run.char_mode()? != "off" {
		return Err(fail!(
			"the MLM objective reads SentencePiece ids; data.char_mode must be off"
		));
	}
	let mask_token_id = encoder.unk_id;
	let device = device();
	let mut model = match &resume {
		Some(dir) => {
			println!("[pretrain] resuming from {}", dir.display());
			CoarseEncoder::from_pretrained(dir, &encoder.schema.set("stage3")?.bio_labels)?
		}
		None => build_model(run, &encoder)?,
	};
	model.to_device(device);
	let precision = resolve_precision(run, device, options.autocast_on_cpu)?;
	let mask_prob = run.train_f64("mlm_mask_prob")?;
	println!(
		"[pretrain] device={device:?} params={} objective=mlm mask_prob={mask_prob} mask_token_id={mask_token_id}",
		crate::callbacks::grouped(model.store.parameter_count())
	);
	let lr = run.train_f64("learning_rate")?;
	let mut optim = AdamW::new(vec![Group {
		label: "base".into(),
		params: model.store.parameters(),
		lr,
		initial_lr: lr,
		weight_decay: run.train_f64("weight_decay")?,
	}]);
	let max_steps = run.train_i64("max_steps")?;
	let schedule = Schedule::from_config(
		&run.train_str("lr_schedule")?,
		run.train_i64("warmup_steps")?,
		max_steps,
		run.train_opt_i64("cooldown_start_step")?,
	)?;
	let mut scheduler = LambdaLr::new(&mut optim, schedule);
	let mut resume_step = 0;
	if let Some(dir) = &resume {
		if dir.join("optimizer.json").is_file() {
			optim.load(dir)?;
		}
		if dir.join(TRAINING_STATE).is_file() {
			let state: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(TRAINING_STATE))?)?;
			resume_step = state["step"].as_i64().unwrap_or(0);
		}
		if dir.join("scheduler.json").is_file() {
			scheduler.load(dir)?;
		} else {
			for _ in 0..resume_step {
				scheduler.step(&mut optim);
			}
		}
		println!("[pretrain] resumed at step={resume_step}");
	}

	let seed = run.train_i64("seed")?;
	let mut generator = Generator::new(seed as u64)?;
	let sampler = sampler_config(run, &files, &encoder.active_tags()?)?;
	let batch_size = run.train_i64("batch_size")? as usize;
	let log_every = run.train_i64("log_every_steps")?.max(1);
	let eval_every = run.train_i64("eval_every_steps")?;
	let save_every = run.train_i64("save_every_steps")?;
	let grad_clip = run.train_f64("grad_clip_norm")?;
	let vocab = encoder.vocab_size;
	let params = model.store.parameters();
	let started = Instant::now();
	let mut step = resume_step;
	let mut running = 0.0;
	if step < max_steps {
		let mut batches = TrainingBatches::new(
			sampler.clone(),
			batch_size,
			i128::from(seed),
			run.data_i64("train_rows_per_epoch")?.map(|n| n as u64),
			resume_step as u64,
			CancelToken::default(),
		);
		while step < max_steps {
			let rows = batches.next_batch()?;
			model.mode = Mode::Train;
			let batch = encoder.encode(&rows)?;
			let (masked, labels) = mask_tokens(
				&batch.input_ids,
				&batch.attention_mask,
				mask_prob,
				mask_token_id,
				vocab,
				&mut generator,
			)?;
			optim.zero_grad();
			let mask = batch.attention_mask.to_device(device);
			let out = {
				let _guard = precision.autocast.map(|k| Autocast::enter(device, k)).transpose()?;
				model.forward_mlm(&masked.to_device(device), Some(&mask), Some(&labels.to_device(device)))
			};
			let loss = out.loss.ok_or_else(|| fail!("forward_mlm returned no loss"))?;
			loss.backward();
			if grad_clip > 0.0 {
				let refs: Vec<&Tensor> = params.iter().map(|(_, p)| p).collect();
				clip_grad_norm(&refs, grad_clip)?;
			}
			optim.step();
			scheduler.step(&mut optim);
			step += 1;
			running += loss.double_value(&[]);
			if step % log_every == 0 {
				let avg = running / log_every as f64;
				running = 0.0;
				let lr = scheduler.get_last_lr()[0];
				let ppl = avg.min(20.0).exp();
				let elapsed = started.elapsed().as_secs_f64();
				let ran = step - resume_step;
				let rate = if elapsed > 0.0 { ran as f64 / elapsed } else { 0.0 };
				let span = if resume_step != 0 {
					format!(
						" over {} since step {}",
						crate::callbacks::grouped(ran),
						crate::callbacks::grouped(resume_step)
					)
				} else {
					String::new()
				};
				println!(
					"[pretrain] step {step}/{max_steps} mlm_loss={avg:.4} ppl={ppl:.1} lr={lr:.6} rate={rate:.2}/s{span}"
				);
			}
			if step % eval_every == 0 {
				let (loss, ppl) = mlm_eval(&mut model, run, &encoder, &sampler, mask_prob, mask_token_id)?;
				println!("[pretrain]   [eval] {{'mlm_val_loss': {loss}, 'mlm_val_perplexity': {ppl}}}");
			}
			if step % save_every == 0 {
				save_checkpoint(
					&model,
					&output_dir,
					step,
					&checkpoint_extras(step, &run.config, vocab),
					Some(&optim),
					Some(&scheduler),
				)?;
				println!("[pretrain]   [save] checkpoint @ step {step}");
			}
		}
	}
	save_checkpoint(
		&model,
		&output_dir,
		step,
		&checkpoint_extras(step, &run.config, vocab),
		Some(&optim),
		Some(&scheduler),
	)?;
	println!("[pretrain] done @ step {step} -> {}", output_dir.display());
	Ok(())
}

/// `_mlm_eval`: MLM cross-entropy and perplexity over a bounded sample of the validation split.
fn mlm_eval(
	model: &mut CoarseEncoder,
	run: &RunConfig,
	encoder: &RunEncoder,
	sampler: &mtf_sampler::SamplerConfig,
	mask_prob: f64,
	mask_token_id: i64,
) -> Result<(f64, f64)> {
	let was_training = model.mode == Mode::Train;
	model.mode = Mode::Eval;
	let seed = run.train_i64("seed")?;
	let mut generator = Generator::new(seed as u64)?;
	let max_batches = (run.train_i64("eval_every_steps")? / 50).max(1) as usize;
	let batch_size = run.train_i64("batch_size")? as usize;
	let mut s = Sampler::open(sampler, "val", i128::from(seed), None)?;
	let (mut total, mut n) = (0.0, 0usize);
	let device = model.device();
	while let Some(rows) = s.next_batch(batch_size)? {
		let batch = encoder.encode(&rows)?;
		let (masked, labels) = mask_tokens(
			&batch.input_ids,
			&batch.attention_mask,
			mask_prob,
			mask_token_id,
			encoder.vocab_size,
			&mut generator,
		)?;
		let out = tch::no_grad(|| {
			model.forward_mlm(
				&masked.to_device(device),
				Some(&batch.attention_mask.to_device(device)),
				Some(&labels.to_device(device)),
			)
		});
		if let Some(loss) = out.loss {
			total += loss.double_value(&[]);
			n += 1;
		}
		if n >= max_batches {
			break;
		}
	}
	if was_training {
		model.mode = Mode::Train;
	}
	let avg = total / n.max(1) as f64;
	let _ = Device::Cpu;
	Ok((avg, avg.min(20.0).exp()))
}
