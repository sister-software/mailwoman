// @copyright Sister Software
// @license AGPL-3.0
// @author Teffen Ellis, et al.

//! `PyRandom` reproduces the draws CPython 3.12 recorded in `fixtures/cpython-random.json`.
//!
//! Each case seeds one generator and records consecutive calls of one method, or a mixed sequence of methods drawn
//! from one generator. A population argument is recorded as its size, and its items are `0..n`.

use mtf_sampler::pyrandom::{accumulate, PyRandom, Seed};
use serde_json::Value;

fn fixture() -> Value {
	let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cpython-random.json");
	serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("fixture parses")
}

fn generator(seed: &Value) -> PyRandom {
	match seed {
		Value::String(s) => PyRandom::new(Seed::Str(s)),
		Value::Number(n) => PyRandom::new(Seed::Int(i128::from(n.as_i64().expect("integer seed")))),
		other => panic!("unsupported seed {other}"),
	}
}

fn int(value: &Value) -> i128 {
	match value {
		Value::String(s) => s.parse().expect("decimal integer"),
		Value::Number(n) => i128::from(n.as_i64().expect("integer")),
		other => panic!("not an integer: {other}"),
	}
}

fn floats(value: &Value) -> Vec<f64> {
	value
		.as_array()
		.expect("weights")
		.iter()
		.map(|v| v.as_f64().expect("weight"))
		.collect()
}

/// One call of `method` with `args`, as the fixture's JSON value.
fn call(rng: &mut PyRandom, method: &str, args: &[Value]) -> Value {
	let i = |index: usize| int(&args[index]);
	match method {
		"random" => Value::from(rng.random()),
		"getrandbits" => {
			let bits = rng.getrandbits(i(0) as u32);
			if bits >= 1 << 63 {
				Value::from(bits.to_string())
			} else {
				Value::from(bits as u64)
			}
		}
		"randrange" if args.len() == 1 => Value::from(rng.randrange_below(i(0)).unwrap() as i64),
		"randrange" => Value::from(rng.randrange(i(0), i(1)).unwrap() as i64),
		"randint" => Value::from(rng.randint(i(0), i(1)).unwrap() as i64),
		"choice" => Value::from(rng.choice_index(i(0) as usize).unwrap()),
		"sample" => Value::from(rng.sample_indices(i(0) as usize, i(1) as usize).unwrap()),
		"choices" => {
			let (n, k) = (i(0) as usize, i(3) as usize);
			let picked = match (&args[1], &args[2]) {
				(Value::Null, Value::Null) => rng.choices_uniform(n, k),
				(weights, Value::Null) => rng.choices_cumulative(&accumulate(&floats(weights)), k).unwrap(),
				(Value::Null, cumulative) => rng.choices_cumulative(&floats(cumulative), k).unwrap(),
				_ => panic!("weights and cum_weights together"),
			};
			Value::from(picked)
		}
		"shuffle" => {
			let mut items: Vec<usize> = (0..i(0) as usize).collect();
			rng.shuffle(&mut items);
			Value::from(items)
		}
		other => panic!("unsupported method {other}"),
	}
}

/// A mixed-sequence step's arguments, translated from the recorded call to the size-based form `call` takes.
fn mixed_args(method: &str, args: &[Value]) -> Vec<Value> {
	match method {
		"choices" => {
			let n = args[0].as_array().expect("population").len();
			vec![Value::from(n), args[1].clone(), Value::Null, args[2].clone()]
		}
		_ => args.to_vec(),
	}
}

#[test]
fn every_recorded_case_matches() {
	let doc = fixture();
	assert_eq!(doc["python"].as_str(), Some("3.12.3"));
	let mut checked = 0usize;
	for case in doc["cases"].as_array().expect("cases") {
		let method = case["method"].as_str().expect("method");
		let mut rng = generator(&case["seed"]);
		let label = format!("seed {} {method} {}", case["seed"], case["args"]);
		if method == "mixed" {
			for (step, entry) in case["outputs"].as_array().expect("trace").iter().enumerate() {
				let inner = entry[0].as_str().expect("inner method");
				let args = mixed_args(inner, entry[1].as_array().expect("args"));
				assert_eq!(call(&mut rng, inner, &args), entry[2], "{label} step {step} ({inner})");
				checked += 1;
			}
			continue;
		}
		let args = case["args"].as_array().expect("args").clone();
		for (index, expected) in case["outputs"].as_array().expect("outputs").iter().enumerate() {
			let observed = call(&mut rng, method, &args);
			assert_eq!(&observed, expected, "{label} call {index}");
			checked += 1;
		}
	}
	assert!(checked > 0);
}

#[test]
fn refusals_match_cpython() {
	let mut rng = PyRandom::new(Seed::Int(1));
	assert!(rng.randrange(5, 5).is_err());
	assert!(rng.choice_index(0).is_err());
	assert!(rng.sample_indices(3, 4).is_err());
	assert!(rng.choices_cumulative(&[0.0, 0.0], 1).is_err());
}
