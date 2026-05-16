/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode } from "@mailwoman/core"
import { Classifier, ClassifierConstructor } from "@mailwoman/core/classification"
import { FilterRelation, SerializedSolution, Solution, Solver, SolverConstructor } from "@mailwoman/core/solver"
import { TokenContext } from "@mailwoman/core/tokenization"
import type { PerformanceMeasure } from "node:perf_hooks"

export interface AddressParserOptions {
	classifiers?: Iterable<Classifier | ClassifierConstructor>
	solvers?: Iterable<Solver | SolverConstructor>
	languages?:
		| Alpha2LanguageCode[]
		| readonly Alpha2LanguageCode[]
		| Set<Alpha2LanguageCode>
		| ReadonlySet<Alpha2LanguageCode>
	solutionLimit?: number
	mustNotFollow?: FilterRelation[]
}

export interface ParseOptions {
	verbose?: boolean
}

export interface VerboseParseResult {
	solutions: Solution[]
	context: TokenContext
	measures: {
		tokenizer: PerformanceMeasure
		classifier: PerformanceMeasure
		solver: PerformanceMeasure
	}
}

/**
 * Parses a tokenized address into a structured address.
 */
export class AddressParser {
	protected classifiers: Classifier[]
	protected solvers: Solver[]

	protected solutionLimit: number

	#initialized = false

	constructor({ languages, classifiers = [], solvers = [], solutionLimit = 10 }: AddressParserOptions = {}) {
		this.classifiers = Array.from(classifiers, (AddressClassifier) => {
			return typeof AddressClassifier === "function" ? new AddressClassifier({ languages }) : AddressClassifier
		})

		this.solvers = Array.from(solvers, (AddressSolver) => {
			return typeof AddressSolver === "function" ? new AddressSolver() : AddressSolver
		})

		this.solutionLimit = solutionLimit
	}

	async ready(): Promise<this> {
		if (this.#initialized) return this

		await Promise.all(this.classifiers.map((classifier) => classifier.ready?.()))

		this.#initialized = true

		return this
	}

	/**
	 * Parse an address. A high-level function that runs all classifiers and solvers.
	 *
	 * @param input - The address to parse.
	 */
	public parse(input: string, options: ParseOptions & { verbose: true }): Promise<VerboseParseResult>
	public parse(input: string, options?: ParseOptions): Promise<SerializedSolution[]>
	public async parse(
		input: string,
		{ verbose }: ParseOptions = {}
	): Promise<SerializedSolution[] | VerboseParseResult> {
		if (typeof input !== "string") {
			throw new TypeError("Failed to parse address: input must be a string.")
		}

		if (input.length === 0) return []

		await this.ready()

		const startTokenizer = performance.now()
		const context = new TokenContext(input)
		const endTokenizer = performance.now()

		const startClassifier = performance.now()

		this.classify(context)

		const endClassifier = performance.now()

		const startSolve = performance.now()
		const solutions = this.findSolutions(context)
		const endSolve = performance.now()

		performance.mark("end-solve")

		if (verbose) {
			return {
				solutions,
				context,
				measures: {
					tokenizer: performance.measure("Tokenizer", { start: startTokenizer, end: endTokenizer }),
					classifier: performance.measure("Classifier", { start: startClassifier, end: endClassifier }),
					solver: performance.measure("Solver", { start: startSolve, end: endSolve }),
				},
			}
		}

		return solutions.map((solution) => solution.toJSON())
	}

	#classifierMeasures = new WeakMap<Classifier, PerformanceMeasure>()

	/**
	 * Run all classifiers.
	 */
	protected classify(context: TokenContext): void {
		for (const [i, classifier] of this.classifiers.entries()) {
			const classifierName = classifier.constructor?.name || `Unknown Classifier ${i + 1}`

			const start = performance.now()

			classifier.classifyTokens(context)

			const classifyMeasure = performance.measure("Classify", {
				start,
				end: performance.now(),
				detail: classifierName,
			})

			this.#classifierMeasures.set(classifier, classifyMeasure)
		}
	}

	/**
	 * Get the performance measure for a classifier in the most recent parse.
	 */
	public sampleClassifierMeasure(classifier: Classifier): PerformanceMeasure | undefined {
		return this.#classifierMeasures.get(classifier)
	}

	/**
	 * Run all solvers.
	 */
	public findSolutions(context: TokenContext): Solution[] {
		for (const solver of this.solvers) {
			context.evaluateAndRank(this.solutionLimit)

			solver.solve(context)
		}

		context.evaluateAndRank(this.solutionLimit)

		return context.solutions
	}
}
