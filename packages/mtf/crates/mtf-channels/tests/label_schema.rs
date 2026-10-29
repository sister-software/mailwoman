// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! The committed label schema parses, and every set keeps the stage-3 labels at their stage-3 ids.

use mtf_channels::label_schema::LabelSchema;
use std::path::Path;

fn committed() -> LabelSchema {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../neural/data/label-schema.v1.json");
	let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
	LabelSchema::from_json(&text).expect("the committed label schema parses")
}

#[test]
fn every_set_extends_stage3_by_appending() {
	let schema = committed();
	let stage3 = schema.set("stage3").expect("stage3 is defined");
	assert_eq!(stage3.bio_labels.len(), 33);
	for (name, set) in &schema.label_sets {
		assert_eq!(
			&set.bio_labels[..stage3.bio_labels.len()],
			&stage3.bio_labels[..],
			"{name}"
		);
	}
}

#[test]
fn the_default_set_builds_a_label_table() {
	let schema = committed();
	assert_eq!(schema.default_label_set, "stage3");
	assert_eq!(schema.ignore_index, -100);
	let table = schema.label_table(&schema.default_label_set).expect("stage3 table");
	assert_eq!(table.span_tag("street"), Some(8));
	assert_eq!(table.collapse("B-prefecture"), None);
	let jp = schema.label_table("stage3-jp").expect("stage3-jp table");
	assert_eq!(jp.span_tag("prefecture"), Some(16));
}

#[test]
fn another_layout_version_and_a_wrong_expansion_are_refused() {
	let v2 =
		r#"{"schema_version":2,"default_label_set":"a","ignore_index":-100,"locale_countries":[],"label_sets":{}}"#;
	assert!(LabelSchema::from_json(v2)
		.unwrap_err()
		.to_string()
		.contains("schema_version"));
	let wrong = r#"{"schema_version":1,"default_label_set":"a","ignore_index":-100,"locale_countries":[],
		"label_sets":{"a":{"tags":["x"],"bio_labels":["O","I-x","B-x"]}}}"#;
	assert!(LabelSchema::from_json(wrong)
		.unwrap_err()
		.to_string()
		.contains("BIO expansion"));
	let unknown = r#"{"schema_version":1,"default_label_set":"a","ignore_index":-100,"locale_countries":[],
		"label_sets":{"a":{"tags":[],"bio_labels":["O"]}},"conventions_forbidden_tags":{}}"#;
	let schema = LabelSchema::from_json(unknown).expect("parses");
	assert!(schema.set("b").unwrap_err().to_string().contains("defined: a"));
}

#[test]
fn the_conventions_table_is_read_in_locale_order_and_required() {
	let schema = committed();
	let by_locale = schema.conventions_by_locale();
	assert_eq!(by_locale.len(), schema.locale_countries.len());
	for (country, tags) in schema.locale_countries.iter().zip(&by_locale) {
		assert_eq!(
			tags,
			&schema
				.conventions_forbidden_tags
				.get(country)
				.cloned()
				.unwrap_or_default(),
			"{country}"
		);
	}
	let missing = r#"{"schema_version":1,"default_label_set":"a","ignore_index":-100,"locale_countries":["FR"],
		"label_sets":{"a":{"tags":[],"bio_labels":["O"]}}}"#;
	assert!(LabelSchema::from_json(missing)
		.unwrap_err()
		.to_string()
		.contains("conventions_forbidden_tags"));
	let stray = r#"{"schema_version":1,"default_label_set":"a","ignore_index":-100,"locale_countries":["FR"],
		"label_sets":{"a":{"tags":[],"bio_labels":["O"]}},"conventions_forbidden_tags":{"XX":["street"]}}"#;
	assert!(LabelSchema::from_json(stray)
		.unwrap_err()
		.to_string()
		.contains("not a locale country"));
}
