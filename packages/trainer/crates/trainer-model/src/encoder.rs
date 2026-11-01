//! `MailwomanCoarseEncoder`: construction, the supervised forward pass with its losses, and the MLM forward pass.
//!
//! Construction registers every tensor in the order `nn/encoder/model.py` does and draws every default
//! initialization, then `_init_weights`, then the address-system modules, so the generator ends where the Python
//! constructor leaves it. The forward pass issues `channels.py`, `model.py`, `losses.py` and
//! `address_system.py`'s operations in their order.

use crate::autocast::Autocast;
use crate::config::{EncoderSpec, SchemaDefaults};
use crate::crf::{LinearChainCrf, Reduction};
use crate::init;
use crate::layers::{dropout, CharCnn, Embedding, EncoderBlock, LayerNorm, Linear, Mode};
use crate::span::{gold_segments, SemiMarkovCrf, SpanScorer};
use crate::store::Store;
use crate::{fail, Result};
use tch::{Device, Kind, Tensor};
use trainer_export::span::segment_types;

/// The ignore index of every label tensor, `labels.IGNORE_INDEX`.
pub const IGNORE_INDEX: i64 = -100;

// The soft-feed channels in the order the encoder injects them, each name also its module prefix.
use mtf_channels::encoder::CHANNEL_NAMES as CHANNELS;

/// A channel's features `(B, S, D)` and confidence `(B, S)`.
#[derive(Default)]
pub struct ChannelInput {
	pub features: Option<Tensor>,
	pub confidence: Option<Tensor>,
}

/// The forward pass's keyword arguments.
#[derive(Default)]
pub struct EncoderInputs {
	pub input_ids: Option<Tensor>,
	pub attention_mask: Option<Tensor>,
	pub labels: Option<Tensor>,
	pub phrase_features: Option<Tensor>,
	pub locale_ids: Option<Tensor>,
	/// In [`CHANNELS`] order.
	pub channels: [ChannelInput; 6],
	pub char_ids: Option<Tensor>,
	pub address_system_ids: Option<Tensor>,
	pub locale_hint_ids: Option<Tensor>,
}

/// `CoarseEncoderOutput`, plus each loss term the total sums, by name, for the staged comparison.
pub struct EncoderOutput {
	pub logits: Tensor,
	pub loss: Option<Tensor>,
	pub locale_logits: Option<Tensor>,
	pub address_system_logits: Option<Tensor>,
	/// The span scorer's `(B, S, max_span, T)` scores, when the model has the scorer.
	pub span_scores: Option<Tensor>,
	/// `ce`, `affix`, `crf`, `locale`, `span_boundary`, `span`, `address_system`, `mlm`: each unweighted term
	/// computed.
	pub terms: Vec<(&'static str, Tensor)>,
}

struct Channel {
	projection: Linear,
	cue: Tensor,
	dim: i64,
}

/// `_build_channels`: each enabled channel's projection and cue, and the country channel's per-feature scale.
fn build_channels(s: &mut Store, spec: &EncoderSpec) -> ([Option<Channel>; 6], Option<Tensor>) {
	let h = spec.hidden_size;
	let dims = spec.channel_dims();
	let mut channels: [Option<Channel>; 6] = Default::default();
	let mut country_feature_scale = None;
	for (i, name) in CHANNELS.iter().enumerate() {
		if dims[i] > 0 {
			let projection = Linear::new(s, &format!("{name}_projection"), dims[i], h, true);
			let cue = s.param(
				&format!("{name}_token_embedding"),
				Tensor::zeros([h], (Kind::Float, Device::Cpu)),
			);
			channels[i] = Some(Channel {
				projection,
				cue,
				dim: dims[i],
			});
		}
		if *name == "country" && dims[i] > 0 {
			let mut scale = vec![1f32; dims[i] as usize];
			if dims[i] >= 2 {
				scale[1] = spec.country_ambiguous_scale as f32;
			}
			country_feature_scale = Some(s.buffer("country_feature_scale", Tensor::from_slice(&scale), false));
		}
	}
	(channels, country_feature_scale)
}

/// `conventions_forbidden`: 1 where a locale's conventions forbid the B- or I- label of a tag.
fn build_conventions_mask(s: &mut Store, spec: &EncoderSpec, labels: &[String]) -> Result<Tensor> {
	let n_labels = spec.num_labels();
	let locales = spec.conventions.len();
	if locales as i64 != spec.num_locales {
		return Err(fail!(
			"use_conventions_loss_mask needs the conventions table for each of the {} locales, got {locales}",
			spec.num_locales
		));
	}
	let mut mask = vec![0f32; locales * n_labels as usize];
	for (locale, tags) in spec.conventions.iter().enumerate() {
		for tag in tags {
			for prefix in ["B-", "I-"] {
				if let Some(id) = labels.iter().position(|l| *l == format!("{prefix}{tag}")) {
					mask[locale * n_labels as usize + id] = 1.0;
				}
			}
		}
	}
	let mask = Tensor::from_slice(&mask).view([locales as i64, n_labels]);
	Ok(s.buffer("conventions_forbidden", mask, false))
}

/// Adds a weighted loss term to the running total, in the total's dtype, or starts the total with it.
fn add_term(loss: Option<Tensor>, term: Tensor) -> Tensor {
	match loss {
		None => term,
		Some(l) => {
			let k = l.kind();
			l + term.to_kind(k)
		}
	}
}

/// The encoder.
pub struct CoarseEncoder {
	pub spec: EncoderSpec,
	pub store: Store,
	pub mode: Mode,
	class_weights: Option<Tensor>,
	pub token_embeddings: Embedding,
	position_embeddings: Embedding,
	input_ln: LayerNorm,
	char_cnn: Option<CharCnn>,
	phrase_input_projection: Option<Linear>,
	channels: [Option<Channel>; 6],
	country_feature_scale: Option<Tensor>,
	blocks: Vec<EncoderBlock>,
	final_ln: LayerNorm,
	classifier: Linear,
	span_boundary_head: Option<Linear>,
	bio_is_begin: Option<Tensor>,
	bio_is_inside: Option<Tensor>,
	pub span_scorer: Option<SpanScorer>,
	pub semi_crf: Option<SemiMarkovCrf>,
	/// The span scorer's segment types, `O` first.
	pub segment_types: Vec<String>,
	/// `conventions_forbidden`: `(num_locales, num_labels)`, 1 where the conventions forbid the label in that locale.
	conventions_forbidden: Option<Tensor>,
	pub crf: Option<LinearChainCrf>,
	locale_head: Option<Linear>,
	locale_film: Option<Linear>,
	address_system_head: Option<Linear>,
	locale_hint_embedding: Option<Embedding>,
	device: Device,
}

impl CoarseEncoder {
	/// Builds the encoder on the CPU, drawing its initialization from the global generator as Python does.
	pub fn new(spec: EncoderSpec) -> Result<Self> {
		let mut s = Store::default();
		let h = spec.hidden_size;
		let labels = spec.id_to_label.clone();
		let n_labels = spec.num_labels();
		// `_configure_losses`.
		let class_weights = spec
			.class_weights
			.as_ref()
			.map(|w| s.buffer("class_weights", Tensor::from_slice(w), true));
		// `_build_embeddings`.
		let token_embeddings = Embedding::new(&mut s, "token_embeddings", spec.vocab_size, h, Some(spec.pad_token_id));
		let position_embeddings = Embedding::new(&mut s, "position_embeddings", spec.max_position_embeddings, h, None);
		let input_ln = LayerNorm::new(&mut s, "input_ln", h);
		let char_cnn = spec.use_char_embed.then(|| {
			CharCnn::new(
				&mut s,
				"char_cnn",
				spec.char_vocab_size,
				spec.char_embed_dim,
				h,
				&spec.char_kernel_sizes,
				0,
				spec.hidden_dropout_prob,
			)
		});
		let phrase_input_projection = spec
			.use_phrase_priors
			.then(|| Linear::new(&mut s, "phrase_input_projection", h + spec.phrase_feature_dim, h, true));
		let (channels, country_feature_scale) = build_channels(&mut s, &spec);
		// `_build_body`.
		let blocks = (0..spec.num_hidden_layers)
			.map(|i| {
				EncoderBlock::new(
					&mut s,
					&format!("blocks.{i}"),
					h,
					spec.num_attention_heads,
					spec.intermediate_size,
					spec.hidden_dropout_prob,
				)
			})
			.collect();
		let final_ln = LayerNorm::new(&mut s, "final_ln", h);
		let classifier = Linear::new(&mut s, "classifier", h, n_labels, true);
		// `_build_merge_heads`.
		let conventions_forbidden = if spec.use_conventions_loss_mask {
			Some(build_conventions_mask(&mut s, &spec, &labels)?)
		} else {
			None
		};
		// `_build_structured_heads`.
		let (mut span_boundary_head, mut bio_is_begin, mut bio_is_inside) = (None, None, None);
		if spec.use_span_boundary_head {
			span_boundary_head = Some(Linear::new(&mut s, "span_boundary_head", h, 2, true));
			let begin: Vec<bool> = labels.iter().map(|l| l.starts_with("B-")).collect();
			let inside: Vec<bool> = labels.iter().map(|l| l.starts_with("I-")).collect();
			bio_is_begin = Some(s.buffer("bio_is_begin", Tensor::from_slice(&begin), false));
			bio_is_inside = Some(s.buffer("bio_is_inside", Tensor::from_slice(&inside), false));
		}
		let types = segment_types(&labels);
		let (mut span_scorer, mut semi_crf) = (None, None);
		if spec.use_span_scorer {
			let n = types.len() as i64;
			span_scorer = Some(SpanScorer::new(
				&mut s,
				"span_scorer",
				h,
				spec.span_dim,
				spec.max_span,
				n,
			));
			semi_crf = Some(SemiMarkovCrf::new(&mut s, "semi_crf", spec.max_span, n));
		}
		let crf = spec.use_crf.then(|| LinearChainCrf::new(&mut s, "crf", &labels));
		let (locale_head, locale_film) = if spec.use_locale_conditioning {
			(
				Some(Linear::new(&mut s, "locale_head", h, spec.num_locales, true)),
				Some(Linear::new(&mut s, "locale_film", h, 2 * h, true)),
			)
		} else {
			(None, None)
		};
		let mut encoder = Self {
			spec,
			store: s,
			mode: Mode::Train,
			class_weights,
			token_embeddings,
			position_embeddings,
			input_ln,
			char_cnn,
			phrase_input_projection,
			channels,
			country_feature_scale,
			blocks,
			final_ln,
			classifier,
			span_boundary_head,
			bio_is_begin,
			bio_is_inside,
			span_scorer,
			semi_crf,
			segment_types: types,
			conventions_forbidden,
			crf,
			locale_head,
			locale_film,
			address_system_head: None,
			locale_hint_embedding: None,
			device: Device::Cpu,
		};
		encoder.init_weights();
		encoder.build_address_system();
		Ok(encoder)
	}

	/// `_init_weights`: Xavier for every matrix, zero for every vector, LayerNorms reset, small-normal embeddings.
	fn init_weights(&self) {
		for (_, p) in self.store.parameters() {
			if p.dim() > 1 {
				init::xavier_uniform_(&p);
			} else if p.dim() == 1 && p.requires_grad() {
				init::zeros_(&p);
			}
		}
		let mut norms = vec![&self.input_ln, &self.final_ln];
		for block in &self.blocks {
			norms.push(&block.ln1);
			norms.push(&block.ln2);
		}
		// `self.modules()` order: input_ln, the blocks' norms, final_ln. A reset draws nothing, so order is free.
		for ln in norms {
			init::ones_(&ln.weight);
			init::zeros_(&ln.bias);
		}
		init::normal_(&self.token_embeddings.weight, 0.0, 0.02);
		init::normal_(&self.position_embeddings.weight, 0.0, 0.02);
		if let Some(pad) = self.token_embeddings.padding_idx {
			tch::no_grad(|| {
				let _ = self.token_embeddings.weight.get(pad).zero_();
			});
		}
		if let Some(film) = &self.locale_film {
			init::zeros_(&film.weight);
			init::zeros_(film.bias.as_ref().expect("locale_film has a bias"));
		}
	}

	/// `_build_address_system`, after `_init_weights`.
	fn build_address_system(&mut self) {
		let h = self.spec.hidden_size;
		let n = self.spec.num_address_systems;
		if self.spec.use_address_system_head {
			self.address_system_head = Some(Linear::new(&mut self.store, "address_system_head", h, n, true));
		}
		if self.spec.use_locale_hint {
			self.locale_hint_embedding = Some(Embedding::new(&mut self.store, "locale_hint_embedding", n + 1, h, None));
		}
		if let Some(head) = &self.address_system_head {
			init::xavier_uniform_(&head.weight);
			init::zeros_(head.bias.as_ref().expect("the head has a bias"));
		}
		if let Some(embedding) = &self.locale_hint_embedding {
			init::zeros_(&embedding.weight);
		}
	}

	/// Builds the encoder a checkpoint directory describes and loads its weights, as `from_pretrained` does.
	pub fn from_pretrained(dir: &std::path::Path, defaults: SchemaDefaults) -> Result<Self> {
		let text = std::fs::read_to_string(dir.join("config.json"))?;
		let spec = EncoderSpec::from_checkpoint_config(&text, defaults)?;
		let model = Self::new(spec)?;
		let tensors = crate::checkpoint::read_model_tensors(dir)?;
		model.store.load(&tensors, true)?;
		Ok(model)
	}

	/// Moves the model to `device`, as `model.to(device)` does.
	pub fn to_device(&mut self, device: Device) {
		self.store.to_device(device);
		self.device = device;
	}

	pub fn device(&self) -> Device {
		self.device
	}

	pub fn hidden_size(&self) -> i64 {
		self.spec.hidden_size
	}

	fn zeros(&self, shape: &[i64], kind: Kind) -> Tensor {
		Tensor::zeros(shape, (kind, self.device))
	}

	/// `_embed_inputs`.
	fn embed_inputs(&self, inputs: &EncoderInputs) -> Result<Tensor> {
		let mode = self.mode;
		let (tok_embed, bsz, seq) = if let Some(cnn) = &self.char_cnn {
			let char_ids = inputs
				.char_ids
				.as_ref()
				.ok_or_else(|| fail!("use_char_embed=True requires char_ids (B, S, W)"))?;
			let size = char_ids.size();
			(cnn.forward(char_ids, mode), size[0], size[1])
		} else {
			let ids = inputs
				.input_ids
				.as_ref()
				.ok_or_else(|| fail!("input_ids required when use_char_embed=False"))?;
			let size = ids.size();
			(self.token_embeddings.forward(ids), size[0], size[1])
		};
		if seq > self.spec.max_position_embeddings {
			return Err(fail!(
				"sequence length {seq} exceeds max_position_embeddings {}",
				self.spec.max_position_embeddings
			));
		}
		let pos = Tensor::arange(seq, (Kind::Int64, self.device))
			.unsqueeze(0)
			.expand([bsz, seq], false);
		let mut h = tok_embed + self.position_embeddings.forward(&pos);
		match (&self.phrase_input_projection, &inputs.phrase_features) {
			(Some(proj), features) => {
				let pd = self.spec.phrase_feature_dim;
				let features = match features {
					None => self.zeros(&[bsz, seq, pd], h.kind()),
					Some(f) if f.size() != [bsz, seq, pd] => {
						return Err(fail!("phrase_features shape {:?} != ({bsz}, {seq}, {pd})", f.size()))
					}
					Some(f) => f.to_kind(h.kind()),
				};
				h = proj.forward(&Tensor::cat(&[h, features], -1));
			}
			(None, Some(_)) => {
				return Err(fail!(
					"phrase_features supplied but use_phrase_priors=False — rebuild the encoder with \
					 use_phrase_priors=True or drop the features argument"
				))
			}
			(None, None) => {}
		}
		let h = self.inject_channels(h, inputs)?;
		Ok(dropout(&self.input_ln.forward(&h), self.spec.hidden_dropout_prob, mode))
	}

	/// `_inject_channels`: each channel's `h + c · (W · features + cue)`, and the anchor's first-token injection.
	fn inject_channels(&self, mut h: Tensor, inputs: &EncoderInputs) -> Result<Tensor> {
		let (bsz, seq) = (h.size()[0], h.size()[1]);
		for (i, name) in CHANNELS.iter().enumerate() {
			let input = &inputs.channels[i];
			let Some(channel) = &self.channels[i] else {
				if input.features.is_some() {
					let flag = match *name {
						"anchor" => "use_postcode_anchor".to_owned(),
						other => format!("use_{other}_anchor"),
					};
					return Err(fail!(
						"{name}_features supplied but {flag}=False — rebuild the encoder with {flag}=True or drop \
						 the {name} arguments"
					));
				}
				continue;
			};
			let (features, confidence) = match (&input.features, &input.confidence) {
				(Some(f), Some(c)) => {
					if f.size() != [bsz, seq, channel.dim] {
						return Err(fail!(
							"{name}_features shape {:?} != ({bsz}, {seq}, {})",
							f.size(),
							channel.dim
						));
					}
					(f.shallow_clone(), c.shallow_clone())
				}
				_ => (
					self.zeros(&[bsz, seq, channel.dim], h.kind()),
					self.zeros(&[bsz, seq], h.kind()),
				),
			};
			let mut projected = features.to_kind(h.kind());
			if *name == "country" {
				if let Some(scale) = &self.country_feature_scale {
					projected = projected * scale.to_kind(h.kind());
				}
			}
			let vector = channel.projection.forward(&projected) + &channel.cue;
			h = &h + confidence.to_kind(h.kind()).unsqueeze(-1) * &vector;
		}
		Ok(h)
	}

	/// `_apply_locale_hint`.
	fn apply_locale_hint(&self, h: Tensor, inputs: &EncoderInputs) -> Tensor {
		let Some(embedding) = &self.locale_hint_embedding else {
			return h;
		};
		let n = self.spec.num_address_systems;
		let hint_ids = match (&inputs.locale_hint_ids, &inputs.address_system_ids) {
			(Some(ids), _) => ids.shallow_clone(),
			(None, Some(ids)) if self.mode.training() => training_hint_ids(
				ids,
				n,
				self.spec.locale_hint_drop_prob,
				self.spec.locale_hint_noise_prob,
			),
			_ => Tensor::full([h.size()[0]], n, (Kind::Int64, self.device)),
		};
		let hint = embedding.forward(&hint_ids).to_kind(h.kind());
		h + hint.unsqueeze(1)
	}

	/// The supervised forward pass, `MailwomanCoarseEncoder.forward`.
	pub fn forward(&self, inputs: &EncoderInputs) -> Result<EncoderOutput> {
		let autocast = Autocast::is_enabled(self.device);
		let h = self.embed_inputs(inputs)?;
		let mut h = self.apply_locale_hint(h, inputs);
		let kpm = inputs.attention_mask.as_ref().map(|m| m.eq(0));
		for block in &self.blocks {
			h = block.forward(&h, kpm.as_ref(), self.mode, autocast);
		}
		let mut h = self.final_ln.forward(&h);
		let pooled = if self.spec.use_locale_conditioning || self.spec.use_address_system_head {
			let pooled = match &inputs.attention_mask {
				Some(mask) => {
					let m = mask.to_kind(Kind::Float).unsqueeze(-1);
					(h.to_kind(Kind::Float) * &m).sum_dim_intlist(&[1i64][..], false, None)
						/ m.sum_dim_intlist(&[1i64][..], false, None).clamp_min(1.0)
				}
				None => h.to_kind(Kind::Float).mean_dim(&[1i64][..], false, None),
			};
			Some(pooled.to_kind(h.kind()))
		} else {
			None
		};
		let address_system_logits = match (&self.address_system_head, &pooled) {
			(Some(head), Some(p)) => Some(head.forward(p)),
			_ => None,
		};
		let mut locale_logits = None;
		if let (Some(p), Some(head), Some(film)) = (&pooled, &self.locale_head, &self.locale_film) {
			locale_logits = Some(head.forward(p));
			let film = film.forward(p);
			let hs = self.spec.hidden_size;
			let gamma = film.narrow(-1, 0, hs);
			let beta = film.narrow(-1, hs, hs);
			h = (gamma + 1.0).unsqueeze(1) * &h + beta.unsqueeze(1);
		}
		let logits = self.classifier.forward(&h);
		let mut terms = Vec::new();
		let (loss, span_scores) = self.compute_losses(&h, &logits, inputs, locale_logits.as_ref(), &mut terms)?;
		let loss = self.address_system_loss(loss, address_system_logits.as_ref(), inputs, &mut terms);
		Ok(EncoderOutput {
			logits,
			loss,
			locale_logits,
			address_system_logits,
			span_scores,
			terms,
		})
	}

	/// `_compute_losses` and `_add_auxiliary_losses`: the token loss, then each weighted auxiliary term in the order
	/// Python adds them.
	fn compute_losses(
		&self,
		hidden: &Tensor,
		logits: &Tensor,
		inputs: &EncoderInputs,
		locale_logits: Option<&Tensor>,
		terms: &mut Vec<(&'static str, Tensor)>,
	) -> Result<(Option<Tensor>, Option<Tensor>)> {
		let mut loss = self.token_loss(logits, inputs, terms)?;
		if let Some(term) = self.locale_loss(locale_logits, inputs, terms) {
			loss = Some(add_term(loss, term));
		}
		if let Some(term) = self.span_boundary_loss(hidden, inputs, terms) {
			loss = Some(add_term(loss, term));
		}
		let mut span_scores = None;
		if let (Some(scorer), Some(semi_crf)) = (&self.span_scorer, &self.semi_crf) {
			let scores = scorer.forward(hidden);
			if let Some(term) = self.span_loss(scorer, semi_crf, &scores, inputs, terms)? {
				loss = Some(add_term(loss, term));
			}
			span_scores = Some(scores);
		}
		Ok((loss, span_scores))
	}

	/// The cross-entropy over the labels, plus the weighted CRF negative log-likelihood when the model has a CRF.
	fn token_loss(
		&self,
		logits: &Tensor,
		inputs: &EncoderInputs,
		terms: &mut Vec<(&'static str, Tensor)>,
	) -> Result<Option<Tensor>> {
		let Some(labels) = &inputs.labels else {
			return Ok(None);
		};
		let n = self.spec.num_labels();
		// The conventions mask reaches the cross-entropy's input only; the returned logits are unmasked. An ignored
		// locale id reads locale 0's row, as `losses.py` clamps it.
		let ce_logits = match (&self.conventions_forbidden, &inputs.locale_ids) {
			(Some(forbidden), Some(ids)) => {
				let rows = forbidden.index(&[Some(&ids.clamp_min(0))]);
				logits.masked_fill(&rows.unsqueeze(1).to_kind(Kind::Bool), -1e9)
			}
			_ => logits.shallow_clone(),
		};
		let ce = ce_logits.view([-1, n]).cross_entropy_loss(
			&labels.view([-1]),
			self.class_weights.as_ref(),
			tch::Reduction::Mean,
			IGNORE_INDEX,
			self.spec.label_smoothing,
		);
		terms.push(("ce", ce.shallow_clone()));
		Ok(Some(match (&self.crf, &inputs.attention_mask) {
			(Some(crf), Some(mask)) if self.spec.crf_loss_weight > 0.0 => {
				let reduction = if self.spec.crf_normalization == "per_token" {
					Reduction::PerToken
				} else {
					Reduction::Mean
				};
				let tags = labels.clamp_min(0);
				let crf_loss = if self.spec.crf_fp32 {
					let _off = crate::autocast::AutocastOff::enter(self.device)?;
					let emissions = logits.to_kind(Kind::Float);
					crf.nll(&emissions, &tags, &mask.to_kind(Kind::Float), reduction)?
				} else {
					crf.nll(logits, &tags, &mask.to_kind(logits.kind()), reduction)?
				};
				terms.push(("crf", crf_loss.shallow_clone()));
				&ce + crf_loss.to_kind(ce.kind()) * self.spec.crf_loss_weight
			}
			_ => ce,
		}))
	}

	/// The weighted locale cross-entropy, in fp32, when a row carries a locale id.
	fn locale_loss(
		&self,
		locale_logits: Option<&Tensor>,
		inputs: &EncoderInputs,
		terms: &mut Vec<(&'static str, Tensor)>,
	) -> Option<Tensor> {
		let (ll, ids) = (locale_logits?, inputs.locale_ids.as_ref()?);
		if !self.spec.use_locale_conditioning
			|| self.spec.locale_loss_weight <= 0.0
			|| ids.ne(IGNORE_INDEX).any().int64_value(&[]) == 0
		{
			return None;
		}
		let locale =
			ll.to_kind(Kind::Float)
				.cross_entropy_loss::<Tensor>(ids, None, tch::Reduction::Mean, IGNORE_INDEX, 0.0);
		terms.push(("locale", locale.shallow_clone()));
		Some(locale * self.spec.locale_loss_weight)
	}

	/// The weighted span-boundary BCE over the valid positions.
	fn span_boundary_loss(
		&self,
		hidden: &Tensor,
		inputs: &EncoderInputs,
		terms: &mut Vec<(&'static str, Tensor)>,
	) -> Option<Tensor> {
		let (head, labels, mask, is_begin, is_inside) = (
			self.span_boundary_head.as_ref()?,
			inputs.labels.as_ref()?,
			inputs.attention_mask.as_ref()?,
			self.bio_is_begin.as_ref()?,
			self.bio_is_inside.as_ref()?,
		);
		if self.spec.span_boundary_loss_weight <= 0.0 {
			return None;
		}
		let valid = mask.to_kind(Kind::Bool).logical_and(&labels.ne(IGNORE_INDEX));
		if valid.any().int64_value(&[]) == 0 {
			return None;
		}
		let safe = labels.clamp_min(0);
		let is_b = is_begin.index(&[Some(&safe)]);
		let is_i = is_inside.index(&[Some(&safe)]);
		let in_entity = is_b.logical_or(&is_i);
		let seq = is_i.size()[1];
		let next_is_i = is_i.zeros_like();
		next_is_i.narrow(1, 0, seq - 1).copy_(&is_i.narrow(1, 1, seq - 1));
		let start = is_b.to_kind(Kind::Float);
		let end = in_entity.logical_and(&next_is_i.logical_not()).to_kind(Kind::Float);
		let sb_logits = head.forward(hidden);
		let targets = Tensor::stack(&[start, end], -1);
		let per_pos = sb_logits
			.to_kind(Kind::Float)
			.binary_cross_entropy_with_logits::<Tensor>(&targets, None, None, tch::Reduction::None)
			.mean_dim(&[-1i64][..], false, None);
		let sb = per_pos.index(&[Some(&valid)]).mean(None);
		terms.push(("span_boundary", sb.shallow_clone()));
		Some(sb * self.spec.span_boundary_loss_weight)
	}

	/// The weighted semi-Markov span loss, in fp32. A row whose gold segmentation holds a span longer than `max_span`
	/// is left out rather than truncated.
	fn span_loss(
		&self,
		scorer: &SpanScorer,
		semi_crf: &SemiMarkovCrf,
		scores: &Tensor,
		inputs: &EncoderInputs,
		terms: &mut Vec<(&'static str, Tensor)>,
	) -> Result<Option<Tensor>> {
		let (Some(labels), Some(mask)) = (&inputs.labels, &inputs.attention_mask) else {
			return Ok(None);
		};
		if self.spec.span_loss_weight <= 0.0 {
			return Ok(None);
		}
		let lengths = mask.sum_dim_intlist(&[1i64][..], false, None).to_kind(Kind::Int64);
		let lengths_cpu = Vec::<i64>::try_from(lengths.to_device(Device::Cpu))?;
		let labels_cpu = labels.to_device(Device::Cpu);
		let (mut rows, mut segments) = (Vec::new(), Vec::new());
		for (b, &n) in lengths_cpu.iter().enumerate() {
			let row = Vec::<i64>::try_from(labels_cpu.get(b as i64).narrow(0, 0, n))?;
			let (segs, representable) = gold_segments(
				&row,
				&self.spec.id_to_label,
				&self.segment_types,
				IGNORE_INDEX,
				scorer.max_span as usize,
			)?;
			if representable && !segs.is_empty() {
				rows.push(b as i64);
				segments.push(segs);
			}
		}
		if rows.is_empty() {
			return Ok(None);
		}
		let idx = Tensor::from_slice(&rows).to_device(scores.device());
		let nll = semi_crf
			.nll(&scores.index_select(0, &idx), &segments, &lengths.index_select(0, &idx))
			.mean(None);
		terms.push(("span", nll.shallow_clone()));
		Ok(Some(nll * self.spec.span_loss_weight))
	}

	/// `_address_system_loss`.
	fn address_system_loss(
		&self,
		loss: Option<Tensor>,
		logits: Option<&Tensor>,
		inputs: &EncoderInputs,
		terms: &mut Vec<(&'static str, Tensor)>,
	) -> Option<Tensor> {
		let (Some(logits), Some(ids)) = (logits, &inputs.address_system_ids) else {
			return loss;
		};
		if self.spec.address_system_loss_weight <= 0.0 || ids.ne(IGNORE_INDEX).any().int64_value(&[]) == 0 {
			return loss;
		}
		let ce = logits.to_kind(Kind::Float).cross_entropy_loss::<Tensor>(
			ids,
			None,
			tch::Reduction::Mean,
			IGNORE_INDEX,
			0.0,
		);
		terms.push(("address_system", ce.shallow_clone()));
		Some(add_term(loss, ce * self.spec.address_system_loss_weight))
	}

	/// `forward_mlm`: the tied-embedding masked-language-model pass.
	pub fn forward_mlm(
		&self,
		input_ids: &Tensor,
		attention_mask: Option<&Tensor>,
		mlm_labels: Option<&Tensor>,
	) -> EncoderOutput {
		let autocast = Autocast::is_enabled(self.device);
		let size = input_ids.size();
		let (bsz, seq) = (size[0], size[1]);
		let pos = Tensor::arange(seq, (Kind::Int64, self.device))
			.unsqueeze(0)
			.expand([bsz, seq], false);
		let h = self.token_embeddings.forward(input_ids) + self.position_embeddings.forward(&pos);
		let mut h = dropout(&self.input_ln.forward(&h), self.spec.hidden_dropout_prob, self.mode);
		let kpm = attention_mask.map(|m| m.eq(0));
		for block in &self.blocks {
			h = block.forward(&h, kpm.as_ref(), self.mode, autocast);
		}
		let h = self.final_ln.forward(&h);
		let vocab = self.token_embeddings.num_embeddings();
		let lm_logits = h.matmul(&self.token_embeddings.weight.tr());
		let mut terms = Vec::new();
		let loss = mlm_labels.map(|labels| {
			let loss = lm_logits.view([-1, vocab]).cross_entropy_loss::<Tensor>(
				&labels.view([-1]),
				None,
				tch::Reduction::Mean,
				IGNORE_INDEX,
				0.0,
			);
			terms.push(("mlm", loss.shallow_clone()));
			loss
		});
		EncoderOutput {
			logits: lm_logits,
			loss,
			locale_logits: None,
			address_system_logits: None,
			span_scores: None,
			terms,
		}
	}
}

/// `training_hint_ids`: the row's system, dropped to "no hint" or swapped for another at the given rates.
pub fn training_hint_ids(ids: &Tensor, num_systems: i64, drop_prob: f64, noise_prob: f64) -> Tensor {
	let no_hint = ids.full_like(num_systems);
	let mut hints = no_hint.where_self(&ids.eq(IGNORE_INDEX), ids);
	let draw = Tensor::rand(hints.size(), (Kind::Float, hints.device()));
	if num_systems > 1 {
		let offset = Tensor::randint_low(1, num_systems, hints.size(), (Kind::Int64, hints.device()));
		let swapped = (&hints + offset).remainder(num_systems);
		let cond = draw.lt(noise_prob).logical_and(&hints.ne(num_systems));
		hints = swapped.where_self(&cond, &hints);
	}
	let cond = draw.ge(noise_prob).logical_and(&draw.lt(noise_prob + drop_prob));
	no_hint.where_self(&cond, &hints)
}
