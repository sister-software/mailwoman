//! F1 against torch 2.13.0: one pre-norm block, AdamW, clipping and the cosine `LambdaLR`.
//!
//! `tests/fixtures/f1-block` was written by
//! `python -m mailwoman_train.audits.trainer_parity f1 --out <dir> --hidden 32 --heads 4 --ff 64 --seq 12` under torch
//! 2.13.0+cpu with 4 threads and `ATEN_CPU_CAPABILITY=default`. The tolerances are plan §3.3's.
//!
//! ATen picks its vectorized kernels from the host CPU, and the AVX2 and AVX-512 kernels round differently: under
//! AVX2 the AdamW update of a parameter whose second moment is near zero moves by 5e-5 against the 1e-6 bound. The
//! record and this test both run the scalar `default` kernels, so the comparison holds on any x86-64 host.

use std::path::Path;

#[test]
fn block_adamw_and_schedule_match_torch() {
	// ATen reads the variable at its first kernel dispatch, which no earlier call in this process makes.
	std::env::set_var("ATEN_CPU_CAPABILITY", "default");
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
