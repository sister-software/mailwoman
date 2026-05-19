/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type ClassificationMatch,
	pluckLanguageLabel,
	Solution,
	Span,
	TokenContext,
	type VerboseParseResult,
} from "@mailwoman/core"
import chalk from "chalk"
import { inspect } from "node:util"

function formatClassificationLanguages(classification: ClassificationMatch): string {
	const { languages } = classification
	if (!languages) return ""

	let block = ""

	if (languages) {
		block += Array.from(languages, (language) => {
			const label = pluckLanguageLabel(language)

			return label
		}).join(", ")
	}

	return ` ${chalk.bgGray.bold.underline(languages.displayName || "unknown")}{${chalk.bgGray.bold(block)}}`
}

/**
 * Generates ANSI color-coded debugging output from a postal address.
 */
class DebugOutputBuilder {
	#lines: string[] = []

	public write = (data: string | object) => {
		if (typeof data === "object") {
			this.#lines.push(inspect(data, { colors: true }))
		} else {
			this.#lines.push(data)
		}
	}

	public toString() {
		return this.#lines.join("")
	}

	public writeLine(...lines: (string | object)[]) {
		if (lines) {
			lines.forEach(this.write)
		}

		this.write("\n")
	}

	public tokenizer(context: TokenContext, label: string) {
		const spans = (title: string, children: Iterable<Span>) => {
			this.write(title.padEnd(32) + "➜  ")

			let i = 0

			for (const span of children) {
				this.write(chalk.bgBlue.bold(` ${span.body} `) + chalk.bgWhite.bold.gray(`${span.start}:${span.end}`))

				this.write(" ")

				i++
			}

			this.writeLine()
		}

		this.writeLine()
		this.writeLine("=".repeat(64))
		this.writeLine(`TOKENIZATION ${label}`)
		this.writeLine("-".repeat(64))

		this.write("INPUT".padEnd(32) + "➜  ")
		this.writeLine(context.span.body)

		spans("SECTIONS", context.sections)

		for (const [i, section] of context.sections.entries()) {
			spans(`S${i} TOKENS`, section.children)
		}

		for (const [i, section] of context.sections.entries()) {
			spans(`S${i} PHRASES`, section.phrases)
		}

		this.writeLine()
	}

	/**
	 * Print word classifications
	 */
	public wordClassifications({ sections }: TokenContext, _label: string) {
		this.writeLine("-".repeat(64))
		this.writeLine("WORDS")
		this.writeLine("-".repeat(64))

		for (const section of sections) {
			const { children } = section

			for (const word of children) {
				if (!word.classifications.size) continue

				this.write(word.body.padEnd(32) + "➜  ")

				for (const classification of word.classifications.values()) {
					let block = chalk.bgGreen.bold(` ${classification.classification} `)

					block += chalk.bgWhite.bold.gray(` ${classification.confidence.toFixed(2)} `)

					block += Array.from(classification.flags || [], (flag) => {
						return chalk.bgGray.bold(flag)
					}).join(" ")

					block += formatClassificationLanguages(classification)

					this.write(block)

					this.write(" ")
				}

				this.writeLine()
			}
		}

		this.writeLine()
	}

	/**
	 * Print phrase classifications
	 */
	public phraseClassifications({ sections }: TokenContext, _label?: string) {
		this.writeLine("-".repeat(64))
		this.writeLine("PHRASES")
		this.writeLine("-".repeat(64))

		for (const section of sections) {
			const { phrases } = section

			for (const phrase of phrases) {
				if (!phrase.classifications.size) continue

				this.write(phrase.body.padEnd(32) + "➜  ")

				for (const classification of phrase.classifications.values()) {
					let block = chalk.bgRed.bold(` ${classification.classification} `)

					block += chalk.bgWhite.bold.gray(` ${classification.confidence.toFixed(2)} `)

					block += Array.from(classification.flags || [], (flag) => {
						return chalk.bgGray.bold(flag)
					}).join(" ")

					block += formatClassificationLanguages(classification)

					this.write(block)

					this.write(" ")
				}
				this.writeLine()
			}
		}

		this.writeLine()
	}

	public printClassifications(context: TokenContext, label: string) {
		this.writeLine("=".repeat(64))
		this.writeLine(`CLASSIFICATIONS ${label}`)

		this.wordClassifications(context, label)
		this.phraseClassifications(context, label)
	}

	public printSolutions(solutions: Iterable<Solution>, label: string) {
		this.writeLine("=".repeat(64))
		this.writeLine(`SOLUTIONS ${label}`)
		this.writeLine("-".repeat(64))

		for (const solution of solutions) {
			const score = chalk.yellow.bold("(" + solution.score.toFixed(2) + ")")
			this.writeLine(
				score,
				" ➜ ",
				solution.matches.map(({ value, start, classification, confidence }) => {
					return {
						[classification]: value,
						confidence: parseFloat(confidence.toFixed(2)),
						offset: start,
						penalty: parseFloat(solution.penalty.toFixed(2)),
					}
				})
			)
			this.writeLine()
		}
	}
}

/**
 * Create a diagnostic report for a parser result.
 */
export function createDiagnosticReport({ solutions, context, measures }: VerboseParseResult): string {
	const builder = new DebugOutputBuilder()

	const { tokenizer, classifier, solver } = measures

	builder.tokenizer(context, `(${tokenizer.duration.toFixed(2)}ms)`)

	builder.printClassifications(context, `(${classifier.duration.toFixed(2)}ms)`)

	builder.printSolutions(solutions, `(${solver.duration.toFixed(2)}ms)`)

	return builder.toString()
}
