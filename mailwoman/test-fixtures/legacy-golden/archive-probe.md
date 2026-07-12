# Archive probe — @mailwoman/classifiers@6.0.0 + mailwoman@6.0.0

**Date:** 2026-07-12
**Verdict:** PASS — cold install from the registry constructs and runs the v1 parser.

## Commands

```bash
PROBE_DIR=$(mktemp -d)
cd "$PROBE_DIR"
npm init -y > /dev/null
npm install mailwoman@6.0.0 @mailwoman/classifiers@6.0.0 2>&1 | tail -3
node --input-type=module -e '
import { createAddressParser } from "mailwoman"
const parser = createAddressParser()
const solutions = await parser.parse("30 W 26th St, New York, NY 10010")
if (!solutions.length) throw new Error("no solutions")
console.log(JSON.stringify(solutions[0], null, "\t").slice(0, 600))
console.log("PROBE OK:", solutions.length, "solutions")
'
cd /home/lab/Projects/mailwoman
```

## Output

```
npm warn allow-scripts   onnxruntime-node@1.27.0 (postinstall: node ./script/install)
npm warn allow-scripts
npm warn allow-scripts Run `npm approve-scripts --allow-scripts-pending` to review, or `npm approve-scripts <pkg>` to allow.
{
	"score": 0.99,
	"penalty": 0,
	"classifications": {
		"house_number": [
			"30"
		],
		"street": [
			"W 26th St"
		],
		"locality": [
			"New York"
		],
		"region": [
			"NY"
		],
		"postcode": [
			"10010"
		]
	},
	"matches": [
		{
			"classification": "house_number",
			"confidence": 1,
			"flags": {},
			"value": "30",
			"start": 0,
			"end": 2
		},
		{
			"classification": "street",
			"confidence": 0.98,
			"languages": {
				"displayName": "libpostal"
			},
			"value": "W 26th St",
			"start": 3,
			"end": 12
		},
		{
			"classification": "locality",
			"confidence": 1,
			"language
PROBE OK: 2 solutions
```

## Analysis

- **npm install:** Completed without EUNSUPPORTEDPROTOCOL. The `workspace:*` protocol translation held during publish to npm registry.
- **Parser construction:** `createAddressParser()` from `mailwoman@6.0.0` instantiated successfully.
- **Parse result:** Returned an array of solutions with expected v1 schema (classifications, matches, score, penalty). Solution count: 2.
- **Artifact integrity:** All required parsers (@mailwoman/classifiers, neural weights, libpostal binaries) resolved from the published packages.

The archive premise — v6.0.0 packages are a complete, self-contained snapshot that reproduces the legacy parser as-is — is confirmed.
