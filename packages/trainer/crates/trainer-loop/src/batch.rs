//! A run's batch encoding: sampled rows to the tensors `to_tensor_batch` hands the model.
//!
//! The SentencePiece path encodes through `mtf-channels` with the run's tokenizer, label table and lexicons, as
//! `build_row_encoder` configures `mailwoman_mtf.RowEncoder`. The char path encodes through `mtf-sampler`'s
//! `CharEncoder`. Both then add each row's locale id and address-system id in row order, as `encode_rows` does.

use crate::address_systems::{locale_id, AddressSystems};
use crate::config::{DataFiles, RunConfig};
use crate::{fail, Result};
use mtf_channels::anchor::AnchorLookup;
use mtf_channels::finders::{PostcodeShapes, PostcodeSyntax, RegexFinders};
use mtf_channels::gazetteer::Lexicon;
use mtf_channels::label_schema::LabelSchema;
use mtf_channels::{AnchorMode, Encoder, EncoderConfig, Finders, Lexicons};
use mtf_core::Processor;
use mtf_sampler::char_path::CharEncoder;
use mtf_sampler::Row;
use std::path::Path;
use tch::{Device, Kind, Tensor};
use trainer_model::encoder::{ChannelInput, EncoderInputs, CHANNELS};

/// One batch as the model reads it, every tensor on the CPU until moved.
pub struct TensorBatch {
	pub input_ids: Tensor,
	pub attention_mask: Tensor,
	pub labels: Tensor,
	pub locale_ids: Tensor,
	pub address_system_ids: Tensor,
	/// `(name, features, confidence)` per configured channel, in packing order.
	pub channels: Vec<(String, Tensor, Tensor)>,
	pub char_ids: Option<Tensor>,
}

impl TensorBatch {
	/// The batch as named tensors: `input_ids`, `<channel>_features`, …, in `to_tensor_batch`'s key names.
	pub fn named(&self) -> Vec<(String, Tensor)> {
		let mut out = vec![
			("input_ids".to_owned(), self.input_ids.shallow_clone()),
			("attention_mask".to_owned(), self.attention_mask.shallow_clone()),
			("labels".to_owned(), self.labels.shallow_clone()),
			("locale_ids".to_owned(), self.locale_ids.shallow_clone()),
			("address_system_ids".to_owned(), self.address_system_ids.shallow_clone()),
		];
		for (name, f, c) in &self.channels {
			out.push((format!("{name}_features"), f.shallow_clone()));
			out.push((format!("{name}_confidence"), c.shallow_clone()));
		}
		if let Some(c) = &self.char_ids {
			out.push(("char_ids".to_owned(), c.shallow_clone()));
		}
		out
	}

	/// Rebuilds a batch from named tensors, as a record stores it.
	pub fn from_named(get: impl Fn(&str) -> Option<Tensor>) -> Result<Self> {
		let need = |n: &str| get(n).ok_or_else(|| fail!("the batch has no {n}"));
		let channels = CHANNELS
			.iter()
			.filter_map(|c| {
				let f = get(&format!("{c}_features"))?;
				let conf = get(&format!("{c}_confidence"))?;
				Some(((*c).to_owned(), f, conf))
			})
			.collect();
		Ok(Self {
			input_ids: need("input_ids")?,
			attention_mask: need("attention_mask")?,
			labels: need("labels")?,
			locale_ids: need("locale_ids")?,
			address_system_ids: need("address_system_ids")?,
			channels,
			char_ids: get("char_ids"),
		})
	}

	pub fn to_device(&self, device: Device) -> Self {
		Self {
			input_ids: self.input_ids.to_device(device),
			attention_mask: self.attention_mask.to_device(device),
			labels: self.labels.to_device(device),
			locale_ids: self.locale_ids.to_device(device),
			address_system_ids: self.address_system_ids.to_device(device),
			channels: self
				.channels
				.iter()
				.map(|(n, f, c)| (n.clone(), f.to_device(device), c.to_device(device)))
				.collect(),
			char_ids: self.char_ids.as_ref().map(|c| c.to_device(device)),
		}
	}

	pub fn rows(&self) -> i64 {
		self.input_ids.size()[0]
	}

	/// The batch as the forward pass's keyword arguments.
	pub fn inputs(&self) -> EncoderInputs {
		let mut inputs = EncoderInputs {
			input_ids: Some(self.input_ids.shallow_clone()),
			attention_mask: Some(self.attention_mask.shallow_clone()),
			labels: Some(self.labels.shallow_clone()),
			locale_ids: Some(self.locale_ids.shallow_clone()),
			address_system_ids: Some(self.address_system_ids.shallow_clone()),
			char_ids: self.char_ids.as_ref().map(Tensor::shallow_clone),
			..EncoderInputs::default()
		};
		for (name, f, c) in &self.channels {
			let i = CHANNELS.iter().position(|n| n == name).expect("a known channel");
			inputs.channels[i] = ChannelInput {
				features: Some(f.shallow_clone()),
				confidence: Some(c.shallow_clone()),
			};
		}
		inputs
	}

	/// A channel's `(features, confidence)` for the curricula to replace.
	pub fn channel_mut(&mut self, name: &str) -> Option<&mut (String, Tensor, Tensor)> {
		self.channels.iter_mut().find(|(n, _, _)| n == name)
	}
}

fn read(path: &Path) -> Result<String> {
	std::fs::read_to_string(path).map_err(|e| fail!("{}: {e}", path.display()))
}

fn lexicon(path: Option<String>) -> Result<Option<Lexicon>> {
	path.map(|p| Lexicon::from_json(&read(Path::new(&p))?, &p).map_err(Into::into))
		.transpose()
}

enum Path_ {
	Pieces {
		processor: Box<Processor>,
		config: EncoderConfig,
		lexicons: Box<Lexicons>,
		finders: Box<RegexFinders>,
	},
	Char(Box<CharEncoder>),
}

/// The run's encoder, its label set, and the per-row targets.
pub struct RunEncoder {
	path: Path_,
	pub schema: LabelSchema,
	pub label_set: String,
	pub address_systems: AddressSystems,
	/// The tokenizer's vocabulary size and pad id, or the char path's dummy width and pad 0.
	pub vocab_size: i64,
	pub pad_id: i64,
	pub unk_id: i64,
	/// The char vocabulary's size, 0 on the SentencePiece path.
	pub char_vocab_size: i64,
}

impl RunEncoder {
	pub fn build(run: &RunConfig, files: &DataFiles) -> Result<Self> {
		let schema = LabelSchema::from_json(&read(&files.label_schema)?)?;
		let label_set = run.label_set()?;
		let address_systems = AddressSystems::load(&files.address_systems)?;
		let char_mode = run.char_mode()?;
		if char_mode != "off" {
			let configured: Vec<&str> = [
				"anchor_lookup_path",
				"gazetteer_lexicon_path",
				"country_lexicon_path",
				"street_type_lexicon_path",
				"locality_surface_lexicon_path",
			]
			.into_iter()
			.filter(|k| run.data_str(k).ok().flatten().is_some())
			.collect();
			if !configured.is_empty() {
				return Err(fail!(
					"data.char_mode is channel-free (channels re-align per-unit post-probe, v8 CJK plan): unset \
					 {configured:?}"
				));
			}
			let config = crate::config::sampler_config(run, files, &[])?
				.char
				.ok_or_else(|| fail!("char mode without a char config"))?;
			let set = schema.set(&label_set)?;
			let encoder = CharEncoder::with_label_set(&config, set, schema.ignore_index)?;
			let vocab: serde_json::Value = serde_json::from_str(&read(&config.vocab_path)?)?;
			let char_vocab_size = char_vocab_len(&vocab)?;
			return Ok(Self {
				path: Path_::Char(Box::new(encoder)),
				schema,
				label_set,
				address_systems,
				vocab_size: 2,
				pad_id: 0,
				unk_id: 1,
				char_vocab_size,
			});
		}
		if label_set != "stage3" {
			return Err(fail!(
				"data.label_set={label_set:?} is only supported with data.char_mode != 'off'"
			));
		}
		let tokenizer_dir = run
			.data_str("tokenizer_dir")?
			.ok_or_else(|| fail!("data.tokenizer_dir is empty"))?;
		let model_path = Path::new(&tokenizer_dir).join("tokenizer.model");
		let bytes = std::fs::read(&model_path).map_err(|e| fail!("{}: {e}", model_path.display()))?;
		let processor = Processor::from_model_proto(&bytes).map_err(|e| fail!("{}: {e}", model_path.display()))?;
		let specials = processor.special_ids();
		let anchor_mode = match run.data_str("anchor_paint_mode")?.as_deref() {
			None | Some("gold") => AnchorMode::Gold,
			Some("shaped") => AnchorMode::Shaped,
			Some(other) => return Err(fail!("anchor_paint_mode {other:?} is not \"gold\" or \"shaped\"")),
		};
		let anchor = run
			.data_str("anchor_lookup_path")?
			.map(|p| AnchorLookup::from_json(&read(Path::new(&p))?, &p).map_err(crate::Error::from))
			.transpose()?;
		let shapes_path = files.postcode_shapes.display().to_string();
		let syntax_path = files.postcode_syntax.display().to_string();
		let finders = RegexFinders {
			shapes: PostcodeShapes::from_record(&read(&files.postcode_shapes)?, &shapes_path)?,
			syntax: PostcodeSyntax::from_json(&read(&files.postcode_syntax)?, &syntax_path)?,
		};
		let lexicons = Lexicons {
			labels: schema.label_table("stage3")?,
			locales: schema.locale_countries.clone(),
			anchor,
			gazetteer: lexicon(run.data_str("gazetteer_lexicon_path")?)?,
			country: lexicon(run.data_str("country_lexicon_path")?)?,
			street_type: lexicon(run.data_str("street_type_lexicon_path")?)?,
			locality_surface: lexicon(run.data_str("locality_surface_lexicon_path")?)?,
		};
		let config = EncoderConfig {
			max_length: run
				.data_i64("max_length")?
				.ok_or_else(|| fail!("data.max_length is null"))? as usize,
			pad_id: specials.pad,
			anchor_mode,
			gazetteer_choreography: run.data_bool("gazetteer_choreography")?,
			code_units: run.data_bool("code_unit_features")?,
		};
		let out = Self {
			vocab_size: processor.vocab_size() as i64,
			pad_id: specials.pad,
			unk_id: specials.unk,
			path: Path_::Pieces {
				processor: Box::new(processor),
				config,
				lexicons: Box::new(lexicons),
				finders: Box::new(finders),
			},
			schema,
			label_set,
			address_systems,
			char_vocab_size: 0,
		};
		out.encoder_check()?;
		Ok(out)
	}

	fn encoder_check(&self) -> Result<()> {
		if let Path_::Pieces {
			config,
			lexicons,
			finders,
			..
		} = &self.path
		{
			Encoder::new(config, lexicons, Some(finders.as_ref() as &dyn Finders))?;
		}
		Ok(())
	}

	/// The stage3 tags, which the sampler's coarse filter reads.
	pub fn active_tags(&self) -> Result<Vec<String>> {
		Ok(self.schema.set("stage3")?.tags.clone())
	}

	/// The run's BIO labels in output order.
	pub fn labels(&self) -> Result<Vec<String>> {
		Ok(self.schema.set(&self.label_set)?.bio_labels.clone())
	}

	/// One batch of sampled rows as tensors.
	pub fn encode(&self, rows: &[Row]) -> Result<TensorBatch> {
		let n = rows.len() as i64;
		let locale_ids: Vec<i64> = rows
			.iter()
			.map(|r| locale_id(&self.schema.locale_countries, r.country.as_deref()))
			.collect();
		let address_system_ids: Vec<i64> = rows
			.iter()
			.map(|r| self.address_systems.id(r.country.as_deref(), &r.raw))
			.collect();
		let locale_ids = Tensor::from_slice(&locale_ids);
		let address_system_ids = Tensor::from_slice(&address_system_ids);
		match &self.path {
			Path_::Pieces {
				processor,
				config,
				lexicons,
				finders,
			} => {
				let encoder = Encoder::new(config, lexicons, Some(finders.as_ref() as &dyn Finders))?;
				let batch = mtf_sampler::batch::encode_rows(&encoder, processor, rows)?;
				let l = batch.max_length as i64;
				let channels = batch
					.channels
					.into_iter()
					.map(|c| {
						let dim = c.dim as i64;
						(
							c.name.to_owned(),
							Tensor::from_slice(&c.features).view([n, l, dim]),
							Tensor::from_slice(&c.confidence).view([n, l]),
						)
					})
					.collect();
				Ok(TensorBatch {
					input_ids: Tensor::from_slice(&batch.input_ids).view([n, l]),
					attention_mask: Tensor::from_slice(&batch.attention_mask).view([n, l]),
					labels: Tensor::from_slice(&batch.labels).view([n, l]),
					locale_ids,
					address_system_ids,
					channels,
					char_ids: None,
				})
			}
			Path_::Char(encoder) => {
				let batch = encoder.encode_batch(rows)?;
				let (s, w) = (batch.max_units as i64, batch.max_unit_width as i64);
				Ok(TensorBatch {
					input_ids: Tensor::zeros([n, s], (Kind::Int64, Device::Cpu)),
					attention_mask: Tensor::from_slice(&batch.attention_mask).view([n, s]),
					labels: Tensor::from_slice(&batch.labels).view([n, s]),
					locale_ids,
					address_system_ids,
					channels: Vec::new(),
					char_ids: Some(Tensor::from_slice(&batch.char_ids).view([n, s, w])),
				})
			}
		}
	}
}

/// `len(load_char_vocab(path))`: the entry count of the `dict[str, int]`, `<pad>` and `<unk>` included.
fn char_vocab_len(vocab: &serde_json::Value) -> Result<i64> {
	vocab
		.as_object()
		.map(|o| o.len() as i64)
		.ok_or_else(|| fail!("the char vocabulary is not a dict[str, int]"))
}
