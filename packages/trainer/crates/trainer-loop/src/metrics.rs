//! `evaluation/metrics.py`: the token F1, the cross-pollution rate and the per-locale tag F1 a run logs, and the
//! CSV eval row. Counts are integers and the ratios are float32, as the Python tensors compute them.

use std::collections::BTreeMap;
use trainer_model::encoder::IGNORE_INDEX;

/// A run's metrics by the names the Python dict uses.
pub type Metrics = BTreeMap<String, f64>;

fn counts(preds: &[i64], labels: &[i64], num_labels: usize) -> (Vec<i64>, Vec<i64>, Vec<i64>) {
	let (mut tp, mut fp, mut fn_) = (vec![0i64; num_labels], vec![0i64; num_labels], vec![0i64; num_labels]);
	for (&p, &y) in preds.iter().zip(labels) {
		if y == IGNORE_INDEX {
			continue;
		}
		for c in 0..num_labels as i64 {
			let (pc, yc) = (p == c, y == c);
			let i = c as usize;
			if pc && yc {
				tp[i] += 1;
			} else if pc {
				fp[i] += 1;
			} else if yc {
				fn_[i] += 1;
			}
		}
	}
	(tp, fp, fn_)
}

/// `token_f1` over flattened predictions and labels.
pub fn token_f1(preds: &[i64], labels: &[i64], bio_labels: &[String]) -> Metrics {
	let n = bio_labels.len();
	let (tp, fp, fn_) = counts(preds, labels, n);
	let f1: Vec<f32> = (0..n)
		.map(|c| {
			let (t, f, m) = (tp[c] as f32, fp[c] as f32, fn_[c] as f32);
			let precision = t / (t + f + 1e-9);
			let recall = t / (t + m + 1e-9);
			2.0 * precision * recall / (precision + recall + 1e-9)
		})
		.collect();
	let mut out = Metrics::new();
	let supported: Vec<usize> = (0..n).filter(|&c| bio_labels[c] != "O" && tp[c] + fn_[c] > 0).collect();
	let macro_f1 = if supported.is_empty() {
		0.0
	} else {
		supported.iter().map(|&c| f64::from(f1[c])).sum::<f64>() / supported.len() as f64
	};
	out.insert("macro_f1".into(), macro_f1);
	for c in 0..n {
		out.insert(format!("f1.{}", bio_labels[c]), f64::from(f1[c]));
	}
	let index = |label: &str| bio_labels.iter().position(|l| l == label);
	let mut tags: Vec<&str> = Vec::new();
	for label in bio_labels {
		if let Some((_, tag)) = label.split_once('-') {
			if !tags.contains(&tag) {
				tags.push(tag);
			}
		}
	}
	for tag in tags {
		let b = index(&format!("B-{tag}"));
		let i = index(&format!("I-{tag}"));
		let f = |x: Option<usize>| x.map(|c| f64::from(f1[c])).unwrap_or(0.0);
		let sum = |x: Option<usize>, v: &dyn Fn(usize) -> i64| x.map(v).unwrap_or(0);
		out.insert(format!("f1_tag.{tag}"), (f(b) + f(i)) / 2.0);
		let support = |c: usize| tp[c] + fn_[c];
		let pred = |c: usize| tp[c] + fp[c];
		let fps = |c: usize| fp[c];
		out.insert(
			format!("support_tag.{tag}"),
			(sum(b, &support) + sum(i, &support)) as f64,
		);
		out.insert(format!("pred_tag.{tag}"), (sum(b, &pred) + sum(i, &pred)) as f64);
		out.insert(format!("fp_tag.{tag}"), (sum(b, &fps) + sum(i, &fps)) as f64);
	}
	out
}

/// `cross_pollution`: a gold city or region start predicted as postcode, overall and per locale.
pub fn cross_pollution(
	preds: &[i64],
	labels: &[i64],
	seq: usize,
	row_locale: Option<&[i64]>,
	bio_labels: &[String],
	locales: &[String],
) -> Metrics {
	let id = |l: &str| bio_labels.iter().position(|b| b == l).map(|i| i as i64).unwrap_or(-1);
	let starts = [id("B-locality"), id("B-region")];
	let postcode = [id("B-postcode"), id("I-postcode")];
	let start: Vec<bool> = labels.iter().map(|y| starts.contains(y)).collect();
	let polluted: Vec<bool> = preds
		.iter()
		.zip(&start)
		.map(|(p, &s)| s && postcode.contains(p))
		.collect();
	let rate = |sel: &dyn Fn(usize) -> bool| -> Option<f64> {
		let denom = (0..start.len()).filter(|&i| start[i] && sel(i)).count();
		let num = (0..start.len()).filter(|&i| polluted[i] && sel(i)).count();
		(denom > 0).then(|| num as f64 / denom as f64)
	};
	let mut out = Metrics::new();
	if !start.iter().any(|&s| s) {
		return out;
	}
	out.insert("cross_pollution".into(), rate(&|_| true).unwrap_or(0.0));
	if let Some(rows) = row_locale {
		let mut ids: Vec<i64> = rows.to_vec();
		ids.sort_unstable();
		ids.dedup();
		for lid in ids {
			if lid < 0 || lid as usize >= locales.len() {
				continue;
			}
			if let Some(r) = rate(&|i| rows[i / seq] == lid) {
				out.insert(format!("cross_pollution.{}", locales[lid as usize]), r);
			}
		}
	}
	out
}

/// `per_locale_tag_f1` for `street` and `house_number`.
pub fn per_locale_tag_f1(
	preds: &[i64],
	labels: &[i64],
	seq: usize,
	row_locale: Option<&[i64]>,
	bio_labels: &[String],
	locales: &[String],
) -> Metrics {
	let mut out = Metrics::new();
	let Some(rows) = row_locale else {
		return out;
	};
	let mut ids: Vec<i64> = rows.to_vec();
	ids.sort_unstable();
	ids.dedup();
	for lid in ids {
		if lid < 0 || lid as usize >= locales.len() {
			continue;
		}
		let locale = &locales[lid as usize];
		let selected: Vec<usize> = (0..rows.len()).filter(|&r| rows[r] == lid).collect();
		out.insert(format!("rows.{locale}"), selected.len() as f64);
		let (mut p, mut y) = (Vec::new(), Vec::new());
		for r in &selected {
			p.extend_from_slice(&preds[r * seq..(r + 1) * seq]);
			y.extend_from_slice(&labels[r * seq..(r + 1) * seq]);
		}
		let scored = token_f1(&p, &y, bio_labels);
		for tag in ["street", "house_number"] {
			let support = scored.get(&format!("support_tag.{tag}")).copied().unwrap_or(0.0);
			out.insert(format!("support_tag.{tag}.{locale}"), support);
			out.insert(
				format!("pred_tag.{tag}.{locale}"),
				scored.get(&format!("pred_tag.{tag}")).copied().unwrap_or(0.0),
			);
			out.insert(
				format!("fp_tag.{tag}.{locale}"),
				scored.get(&format!("fp_tag.{tag}")).copied().unwrap_or(0.0),
			);
			if support > 0.0 {
				out.insert(format!("f1_tag.{tag}.{locale}"), scored[&format!("f1_tag.{tag}")]);
			}
		}
	}
	out
}

/// `eval_csv_row`.
pub fn eval_csv_row(step: i64, elapsed: f64, val: &Metrics, tags: &[String]) -> Vec<String> {
	let get = |k: &str, d: f64| val.get(k).copied().unwrap_or(d);
	let mut cells = vec![
		step.to_string(),
		format!("{elapsed:.1}"),
		String::new(),
		String::new(),
		format!("{:.6}", get("val_loss", f64::NAN)),
		format!("{:.6}", get("macro_f1", 0.0)),
	];
	for tag in tags {
		let supported = get(&format!("support_tag.{tag}"), 0.0) as i64 > 0;
		cells.push(if supported {
			format!("{:.6}", get(&format!("f1_tag.{tag}"), 0.0))
		} else {
			String::new()
		});
	}
	for tag in tags {
		cells.push((get(&format!("support_tag.{tag}"), 0.0) as i64).to_string());
	}
	cells
}
