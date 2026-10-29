// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! Lexicon channels painted over a tokenizer's pieces by the training encoder's painter, for the TypeScript inference
//! painter's parity fixture.

use crate::args::Result;
use mtf_channels::gazetteer::{paint, Lexicon};
use mtf_channels::Piece;
use mtf_core::Processor;
use mtf_sampler::batch::encode_pieces;
use serde_json::{json, Value};

/// For each text: its pieces as `{piece, start, end}` with code-point offsets, and each named lexicon's
/// `{features, confidence}`, one row per piece.
pub fn paint_texts(processor: &Processor, lexicons: &[(String, Lexicon)], texts: &[String]) -> Result<Value> {
	let mut cases = Vec::with_capacity(texts.len());
	for raw in texts {
		let encoded = encode_pieces(processor, raw).map_err(|e| e.to_string())?;
		let pieces: Vec<Piece> = encoded
			.iter()
			.map(|(id, _, begin, end)| Piece {
				id: *id,
				begin: *begin,
				end: *end,
			})
			.collect();
		let chars: Vec<char> = raw.chars().collect();
		let mut case = serde_json::Map::new();
		case.insert("raw".into(), json!(raw));
		case.insert(
			"pieces".into(),
			Value::Array(
				encoded
					.iter()
					.map(|(_, piece, begin, end)| json!({ "piece": piece, "start": begin, "end": end }))
					.collect(),
			),
		);
		for (name, lexicon) in lexicons {
			let channel = paint(&chars, &pieces, lexicon);
			let features: Vec<Value> = (0..channel.len()).map(|i| json!(channel.row(i))).collect();
			case.insert(
				name.clone(),
				json!({ "features": features, "confidence": channel.confidence }),
			);
		}
		cases.push(Value::Object(case));
	}
	Ok(Value::Array(cases))
}
