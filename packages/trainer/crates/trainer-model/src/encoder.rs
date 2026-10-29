//! `MailwomanCoarseEncoder`: construction, the supervised forward pass with its losses, and the MLM forward pass.
//!
//! Construction registers every tensor in the order `nn/encoder/model.py` does and draws every default
//! initialization, then `_init_weights`, then the address-system modules, so the generator ends where the Python
//! constructor leaves it. The forward pass issues `channels.py`, `model.py`, `losses.py` and
//! `address_system.py`'s operations in their order.

use crate::autocast::Autocast;
use crate::config::EncoderSpec;
use crate::crf::{LinearChainCrf, Reduction};
use crate::init;
use crate::layers::{dropout, CharCnn, Embedding, EncoderBlock, LayerNorm, Linear, Mode};
use crate::store::Store;
use crate::{fail, Result};
use tch::{Device, Kind, Tensor};

/// The ignore index of every label tensor, `labels.IGNORE_INDEX`.
pub const IGNORE_INDEX: i64 = -100;

/// The soft-feed channels in the order the encoder injects them, with each one's module prefix.
pub const CHANNELS: [&str; 6] = [
	"anchor",
	"gazetteer",
	"country",
	"street_type",
	"locality_surface",
	"code_unit",
];

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
	/// `ce`, `affix`, `crf`, `locale`, `span_boundary`, `address_system`, `mlm`: each unweighted term computed.
	pub terms: Vec<(&'static str, Tensor)>,
}

struct Channel {
	projection: Linear,
	cue: Tensor,
	dim: i64,
}

struct Head2 {
	first: Linear,
	second: Linear,
}

impl Head2 {
	fn forward(&self, x: &Tensor, mode: Mode) -> Tensor {
		self.second.forward(&dropout(&self.first.forward(x).gelu("none"), 0.1, mode))
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
	affix_head: Option<Head2>,
	affix_label_ids: Option<Tensor>,
	affix_target_lut: Option<Tensor>,
	deploc_head: Option<Head2>,
	deploc_label_ids: Option<Tensor>,
	span_boundary_head: Option<Linear>,
	bio_is_begin: Option<Tensor>,
	bio_is_inside: Option<Tensor>,
	pub crf: Option<LinearChainCrf>,
	locale_head: Option<Linear>,
	locale_film: Option<Linear>,
	address_system_head: Option<Linear>,
	locale_hint_embedding: Option<Embedding>,
	device: Device,
}

fn label_index(labels: &[String], label: &str) -> Result<i64> {
	labels
		.iter()
		.position(|l| l == label)
		.map(|i| i as i64)
		.ok_or_else(|| fail!("the label set has no {label}"))
}

impl CoarseEncoder {
	/// Builds the encoder on the CPU, drawing its initialization from the global generator as Python does.
	pub fn new(spec: EncoderSpec) -> Result<Self> {
		let spec = spec;
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
		// `_build_channels`.
		let dims = spec.channel_dims();
		let mut channels: [Option<Channel>; 6] = Default::default();
		let mut country_feature_scale = None;
		for (i, name) in CHANNELS.iter().enumerate() {
			if dims[i] > 0 {
				let projection = Linear::new(&mut s, &format!("{name}_projection"), dims[i], h, true);
				let cue = s.param(&format!("{name}_token_embedding"), Tensor::zeros([h], (Kind::Float, Device::Cpu)));
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
		let (mut affix_head, mut affix_label_ids, mut affix_target_lut) = (None, None, None);
		if spec.use_affix_head {
			let affix_in = h + if dims[1] > 0 { dims[1] } else { 5 };
			affix_head = Some(Head2 {
				first: Linear::new(&mut s, "affix_head.0", affix_in, 256, true),
				second: Linear::new(&mut s, "affix_head.3", 256, 5, true),
			});
			let ids = ["B-street_prefix", "I-street_prefix", "B-street_suffix", "I-street_suffix"]
				.iter()
				.map(|l| label_index(&labels, l))
				.collect::<Result<Vec<i64>>>()?;
			let mut lut = vec![0i64; n_labels as usize];
			for (k, &id) in ids.iter().enumerate() {
				lut[id as usize] = k as i64 + 1;
			}
			affix_label_ids = Some(s.buffer("affix_label_ids", Tensor::from_slice(&ids), false));
			affix_target_lut = Some(s.buffer("affix_target_lut", Tensor::from_slice(&lut), false));
		}
		let (mut deploc_head, mut deploc_label_ids) = (None, None);
		if spec.use_deploc_head {
			deploc_head = Some(Head2 {
				first: Linear::new(&mut s, "deploc_head.0", h, 256, true),
				second: Linear::new(&mut s, "deploc_head.3", 256, 3, true),
			});
			let ids = [
				label_index(&labels, "B-dependent_locality")?,
				label_index(&labels, "I-dependent_locality")?,
			];
			deploc_label_ids = Some(s.buffer("deploc_label_ids", Tensor::from_slice(&ids), false));
		}
		// `_build_structured_heads`.
		let (mut span_boundary_head, mut bio_is_begin, mut bio_is_inside) = (None, None, None);
		if spec.use_span_boundary_head {
			span_boundary_head = Some(Linear::new(&mut s, "span_boundary_head", h, 2, true));
			let begin: Vec<bool> = labels.iter().map(|l| l.starts_with("B-")).collect();
			let inside: Vec<bool> = labels.iter().map(|l| l.starts_with("I-")).collect();
			bio_is_begin = Some(s.buffer("bio_is_begin", Tensor::from_slice(&begin), false));
			bio_is_inside = Some(s.buffer("bio_is_inside", Tensor::from_slice(&inside), false));
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
			affix_head,
			affix_label_ids,
			affix_target_lut,
			deploc_head,
			deploc_label_ids,
			span_boundary_head,
			bio_is_begin,
			bio_is_inside,
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
	pub fn from_pretrained(dir: &std::path::Path, default_labels: &[String]) -> Result<Self> {
		let text = std::fs::read_to_string(dir.join("config.json"))?;
		let spec = EncoderSpec::from_checkpoint_config(&text, default_labels)?;
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
			if *name == "anchor" && self.spec.inject_first_token && self.spec.use_postcode_anchor {
				let conf = match &input.confidence {
					Some(c) if input.features.is_some() => c.to_kind(h.kind()),
					_ => self.zeros(&[bsz, seq], h.kind()),
				};
				let (max_conf, max_idx) = conf.max_dim(1, false);
				let idx = max_idx.view([bsz, 1, 1]).expand([bsz, 1, h.size()[2]], false);
				let pooled = vector.gather(1, &idx, false).squeeze_dim(1);
				let pos0 = (max_conf.unsqueeze(-1) * pooled).unsqueeze(1);
				let indicator = Tensor::arange(seq, (Kind::Int64, self.device))
					.eq(0)
					.to_kind(h.kind())
					.view([1, seq, 1]);
				h = &h + pos0 * indicator;
			}
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
		let mut logits = self.classifier.forward(&h);
		let mut affix_logits = None;
		if let (Some(head), Some(ids)) = (&self.affix_head, &self.affix_label_ids) {
			let (bsz, seq) = (h.size()[0], h.size()[1]);
			let gaz = match &inputs.channels[1].features {
				Some(g) => g.shallow_clone(),
				None => {
					let d = if self.spec.use_gazetteer_anchor {
						self.spec.gazetteer_feature_dim
					} else {
						5
					};
					self.zeros(&[bsz, seq, d], h.kind())
				}
			};
			let a = head.forward(&Tensor::cat(&[&h, &gaz.to_kind(h.kind())], -1), self.mode);
			let mut merged = logits.copy();
			let _ = merged.index_put_(&[None, None, Some(ids)], &a.narrow(-1, 1, 4), false);
			logits = merged;
			affix_logits = Some(a);
		}
		if let (Some(head), Some(ids)) = (&self.deploc_head, &self.deploc_label_ids) {
			let d = head.forward(&h, self.mode);
			let mut merged = logits.copy();
			let _ = merged.index_put_(&[None, None, Some(ids)], &d.narrow(-1, 1, 2), false);
			logits = merged;
		}
		let mut terms = Vec::new();
		let loss = self.compute_losses(&h, &logits, inputs, locale_logits.as_ref(), affix_logits.as_ref(), &mut terms)?;
		let loss = self.address_system_loss(loss, address_system_logits.as_ref(), inputs, &mut terms);
		Ok(EncoderOutput {
			logits,
			loss,
			locale_logits,
			address_system_logits,
			terms,
		})
	}

	/// `_compute_losses` and `_add_auxiliary_losses`.
	fn compute_losses(
		&self,
		hidden: &Tensor,
		logits: &Tensor,
		inputs: &EncoderInputs,
		locale_logits: Option<&Tensor>,
		affix_logits: Option<&Tensor>,
		terms: &mut Vec<(&'static str, Tensor)>,
	) -> Result<Option<Tensor>> {
		let n = self.spec.num_labels();
		let mut loss: Option<Tensor> = None;
		if let Some(labels) = &inputs.labels {
			let mut ce = logits.view([-1, n]).cross_entropy_loss(
				&labels.view([-1]),
				self.class_weights.as_ref(),
				tch::Reduction::Mean,
				IGNORE_INDEX,
				self.spec.label_smoothing,
			);
			terms.push(("ce", ce.shallow_clone()));
			if let (Some(a), Some(lut)) = (affix_logits, &self.affix_target_lut) {
				let safe = labels.clamp_min(0);
				let targets = lut.index(&[Some(&safe)]);
				let targets = targets.full_like(IGNORE_INDEX).where_self(&labels.eq(IGNORE_INDEX), &targets);
				let affix = a.view([-1, 5]).cross_entropy_loss::<Tensor>(
					&targets.view([-1]),
					None,
					tch::Reduction::Mean,
					IGNORE_INDEX,
					0.0,
				);
				terms.push(("affix", affix.shallow_clone()));
				ce = ce + affix;
			}
			loss = Some(match (&self.crf, &inputs.attention_mask) {
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
			});
		}
		// Locale cross-entropy, in fp32.
		if let (Some(ll), Some(ids)) = (locale_logits, &inputs.locale_ids) {
			if self.spec.use_locale_conditioning
				&& self.spec.locale_loss_weight > 0.0
				&& ids.ne(IGNORE_INDEX).any().int64_value(&[]) != 0
			{
				let locale = ll.to_kind(Kind::Float).cross_entropy_loss::<Tensor>(
					ids,
					None,
					tch::Reduction::Mean,
					IGNORE_INDEX,
					0.0,
				);
				terms.push(("locale", locale.shallow_clone()));
				let term = locale * self.spec.locale_loss_weight;
				loss = Some(match loss {
					None => term,
					Some(l) => {
						let k = l.kind();
						l + term.to_kind(k)
					}
				});
			}
		}
		// Span-boundary BCE.
		if let (Some(head), Some(labels), Some(mask), Some(is_begin), Some(is_inside)) = (
			&self.span_boundary_head,
			&inputs.labels,
			&inputs.attention_mask,
			&self.bio_is_begin,
			&self.bio_is_inside,
		) {
			if self.spec.span_boundary_loss_weight > 0.0 {
				let valid = mask.to_kind(Kind::Bool).logical_and(&labels.ne(IGNORE_INDEX));
				if valid.any().int64_value(&[]) != 0 {
					let safe = labels.clamp_min(0);
					let is_b = is_begin.index(&[Some(&safe)]);
					let is_i = is_inside.index(&[Some(&safe)]);
					let in_entity = is_b.logical_or(&is_i);
					let seq = is_i.size()[1];
					let next_is_i = is_i.zeros_like();
					let _ = next_is_i.narrow(1, 0, seq - 1).copy_(&is_i.narrow(1, 1, seq - 1));
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
					let term = sb * self.spec.span_boundary_loss_weight;
					loss = Some(match loss {
						None => term,
						Some(l) => {
							let k = l.kind();
							l + term.to_kind(k)
						}
					});
				}
			}
		}
		Ok(loss)
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
		let term = ce * self.spec.address_system_loss_weight;
		Some(match loss {
			None => term,
			Some(l) => {
				let k = l.kind();
				l + term.to_kind(k)
			}
		})
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
