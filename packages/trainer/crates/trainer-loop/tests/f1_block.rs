//! F1 against torch 2.13.0: one pre-norm block, AdamW, clipping and the cosine `LambdaLR`.
//!
//! `tests/fixtures/f1-block` was written by
//! `python -m mailwoman_train.audits.trainer_parity f1 --out <dir> --hidden 32 --heads 4 --ff 64 --seq 12` under torch
//! 2.13.0+cpu with 4 threads. On the lab host every comparison is bit-identical; the tolerances are plan §3.3's.

use std::path::Path;

#[test]
fn block_adamw_and_schedule_match_torch() {
	tch::set_num_threads(4);
	let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/f1-block");
	let results = trainer_loop::parity::f1::run(&dir).expect("the F1 record reads");
	for r in &results {
		println!("{}", r.summary());
	}
	let failing: Vec<String> = results
		.iter()
		.filter(|r| !r.pass() || !r.notes.is_empty())
		.map(|r| r.summary())
		.collect();
	assert!(failing.is_empty(), "F1 stages failed:\n{}", failing.join("\n"));
}
