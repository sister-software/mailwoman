// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! A split read hands out integer-list columns as integers, and a keep filter converts only the rows it admits.
mod common;

use common::{build_reference_corpus, config};
use mtf_sampler::split_columns::{ColumnValues, KeepRows, SplitColumns};
use serde_json::json;

fn read_all(reader: &mut SplitColumns) -> Vec<(String, ColumnValues)> {
	let mut out: Vec<(String, ColumnValues)> = Vec::new();
	while let Some(chunk) = reader.next_chunk().unwrap() {
		for (name, values) in chunk.columns {
			match out.iter_mut().find(|(n, _)| *n == name) {
				Some((_, ColumnValues::Strings(all))) => {
					let ColumnValues::Strings(v) = values else {
						panic!("mixed kinds")
					};
					all.extend(v);
				}
				Some((_, ColumnValues::IntLists(all))) => {
					let ColumnValues::IntLists(v) = values else {
						panic!("mixed kinds")
					};
					all.extend(v);
				}
				Some((_, ColumnValues::Lists(all))) => {
					let ColumnValues::Lists(v) = values else {
						panic!("mixed kinds")
					};
					all.extend(v);
				}
				None => out.push((name, values)),
			}
		}
	}
	out
}

#[test]
fn span_offsets_arrive_as_integer_lists() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = build_reference_corpus(dir.path());
	let columns = ["span_starts".to_owned(), "span_tags".to_owned()];
	let mut reader = SplitColumns::open(&config(&corpus, json!({})), "train", &columns).unwrap();
	let all = read_all(&mut reader);
	let ColumnValues::IntLists(starts) = &all[0].1 else {
		panic!("span_starts is not an integer list")
	};
	assert_eq!(starts.len(), 72);
	assert!(starts.iter().all(|s| s.as_ref().is_some_and(|s| s[0] == 0)));
	assert!(matches!(all[1].1, ColumnValues::Lists(_)));
}

#[test]
fn a_keep_filter_admits_only_its_values_uppercased() {
	let dir = tempfile::tempdir().unwrap();
	let corpus = build_reference_corpus(dir.path());
	let columns = ["country".to_owned()];
	let cfg = config(&corpus, json!({}));
	let keep = KeepRows {
		column: "country".into(),
		values: ["FR".to_owned()].into_iter().collect(),
	};
	let mut kept = SplitColumns::open_keeping(&cfg, "train", &columns, Some(keep)).unwrap();
	let mut every = SplitColumns::open(&cfg, "train", &columns).unwrap();
	let ColumnValues::Strings(kept) = &read_all(&mut kept)[0].1 else {
		panic!()
	};
	let ColumnValues::Strings(every) = &read_all(&mut every)[0].1 else {
		panic!()
	};
	let french: Vec<_> = every.iter().filter(|c| c.as_deref() == Some("FR")).cloned().collect();
	assert!(!french.is_empty());
	assert_eq!(kept, &french);
}
