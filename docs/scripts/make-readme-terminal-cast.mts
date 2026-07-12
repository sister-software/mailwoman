#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Synthesize a deterministic asciinema v2 cast of `npx mailwoman parse`.
 *
 *   Content is the real CLI output (verified against mailwoman/out/cli.js); ANSI colors are
 *   presentation only. Typing jitter comes from a seeded PRNG so reruns are byte-identical.
 *
 *   Regenerate the README asset (from the repo root):
 *
 *       node docs/scripts/make-readme-terminal-cast.mts
 *       npx svg-term-cli --in cast.json --out docs/static/img/readme-terminal.svg \
 *         --window --width 80 --height 12 --padding-x 12 --padding-y 8
 *
 *   Then re-add the leading XML provenance comment (single hyphens only: a double hyphen is
 *   illegal inside an XML comment and breaks the image).
 */

import { writeFileSync } from "node:fs"

/** Deterministic stand-in for Math.random (mulberry32) — reruns must be byte-identical. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const random = mulberry32(20260712)
const uniform = (low: number, high: number) => low + (high - low) * random()

const WIDTH = 80
const HEIGHT = 12

const MAGENTA = "\x1b[38;5;199m" // brand #ff00b0
const DIM = "\x1b[38;5;245m"
const GREEN = "\x1b[38;5;114m"
const RESET = "\x1b[0m"

type CastEvent = [timestamp: number, kind: "o", data: string]

const events: CastEvent[] = []
let clock = 0.6

function emit(delay: number, data: string): void {
	clock += delay
	events.push([Number(clock.toFixed(3)), "o", data])
}

// Type the command
const command = 'npx mailwoman parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"'
emit(0, `${DIM}$${RESET} `)

for (const character of command) {
	emit(uniform(0.018, 0.045), character)
}

emit(0.35, "\r\n")

// Real output from the CLI, colorized: keys brand-magenta, strings green
const parsed = {
	region: "CA",
	locality: "Mountain View",
	street: "Amphitheatre",
	house_number: "1600",
	street_suffix: "Parkway",
	postcode: "94043",
}

emit(0.25, `${DIM}{${RESET}\r\n`)

const entries = Object.entries(parsed)

for (const [index, [key, value]] of entries.entries()) {
	const comma = index < entries.length - 1 ? "," : ""
	const line = `  ${MAGENTA}"${key}"${RESET}${DIM}:${RESET} ${GREEN}"${value}"${RESET}${DIM}${comma}${RESET}`

	emit(0.045, `${line}\r\n`)
}

emit(0.045, `${DIM}}${RESET}\r\n`)

// Trailing prompt, then hold the final frame
emit(0.3, `${DIM}$${RESET} `)
emit(3.0, "")

const header = { version: 2, width: WIDTH, height: HEIGHT, title: "mailwoman parse" }
const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))]

writeFileSync("cast.json", `${lines.join("\n")}\n`)
console.log(`wrote cast.json: ${events.length} events, ${events.at(-1)?.[0]}s`)
