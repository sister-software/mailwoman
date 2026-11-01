//! The `torch.nn` modules the encoder is built from, each constructed and applied as torch 2.13 does it.
//!
//! A constructor registers its tensors in the order the Python module registers them and draws its default
//! initialization in the same order. A forward pass issues the operations `torch.nn.functional` issues.

use crate::init;
use crate::store::Store;
use tch::{Kind, Tensor};

/// Whether the module runs as `module.train()` or `module.eval()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
	Train,
	Eval,
}

impl Mode {
	pub fn training(self) -> bool {
		self == Mode::Train
	}
}

fn name(prefix: &str, leaf: &str) -> String {
	if prefix.is_empty() {
		leaf.to_owned()
	} else {
		format!("{prefix}.{leaf}")
	}
}

fn empty(shape: &[i64]) -> Tensor {
	Tensor::empty(shape, (Kind::Float, tch::Device::Cpu))
}

/// `nn.Linear`.
pub struct Linear {
	pub weight: Tensor,
	pub bias: Option<Tensor>,
}

impl Linear {
	pub fn new(store: &mut Store, prefix: &str, in_features: i64, out_features: i64, bias: bool) -> Self {
		let weight = store.param(&name(prefix, "weight"), empty(&[out_features, in_features]));
		let bias = bias.then(|| store.param(&name(prefix, "bias"), empty(&[out_features])));
		init::kaiming_uniform_sqrt5_(&weight);
		if let Some(b) = &bias {
			init::bias_uniform_(b, &weight);
		}
		Self { weight, bias }
	}

	pub fn forward(&self, x: &Tensor) -> Tensor {
		x.linear(&self.weight, self.bias.as_ref())
	}
}

/// `nn.LayerNorm(hidden)` with the default `eps=1e-5` and an affine weight and bias.
pub struct LayerNorm {
	pub weight: Tensor,
	pub bias: Tensor,
	size: i64,
}

impl LayerNorm {
	pub fn new(store: &mut Store, prefix: &str, size: i64) -> Self {
		let weight = store.param(&name(prefix, "weight"), empty(&[size]));
		let bias = store.param(&name(prefix, "bias"), empty(&[size]));
		init::ones_(&weight);
		init::zeros_(&bias);
		Self { weight, bias, size }
	}

	pub fn forward(&self, x: &Tensor) -> Tensor {
		x.layer_norm([self.size], Some(&self.weight), Some(&self.bias), 1e-5, true)
	}
}

/// `nn.Embedding`, with an optional padding row that receives no gradient.
pub struct Embedding {
	pub weight: Tensor,
	pub padding_idx: Option<i64>,
}

impl Embedding {
	pub fn new(store: &mut Store, prefix: &str, count: i64, dim: i64, padding_idx: Option<i64>) -> Self {
		let weight = store.param(&name(prefix, "weight"), empty(&[count, dim]));
		init::normal_(&weight, 0.0, 1.0);
		if let Some(pad) = padding_idx {
			tch::no_grad(|| {
				let _ = weight.get(pad).fill_(0.0);
			});
		}
		Self { weight, padding_idx }
	}

	pub fn forward(&self, ids: &Tensor) -> Tensor {
		Tensor::embedding(&self.weight, ids, self.padding_idx.unwrap_or(-1), false, false)
	}

	pub fn num_embeddings(&self) -> i64 {
		self.weight.size()[0]
	}
}

/// `nn.Conv1d(in, out, kernel_size=k, padding=k // 2)`.
pub struct Conv1d {
	pub weight: Tensor,
	pub bias: Tensor,
	padding: i64,
}

impl Conv1d {
	pub fn new(store: &mut Store, prefix: &str, in_channels: i64, out_channels: i64, kernel: i64) -> Self {
		let weight = store.param(&name(prefix, "weight"), empty(&[out_channels, in_channels, kernel]));
		let bias = store.param(&name(prefix, "bias"), empty(&[out_channels]));
		init::kaiming_uniform_sqrt5_(&weight);
		let (fan_in, _) = init::fans(&weight);
		if fan_in != 0 {
			let bound = 1.0 / (fan_in as f64).sqrt();
			init::uniform_(&bias, -bound, bound);
		}
		Self {
			weight,
			bias,
			padding: kernel / 2,
		}
	}

	pub fn forward(&self, x: &Tensor) -> Tensor {
		x.conv1d(&self.weight, Some(&self.bias), [1], [self.padding], [1], 1)
	}
}

/// `F.dropout(x, p, training)`.
pub fn dropout(x: &Tensor, p: f64, mode: Mode) -> Tensor {
	x.dropout(p, mode.training())
}

/// `nn.MultiheadAttention(embed_dim, num_heads, dropout, batch_first=True, bias=True)` applied as self-attention
/// with a boolean key padding mask and `need_weights=False`.
pub struct MultiheadAttention {
	pub in_proj_weight: Tensor,
	pub in_proj_bias: Tensor,
	pub out_proj: Linear,
	embed_dim: i64,
	num_heads: i64,
	dropout: f64,
}

impl MultiheadAttention {
	pub fn new(store: &mut Store, prefix: &str, embed_dim: i64, num_heads: i64, dropout: f64) -> Self {
		let in_proj_weight = store.param(&name(prefix, "in_proj_weight"), empty(&[3 * embed_dim, embed_dim]));
		let in_proj_bias = store.param(&name(prefix, "in_proj_bias"), empty(&[3 * embed_dim]));
		let out_proj = Linear::new(store, &name(prefix, "out_proj"), embed_dim, embed_dim, true);
		// `_reset_parameters`.
		init::xavier_uniform_(&in_proj_weight);
		init::zeros_(&in_proj_bias);
		if let Some(b) = &out_proj.bias {
			init::zeros_(b);
		}
		Self {
			in_proj_weight,
			in_proj_bias,
			out_proj,
			embed_dim,
			num_heads,
			dropout,
		}
	}

	pub fn num_heads(&self) -> i64 {
		self.num_heads
	}

	/// The fast path `MultiheadAttention.forward` takes: eval mode, no autocast, and no gradient needed.
	fn takes_fast_path(&self, mode: Mode, autocast: bool) -> bool {
		if mode.training() || self.num_heads % 2 != 0 || autocast {
			return false;
		}
		!(crate::autocast::grad_enabled() && self.in_proj_weight.requires_grad())
	}

	/// Self-attention over `x` `(batch, seq, embed)`. `key_padding_mask` is `true` at a padded key.
	pub fn forward(&self, x: &Tensor, key_padding_mask: Option<&Tensor>, mode: Mode, autocast: bool) -> Tensor {
		// `_canonical_mask`: a boolean mask becomes 0 / -inf in the query's dtype.
		let kpm = key_padding_mask.map(|m| {
			if m.kind() == Kind::Bool {
				Tensor::zeros(m.size(), (x.kind(), m.device())).masked_fill_(m, f64::NEG_INFINITY)
			} else {
				m.shallow_clone()
			}
		});
		if self.takes_fast_path(mode, autocast) {
			let mask_type = kpm.as_ref().map(|_| 1i64);
			let (out, _) = Tensor::internal_native_multi_head_attention(
				x,
				x,
				x,
				self.embed_dim,
				self.num_heads,
				&self.in_proj_weight,
				&self.in_proj_bias,
				&self.out_proj.weight,
				self.out_proj.bias.as_ref().expect("out_proj has a bias"),
				kpm.as_ref(),
				false,
				true,
				mask_type,
			);
			return out;
		}
		let (bsz, tgt_len) = (x.size()[0], x.size()[1]);
		let embed_dim = self.embed_dim;
		let heads = self.num_heads;
		let head_dim = embed_dim / heads;
		// batch_first: (batch, seq, E) -> (seq, batch, E).
		let query = x.transpose(1, 0);
		// `_in_projection_packed` for self-attention.
		let proj = query
			.linear(&self.in_proj_weight, Some(&self.in_proj_bias))
			.unflatten(-1, [3, embed_dim])
			.unsqueeze(0)
			.transpose(0, -2)
			.squeeze_dim(-2)
			.contiguous();
		let (q, k, v) = (proj.get(0), proj.get(1), proj.get(2));
		let q = q.view([tgt_len, bsz * heads, head_dim]).transpose(0, 1);
		let src_len = k.size()[0];
		let k = k.view([src_len, bsz * heads, head_dim]).transpose(0, 1);
		let v = v.view([src_len, bsz * heads, head_dim]).transpose(0, 1);
		let attn_mask = kpm.map(|m| {
			let merged = m
				.view([bsz, 1, 1, src_len])
				.expand([-1, heads, -1, -1], false)
				.reshape([bsz * heads, 1, src_len]);
			if merged.size()[0] == 1 {
				merged.unsqueeze(0)
			} else {
				merged.view([bsz, heads, -1, src_len])
			}
		});
		let dropout_p = if mode.training() { self.dropout } else { 0.0 };
		let q = q.view([bsz, heads, tgt_len, head_dim]);
		let k = k.view([bsz, heads, src_len, head_dim]);
		let v = v.view([bsz, heads, src_len, head_dim]);
		let attn = Tensor::scaled_dot_product_attention(&q, &k, &v, attn_mask.as_ref(), dropout_p, false, None, false);
		let attn = attn.permute([2, 0, 1, 3]).reshape([bsz * tgt_len, embed_dim]);
		let attn = self.out_proj.forward(&attn).view([tgt_len, bsz, embed_dim]);
		attn.transpose(1, 0)
	}
}

/// `nn/blocks.py`'s `EncoderBlock`: one pre-norm transformer block.
pub struct EncoderBlock {
	pub ln1: LayerNorm,
	pub attn: MultiheadAttention,
	pub ln2: LayerNorm,
	pub ff_in: Linear,
	pub ff_out: Linear,
	dropout: f64,
}

impl EncoderBlock {
	pub fn new(store: &mut Store, prefix: &str, hidden: i64, heads: i64, intermediate: i64, dropout: f64) -> Self {
		let ln1 = LayerNorm::new(store, &name(prefix, "ln1"), hidden);
		let attn = MultiheadAttention::new(store, &name(prefix, "attn"), hidden, heads, dropout);
		let ln2 = LayerNorm::new(store, &name(prefix, "ln2"), hidden);
		let ff_in = Linear::new(store, &name(prefix, "ff.0"), hidden, intermediate, true);
		let ff_out = Linear::new(store, &name(prefix, "ff.3"), intermediate, hidden, true);
		Self {
			ln1,
			attn,
			ln2,
			ff_in,
			ff_out,
			dropout,
		}
	}

	pub fn forward(&self, x: &Tensor, key_padding_mask: Option<&Tensor>, mode: Mode, autocast: bool) -> Tensor {
		let h = self.ln1.forward(x);
		let attn = self.attn.forward(&h, key_padding_mask, mode, autocast);
		let x = x + dropout(&attn, self.dropout, mode);
		let h = self.ln2.forward(&x);
		let ff = self.ff_in.forward(&h).gelu("none");
		let ff = self.ff_out.forward(&dropout(&ff, self.dropout, mode));
		x + dropout(&ff, self.dropout, mode)
	}
}

/// `nn/char_cnn.py`'s `CharCNNEmbedding`: a token's vector composed from its characters.
pub struct CharCnn {
	pub char_embeddings: Embedding,
	pub convs: Vec<Conv1d>,
	pub proj: Linear,
	pad_char_id: i64,
	dropout: f64,
}

impl CharCnn {
	#[allow(clippy::too_many_arguments)]
	pub fn new(
		store: &mut Store,
		prefix: &str,
		char_vocab_size: i64,
		char_embed_dim: i64,
		hidden: i64,
		kernel_sizes: &[i64],
		pad_char_id: i64,
		dropout: f64,
	) -> Self {
		let char_embeddings = Embedding::new(
			store,
			&name(prefix, "char_embeddings"),
			char_vocab_size,
			char_embed_dim,
			Some(pad_char_id),
		);
		let per_kernel = (hidden / kernel_sizes.len() as i64).max(1);
		let convs = kernel_sizes
			.iter()
			.enumerate()
			.map(|(i, &k)| {
				Conv1d::new(
					store,
					&name(prefix, &format!("convs.{i}")),
					char_embed_dim,
					per_kernel,
					k,
				)
			})
			.collect();
		let proj = Linear::new(
			store,
			&name(prefix, "proj"),
			per_kernel * kernel_sizes.len() as i64,
			hidden,
			true,
		);
		Self {
			char_embeddings,
			convs,
			proj,
			pad_char_id,
			dropout,
		}
	}

	pub fn forward(&self, char_ids: &Tensor, mode: Mode) -> Tensor {
		let size = char_ids.size();
		let (bsz, seq, width) = (size[0], size[1], size[2]);
		let flat = char_ids.reshape([bsz * seq, width]);
		let x = self.char_embeddings.forward(&flat).transpose(1, 2);
		let pad_mask = flat.eq(self.pad_char_id).unsqueeze(1);
		let feats: Vec<Tensor> = self
			.convs
			.iter()
			.map(|conv| {
				let c = conv.forward(&x).relu().narrow(-1, 0, width.min(conv_len(&x, conv)));
				let c = c.masked_fill(&pad_mask, -1e4);
				c.max_dim(2, false).0
			})
			.collect();
		let h = dropout(&self.proj.forward(&Tensor::cat(&feats, -1)), self.dropout, mode);
		h.reshape([bsz, seq, -1])
	}
}

/// The output length of a `Conv1d` with `padding = k // 2`, which `[..., :width]` clips to the input width.
fn conv_len(x: &Tensor, conv: &Conv1d) -> i64 {
	let k = conv.weight.size()[2];
	x.size()[2] + 2 * (k / 2) - k + 1
}
