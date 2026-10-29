/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `PyRandom` reproduces every draw CPython 3.12.3 recorded in the `mtf-sampler` fixture `cpython-random.json`,
 *   the same file `pyrandom_cpython.rs` replays against the Rust module.
 *
 *   Each case seeds one generator and records consecutive calls of one method, or a 140-step sequence that
 *   interleaves seven methods on one generator. A population argument is recorded as its size `n`, and its items are
 *   `0..n`. An integer of 2**63 or more is recorded as a decimal string.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { PyRandom, PyRandomDrawError, type PyRandomSeed } from "#training/pyrandom"

const FIXTURE = repoRootPath("packages", "mtf", "crates", "mtf-sampler", "tests", "fixtures", "cpython-random.json")

/**
 * The committed bytes.
 *
 * The generator writes compact JSON with SHA-256 `7ef6ab05…`.
 * The committed file is that document reformatted by the repository formatter.
 *
 * Re-serializing it compactly in CPython gives `7ef6ab05…` again.
 */
const FIXTURE_SHA256 = "0221e356995e16161ef20af491f20a23373d58d702cf6bfd103a95442f37745f"

type Recorded = number | string | Recorded[] | null

interface FixtureCase {
	seed: PyRandomSeed
	method: string
	args: Recorded[]
	outputs: Recorded[]
}

interface Fixture {
	python: string
	implementation: string
	cases: FixtureCase[]
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

/**
 * One call of `method` with the recorded `args`, as the value the fixture records.
 */
function call(rng: PyRandom, method: string, args: Recorded[]): Recorded {
	const int = (index: number) => args[index] as number

	switch (method) {
		case "random":
			return rng.random()
		case "getrandbits": {
			const bits = rng.getrandbits(int(0))

			return bits >= 2n ** 63n ? bits.toString() : Number(bits)
		}
		case "randrange":
			return args.length === 1 ? rng.randrange(int(0)) : rng.randrange(int(0), int(1))
		case "randint":
			return rng.randint(int(0), int(1))
		case "choice":
			return rng.choice(range(int(0)))
		case "sample":
			return rng.sample(range(int(0)), int(1))
		case "choices": {
			const [n, weights, cumWeights, k] = args as [number, number[] | null, number[] | null, number]

			return rng.choices(range(n), { weights: weights ?? undefined, cumWeights: cumWeights ?? undefined, k })
		}
		case "shuffle": {
			const items = range(int(0))

			rng.shuffle(items)

			return items
		}
		default:
			throw new Error(`the fixture records an unsupported method ${method}`)
	}
}

/**
 * A mixed-sequence step's arguments, translated to the size-based form `call` takes.
 */
function mixedArgs(method: string, args: Recorded[]): Recorded[] {
	if (method !== "choices") return args

	const [population, weights, k] = args as [number[], number[], number]

	return [population.length, weights, null, k]
}

describe("PyRandom against CPython 3.12.3", async () => {
	const fixture = await readLocalJSONFile<Fixture>(FIXTURE)

	it("reads the committed fixture", async () => {
		expect(await sha256File(FIXTURE)).toBe(FIXTURE_SHA256)
		expect(fixture.python).toBe("3.12.3")
		expect(fixture.implementation).toBe("CPython")
	})

	it("covers integer and string seeds", () => {
		const seeds = new Set(fixture.cases.map((entry) => entry.seed))

		expect([...seeds].filter((seed) => typeof seed === "string")).toEqual(["20260601:corpus", "42-postcode", ""])
		expect([...seeds].filter((seed) => typeof seed === "number")).toHaveLength(5)
	})

	for (const entry of fixture.cases) {
		it(`seed ${stringifyJSON(entry.seed)} ${entry.method} ${stringifyJSON(entry.args)}`, () => {
			const rng = new PyRandom(entry.seed)

			if (entry.method === "mixed") {
				for (const [step, recorded] of entry.outputs.entries()) {
					const [inner, args, expected] = recorded as [string, Recorded[], Recorded]

					expect(call(rng, inner, mixedArgs(inner, args)), `step ${step} (${inner})`).toEqual(expected)
				}

				return
			}

			for (const [index, expected] of entry.outputs.entries()) {
				expect(call(rng, entry.method, entry.args), `call ${index}`).toEqual(expected)
			}
		})
	}

	it("refuses what CPython refuses", () => {
		const rng = new PyRandom(1)

		expect(() => rng.randrange(5, 5)).toThrow(PyRandomDrawError)
		expect(() => rng.randrange(0)).toThrow(PyRandomDrawError)
		expect(() => rng.choice([])).toThrow(PyRandomDrawError)
		expect(() => rng.sample(range(3), 4)).toThrow(PyRandomDrawError)
		expect(() => rng.choices(range(2), { cumWeights: [0, 0] })).toThrow(PyRandomDrawError)
	})
})
