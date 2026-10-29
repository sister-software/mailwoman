# mtf-sampler fixtures

`cpython-random.json` records CPython 3.12.3's `random.Random` outputs for the methods the training sampler and the
corpus builders call. `tests/pyrandom_cpython.rs` replays every case through `PyRandom` and requires equal values.

The file covers eight seeds: the integers `0`, `42`, `2**31 - 1`, `2**40 + 7` and `-5`, and the strings
`"20260601:corpus"`, `"42-postcode"` and `""`. For each seed, it records 50 consecutive calls of `random`,
`getrandbits` at 1, 32 and 33 bits, `randrange(7)`, `randrange(10, 2**33)`, `randint(1, 6)` and `choice` over 1,000
items, and 40 calls of `getrandbits(100)`. It also records `choices` uniform, with `weights` and with `cum_weights`,
`sample` on both of CPython's paths (a pool for a small population, a selected set for a large one), ten shuffles of
50 items, and a 140-step sequence that interleaves seven methods on one generator.

A population argument is stored as its size `n`, and its items are `list(range(n))`. An integer of 2**63 or more is
stored as a decimal string.

## Regeneration

The file was written on 2026-10-29 by a generator run under CPython 3.12.3. The generator is archived in this README
as text, so the repository tracks no Python file for it. To regenerate, save the block below as `cpython_random_fixture.py` outside the
repository and run `python3.12 -I cpython_random_fixture.py packages/mtf/crates/mtf-sampler/tests/fixtures/cpython-random.json`.

```python
import json, platform, random, sys

SEEDS = [0, 42, 2**31 - 1, 2**40 + 7, -5, "20260601:corpus", "42-postcode", ""]
N = 50

def case(seed, method, args, calls):
    rng = random.Random(seed)
    out = []
    for _ in range(calls):
        if method == "choices":
            n, weights, cum_weights, k = args
            out.append(rng.choices(list(range(n)), weights=weights, cum_weights=cum_weights, k=k))
        elif method in ("choice", "sample"):
            out.append(getattr(rng, method)(list(range(args[0])), *args[1:]))
        else:
            value = getattr(rng, method)(*args)
            out.append(str(value) if isinstance(value, int) and value >= 2**63 else value)
    return {"seed": seed, "method": method, "args": args, "outputs": out}

def shuffled(seed, n, rounds):
    rng = random.Random(seed)
    out = []
    for _ in range(rounds):
        items = list(range(n))
        rng.shuffle(items)
        out.append(items)
    return {"seed": seed, "method": "shuffle", "args": [n], "outputs": out}

def mixed(seed):
    rng = random.Random(seed)
    weights = [0.5, 1, 2, 0, 3.25, 1, 1, 0.1, 7]
    trace = []
    for i in range(140):
        kind = i % 7
        if kind == 0:
            trace.append(["random", [], rng.random()])
        elif kind == 1:
            trace.append(["randrange", [3, 1000], rng.randrange(3, 1000)])
        elif kind == 2:
            trace.append(["choices", [list(range(9)), weights, 4], rng.choices(list(range(9)), weights=weights, k=4)])
        elif kind == 3:
            items = list(range(17))
            rng.shuffle(items)
            trace.append(["shuffle", [17], items])
        elif kind == 4:
            trace.append(["sample", [40, 6], rng.sample(range(40), 6)])
        elif kind == 5:
            trace.append(["randint", [-3, 3], rng.randint(-3, 3)])
        else:
            trace.append(["choice", [11], rng.choice(range(11))])
    return {"seed": seed, "method": "mixed", "args": [], "outputs": trace}

cases = []
for seed in SEEDS:
    cases.append(case(seed, "random", [], N))
    cases.append(case(seed, "getrandbits", [1], N))
    cases.append(case(seed, "getrandbits", [32], N))
    cases.append(case(seed, "getrandbits", [33], N))
    cases.append(case(seed, "getrandbits", [100], 40))
    cases.append(case(seed, "randrange", [7], N))
    cases.append(case(seed, "randrange", [10, 2**33], N))
    cases.append(case(seed, "randint", [1, 6], N))
    cases.append(case(seed, "choice", [1000], N))
    cases.append(case(seed, "choices", [50, None, None, 25], 8))
    cases.append(case(seed, "choices", [5, [1, 0, 2.5, 0.001, 9], None, 25], 8))
    cases.append(case(seed, "choices", [4, None, [1, 3, 3, 10], 25], 8))
    cases.append(case(seed, "sample", [30, 10], 20))
    cases.append(case(seed, "sample", [10000, 50], 10))
    cases.append(case(seed, "sample", [500, 5], 20))
    cases.append(shuffled(seed, 50, 10))
    cases.append(mixed(seed))

doc = {
    "generator": "cpython_random_fixture.py (archived in the fixture README)",
    "python": sys.version.split()[0],
    "implementation": platform.python_implementation(),
    "cases": cases,
}
with open(sys.argv[1], "w", encoding="utf-8") as out:
    json.dump(doc, out, separators=(",", ":"))
    out.write("\n")
```
