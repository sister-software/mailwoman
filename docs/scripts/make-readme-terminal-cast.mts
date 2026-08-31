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

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { mulberry32 } from "@mailwoman/core/utils"

// Deterministic stand-in for Math.random — reruns must be byte-identical.
const random = mulberry32(20_260_712)
const uniform = (low: number, high: number) => low + (high - low) * random()

const WIDTH = 80
const HEIGHT = 12

/**
 * Brand #ff00b0.
 */
const MAGENTA = "\u001B[38;5;199m"
const DIM = "\u001B[38;5;245m"
const GREEN = "\u001B[38;5;114m"
const RESET = "\u001B[0m"

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
emit(3, "")

const header = { version: 2, width: WIDTH, height: HEIGHT, title: "mailwoman parse" }
const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))]

await writeLocalTextFile(`${lines.join("\n")}\n`, "cast.json")

console.log(`wrote cast.json: ${events.length} events, ${events.at(-1)?.[0]}s`)
