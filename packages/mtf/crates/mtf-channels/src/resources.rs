// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Reading a row encoder's files: the tokenizer model, the label schema, the postcode finders, and the anchor table and
//! lexicons a run configures.
//!
//! The Node addon and the trainer build their encoder from these paths, so each file is read and parsed here, and an
//! unreadable or malformed file is refused with its path in the message.

use std::path::Path;

use mtf_core::Processor;

use crate::anchor::AnchorLookup;
use crate::encoder::{AnchorMode, Lexicons};
use crate::finders::PostalFinders;
use crate::gazetteer::Lexicon;
use crate::label_schema::LabelSchema;
use crate::Error;

/// The files a row encoder reads. An unset lexicon or anchor path leaves its channel off.
pub struct ResourcePaths<'a> {
	pub label_schema: &'a Path,
	/// The label set the labels are encoded against.
	pub label_set: &'a str,
	/// `packages/postcode/data/artifacts/postal.rca1`.
	pub postal_artifact: &'a Path,
	/// `packages/postcode/data/definitions/postal.definition.json`, which states each shape's countries and form.
	pub postal_definition: &'a Path,
	pub anchor_lookup: Option<&'a Path>,
	pub gazetteer: Option<&'a Path>,
	pub country: Option<&'a Path>,
	pub street_type: Option<&'a Path>,
	pub locality_surface: Option<&'a Path>,
}

/// What a row encoder is built from: the schema it read, the lexicons and the span finders.
pub struct EncoderResources {
	pub schema: LabelSchema,
	pub lexicons: Lexicons,
	pub finders: PostalFinders,
}

fn read(path: &Path) -> Result<String, Error> {
	std::fs::read_to_string(path).map_err(|e| Error::Input(format!("cannot read {}: {e}", path.display())))
}

fn named(path: &Path) -> String {
	path.display().to_string()
}

/// Reads `packages/neural/data/label-schema.v1.json` or a copy of it.
pub fn read_label_schema(path: &Path) -> Result<LabelSchema, Error> {
	LabelSchema::from_json(&read(path)?)
}

/// Reads a SentencePiece `tokenizer.model`.
pub fn read_processor(path: &Path) -> Result<Processor, Error> {
	let bytes = std::fs::read(path).map_err(|e| Error::Input(format!("cannot read {}: {e}", path.display())))?;
	Processor::from_model_proto(&bytes).map_err(|e| Error::Input(format!("{}: {e}", path.display())))
}

fn lexicon(path: Option<&Path>) -> Result<Option<Lexicon>, Error> {
	path.map(|p| Lexicon::from_json(&read(p)?, &named(p))).transpose()
}

impl EncoderResources {
	/// Reads every file `paths` names.
	pub fn load(paths: &ResourcePaths<'_>) -> Result<Self, Error> {
		let schema = read_label_schema(paths.label_schema)?;
		let labels = schema.label_table(paths.label_set)?;
		let anchor = paths
			.anchor_lookup
			.map(|p| AnchorLookup::from_json(&read(p)?, &named(p)))
			.transpose()?;
		let artifact = std::fs::read(paths.postal_artifact)
			.map_err(|e| Error::Input(format!("cannot read {}: {e}", paths.postal_artifact.display())))?;
		let finders = PostalFinders::load(
			&artifact,
			&named(paths.postal_artifact),
			&read(paths.postal_definition)?,
			&named(paths.postal_definition),
		)?;
		let lexicons = Lexicons {
			labels,
			locales: schema.locale_countries.clone(),
			anchor,
			gazetteer: lexicon(paths.gazetteer)?,
			country: lexicon(paths.country)?,
			street_type: lexicon(paths.street_type)?,
			locality_surface: lexicon(paths.locality_surface)?,
		};
		Ok(Self {
			schema,
			lexicons,
			finders,
		})
	}
}

impl AnchorMode {
	/// `gold`, the mode an unset value reads as, or `postal`.
	///
	/// `shaped` read the retired shape table, which no encoder reads now: a config that sets it names the mode
	/// `postal` instead, and the model that trains on it declares `requires.anchor.span_mode: "postal"`.
	pub fn parse(mode: Option<&str>) -> Result<Self, Error> {
		match mode {
			None | Some("gold") => Ok(Self::Gold),
			Some("postal") => Ok(Self::Postal),
			Some("shaped") => Err(Error::Input(
				"anchor paint mode \"shaped\" is retired: the encoder paints the postcode spans of the postal family, \
				 which the mode \"postal\" selects"
					.into(),
			)),
			Some(other) => Err(Error::Input(format!(
				"anchor paint mode {other:?} is not \"gold\" or \"postal\""
			))),
		}
	}
}
