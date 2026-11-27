// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! `train.cuda_graph`: the supervised training step captured into one CUDA graph per length bucket and replayed.
//!
//! A graph replays fixed kernels on fixed addresses, so each bucket owns one static batch on the device of exactly
//! `train.batch_size` rows and the bucket's length. The loop has trimmed each batch to its longest row, rounded up to
//! a multiple of 8, before the step sees it. A step copies its batch into the static tensors of the smallest
//! bucket that holds it, padding the rest of each row (`attention_mask` 0, `labels` at the ignore index, the pad
//! token, zeros in each channel), and replays. The curricula have already run on the batch, eagerly, so their draws
//! are the eager loop's.
//!
//! The captured region is the whole optimizer step: `zero_grad` with every gradient dropped to undefined, the
//! forward under autocast with its cast cache off, `backward`, the multi-tensor gradient clip and the fused AdamW,
//! which reads each group's learning rate and step count from device tensors. The scheduler writes the next rate
//! between replays. A bucket's first [`WARMUP_STEPS`] steps run the same region eagerly on the static tensors, so
//! every lazy allocation and kernel choice is made before capture.
//!
//! A run captures only on CUDA, under the multi-tensor kernel, with `grad_accum_steps` 1, no EWC penalty and a model
//! whose forward reads nothing back to the host (`CoarseEncoder::graph_capture_blocker`). [`CaptureRefusal`] names
//! the reason a run doesn't. A captured run still takes the eager step for a batch shorter than `train.batch_size`
//! or longer than the largest bucket, and for every step in the Fisher window, which reads the gradients between
//! `backward` and the clip.

use crate::batch::TensorBatch;
use crate::optim::{clip_grad_norm, AdamW, Kernel};
use crate::{fail, Result};
use tch::{Device, Kind, Tensor};
use trainer_model::autocast::Autocast;
use trainer_model::cuda_graph::{self, CudaGraph, Pool};
use trainer_model::encoder::IGNORE_INDEX;
use trainer_model::CoarseEncoder;

/// The eager steps each bucket runs on its static tensors before its capture.
pub const WARMUP_STEPS: usize = 3;

/// What the captured step needs from the run's settings.
#[derive(Clone, Debug)]
pub struct CaptureSettings {
	/// `train.length_buckets`, ascending.
	pub buckets: Vec<i64>,
	pub batch_size: i64,
	pub pad_id: i64,
	pub autocast: Option<Kind>,
	pub grad_clip: f64,
}

/// What a run that sets `train.cuda_graph` is asked about before it captures.
pub struct CaptureRun<'a> {
	pub device: Device,
	pub kernel: Kernel,
	pub grad_accum_steps: i64,
	pub ewc: bool,
	pub model: &'a CoarseEncoder,
}

/// Why a run with `train.cuda_graph: true` takes the eager step throughout.
pub fn capture_refusal(run: &CaptureRun<'_>) -> Result<Option<String>> {
	let Device::Cuda(_) = run.device else {
		return Ok(Some(format!(
			"the run is on {:?}, and a CUDA graph needs a CUDA device",
			run.device
		)));
	};
	if !cuda_graph::compiled() {
		return Err(fail!(
			"train.cuda_graph is set and the run is on CUDA, but this trainer was built without the CUDA graph shim; \
			 rebuild it against a CUDA libtorch with the CUDA headers"
		));
	}
	if run.kernel != Kernel::MultiTensor {
		return Ok(Some(format!("the optimizer runs the {:?} kernel", run.kernel)));
	}
	if run.grad_accum_steps > 1 {
		return Ok(Some(format!(
			"train.grad_accum_steps is {}, and a captured step is one optimizer step",
			run.grad_accum_steps
		)));
	}
	if run.ewc {
		return Ok(Some("train.ewc_lambda adds an EWC penalty".to_owned()));
	}
	Ok(run.model.graph_capture_blocker().map(str::to_owned))
}

/// Reads and checks `train.length_buckets`: positive, strictly ascending, and the last at least `max_length`, so
/// every batch the encoder can produce has a bucket.
pub fn length_buckets(buckets: &[i64], max_length: i64) -> Result<Vec<i64>> {
	if buckets.is_empty() {
		return Err(fail!("train.length_buckets is empty"));
	}
	if buckets[0] <= 0 || buckets.windows(2).any(|w| w[0] >= w[1]) {
		return Err(fail!(
			"train.length_buckets must be positive and strictly ascending, got {buckets:?}"
		));
	}
	let last = *buckets.last().expect("non-empty");
	if last < max_length {
		return Err(fail!(
			"train.length_buckets ends at {last}, below data.max_length {max_length}, so a full-length batch has no bucket"
		));
	}
	Ok(buckets.to_vec())
}

/// The smallest bucket at least `length`, by index.
pub fn bucket_for(buckets: &[i64], length: i64) -> Option<usize> {
	buckets.iter().position(|&b| b >= length)
}

/// A batch's tensors on the device at one bucket's length, every row padded.
fn allocate_static(like: &TensorBatch, length: i64) -> TensorBatch {
	let rows = like.rows();
	let zeros = |t: &Tensor, shape: &[i64]| Tensor::zeros(shape, (t.kind(), t.device()));
	TensorBatch {
		input_ids: zeros(&like.input_ids, &[rows, length]),
		attention_mask: zeros(&like.attention_mask, &[rows, length]),
		labels: zeros(&like.labels, &[rows, length]),
		locale_ids: zeros(&like.locale_ids, &[rows]),
		address_system_ids: zeros(&like.address_system_ids, &[rows]),
		channels: like
			.channels
			.iter()
			.map(|(n, f, c)| {
				(
					n.clone(),
					zeros(f, &[rows, length, f.size()[2]]),
					zeros(c, &[rows, length]),
				)
			})
			.collect(),
		char_ids: None,
	}
}

/// Copies `src` `(B, L, …)` into the first `L` positions of `dst` `(B, S, …)` and fills the rest with `pad`.
fn copy_padded(dst: &Tensor, src: &Tensor, pad: f64) {
	let (length, bucket) = (src.size()[1], dst.size()[1]);
	dst.narrow(1, 0, length).copy_(src);
	if bucket > length {
		let _ = dst.narrow(1, length, bucket - length).fill_(pad);
	}
}

/// Writes `batch` into a bucket's static tensors, padded to the bucket's length.
pub fn write_padded(dst: &TensorBatch, batch: &TensorBatch, pad_id: i64) -> Result<()> {
	let names = |b: &TensorBatch| b.channels.iter().map(|(n, _, _)| n.clone()).collect::<Vec<_>>();
	if names(dst) != names(batch) {
		return Err(fail!(
			"the batch carries channels {:?}, and the captured step was built for {:?}",
			names(batch),
			names(dst)
		));
	}
	tch::no_grad(|| {
		copy_padded(&dst.input_ids, &batch.input_ids, pad_id as f64);
		copy_padded(&dst.attention_mask, &batch.attention_mask, 0.0);
		copy_padded(&dst.labels, &batch.labels, IGNORE_INDEX as f64);
		dst.locale_ids.shallow_clone().copy_(&batch.locale_ids);
		dst.address_system_ids.shallow_clone().copy_(&batch.address_system_ids);
		for ((_, df, dc), (_, sf, sc)) in dst.channels.iter().zip(&batch.channels) {
			copy_padded(df, sf, 0.0);
			copy_padded(dc, sc, 0.0);
		}
	});
	Ok(())
}

/// One optimizer step on `inputs`, the region a graph captures: zero-grad, forward, backward, clip, AdamW. Returns
/// the loss, a tensor the step allocated.
fn optimizer_step(
	model: &CoarseEncoder,
	optim: &mut AdamW,
	params: &[&Tensor],
	inputs: &TensorBatch,
	settings: &CaptureSettings,
) -> Result<Tensor> {
	optim.zero_grad();
	let out = {
		let _guard = settings
			.autocast
			.map(|k| Autocast::enter_uncached(model.device(), k))
			.transpose()?;
		model.forward(&inputs.inputs())?
	};
	let loss = out.loss.ok_or_else(|| fail!("the training forward returned no loss"))?;
	loss.backward();
	if settings.grad_clip > 0.0 {
		clip_grad_norm(params, settings.grad_clip)?;
	}
	optim.step()?;
	Ok(loss)
}

struct Bucket {
	length: i64,
	inputs: Option<TensorBatch>,
	eager_steps: usize,
	graph: Option<(CudaGraph, Tensor)>,
}

/// How a step ran.
pub enum StepPath {
	/// A replay of the bucket's graph.
	Replayed,
	/// One of the bucket's warmup steps, on its static tensors.
	Warmup,
	/// The capture, followed by its first replay.
	Captured,
}

/// The per-bucket graphs of one run.
pub struct CapturedStep {
	settings: CaptureSettings,
	device_index: usize,
	pool: Pool,
	buckets: Vec<Bucket>,
}

impl CapturedStep {
	/// Sets the model's graph-safe losses and the optimizer's device learning rates, which every step of a captured
	/// run uses, eager or replayed.
	pub fn new(
		settings: CaptureSettings,
		device: Device,
		model: &mut CoarseEncoder,
		optim: &mut AdamW,
	) -> Result<Self> {
		let Device::Cuda(device_index) = device else {
			return Err(fail!("a captured step needs a CUDA device, not {device:?}"));
		};
		if !cuda_graph::available() {
			return Err(fail!("libtorch reports no CUDA device to capture a graph on"));
		}
		model.graph_safe_losses = true;
		optim.use_tensor_learning_rates()?;
		let buckets = settings
			.buckets
			.iter()
			.map(|&length| Bucket {
				length,
				inputs: None,
				eager_steps: 0,
				graph: None,
			})
			.collect();
		Ok(Self {
			settings,
			device_index,
			pool: Pool::new()?,
			buckets,
		})
	}

	/// Why `batch` takes the eager step, or `None` when it fits a bucket.
	pub fn fallback(&self, batch: &TensorBatch) -> Option<String> {
		if batch.rows() != self.settings.batch_size {
			return Some(format!(
				"a batch of {} rows, short of train.batch_size {}",
				batch.rows(),
				self.settings.batch_size
			));
		}
		let length = batch.input_ids.size()[1];
		if bucket_for(&self.settings.buckets, length).is_none() {
			return Some(format!(
				"a batch of length {length}, beyond the largest bucket {}",
				self.settings.buckets.last().expect("non-empty")
			));
		}
		None
	}

	/// Runs one optimizer step on `batch` through its bucket: a warmup step, the capture, or a replay. The caller
	/// checked [`fallback`](Self::fallback). Returns the step's loss, which the bucket's next step overwrites.
	pub fn step(
		&mut self,
		batch: &TensorBatch,
		model: &CoarseEncoder,
		optim: &mut AdamW,
		params: &[&Tensor],
	) -> Result<(Tensor, StepPath, i64)> {
		let length = batch.input_ids.size()[1];
		let index = bucket_for(&self.settings.buckets, length)
			.ok_or_else(|| fail!("a batch of length {length} has no bucket"))?;
		let (settings, pool, device_index) = (&self.settings, self.pool, self.device_index);
		let bucket = &mut self.buckets[index];
		let inputs = bucket
			.inputs
			.get_or_insert_with(|| allocate_static(batch, bucket.length));
		write_padded(inputs, batch, settings.pad_id)?;
		if let Some((graph, loss)) = &bucket.graph {
			graph.replay()?;
			return Ok((loss.shallow_clone(), StepPath::Replayed, bucket.length));
		}
		if bucket.eager_steps < WARMUP_STEPS {
			bucket.eager_steps += 1;
			let loss = optimizer_step(model, optim, params, inputs, settings)?;
			return Ok((loss, StepPath::Warmup, bucket.length));
		}
		optim.create_missing_state();
		let mut graph = CudaGraph::new()?;
		let loss = graph.capture(device_index, pool, || {
			optimizer_step(model, optim, params, inputs, settings)
		})?;
		graph.replay()?;
		bucket.graph = Some((graph, loss.shallow_clone()));
		Ok((loss, StepPath::Captured, bucket.length))
	}
}
