/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode } from "@mailwoman/core"
import type { Classifier, ClassifierConstructor } from "@mailwoman/core/classification"
import type { PolicyRegistry } from "@mailwoman/core/policy"
import {
	type FilterRelation,
	type SerializedSolution,
	Solution,
	type Solver,
	type SolverConstructor,
} from "@mailwoman/core/solver"
import { TokenContext } from "@mailwoman/core/tokenization"
import type { ClassificationProposal, ProposalClassifier } from "@mailwoman/core/types"
import type { PerformanceMeasure } from "node:perf_hooks"
import { runProposalPipeline, type WritebackResult } from "./proposal-pipeline.js"

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
	/**
	 * Proposal-based classifiers (rule classifiers via `wrapLegacyClassifier`, the neural classifier
	 * via `createNeuralProposalClassifier`, or any custom impl). When provided, they run AFTER the
	 * legacy `classifiers` mutation pass; surviving proposals are written back to the same
	 * `TokenContext` for the solver. The legacy `classifiers` array still runs unchanged so existing
	 * setups stay byte-compatible.
	 */
	proposalClassifiers?: Iterable<ProposalClassifier>
	/**
	 * Policy registry consulted to filter the merged proposal stream before writeback. When absent,
	 * every proposal survives. Typically `InMemoryPolicyRegistry.withDefaults()` plus per-component
	 * overrides set at startup.
	 */
	policy?: PolicyRegistry
}

export interface ParseOptions {
	verbose?: boolean

	/**
	 * BCP-47 locale tag (e.g. `"en-US"`, `"fr-FR"`). When provided, downstream locale-aware pipelines
	 * (Phase 1+) narrow classification to the registered `LocaleProfile`. Accepted but ignored by the
	 * legacy rule-only pipeline in Phase 0; the field exists so the CLI and library callers can begin
	 * tagging their requests now.
	 */
	locale?: string
}

export interface VerboseParseResult {
	solutions: Solution[]
	context: TokenContext
	measures: {
		tokenizer: PerformanceMeasure
		classifier: PerformanceMeasure
		solver: PerformanceMeasure
	}
	/**
	 * Present when proposal classifiers ran. `proposals` is the policy-filtered list; `writeback` is
	 * a small summary of how many proposals reached the context's span graph. Omitted when no
	 * `proposalClassifiers` were configured.
	 */
	proposals?: {
		filtered: ClassificationProposal[]
		writeback: WritebackResult
	}
}

/**
 * Parses a tokenized address into a structured address.
 */
export class AddressParser {
	protected classifiers: Classifier[]
	protected solvers: Solver[]
	protected proposalClassifiers: ProposalClassifier[]
	protected policy?: PolicyRegistry

	protected solutionLimit: number

	#initialized = false

	constructor({
		languages,
		classifiers = [],
		solvers = [],
		proposalClassifiers = [],
		policy,
		solutionLimit = 10,
	}: AddressParserOptions = {}) {
		this.classifiers = Array.from(classifiers, (AddressClassifier) => {
			return typeof AddressClassifier === "function" ? new AddressClassifier({ languages }) : AddressClassifier
		})

		this.solvers = Array.from(solvers, (AddressSolver) => {
			return typeof AddressSolver === "function" ? new AddressSolver() : AddressSolver
		})

		this.proposalClassifiers = Array.from(proposalClassifiers)
		this.policy = policy

		this.solutionLimit = solutionLimit
	}

	async ready(): Promise<this> {
		if (this.#initialized) return this

		await Promise.all([
			...this.classifiers.map((classifier) => classifier.ready?.()),
			...this.proposalClassifiers.map((classifier) => classifier.ready?.()),
		])

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
		{ verbose, locale }: ParseOptions = {}
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

		let proposalsSummary: VerboseParseResult["proposals"] | undefined
		if (this.proposalClassifiers.length > 0) {
			const { proposals, writeback } = await runProposalPipeline(context, this.proposalClassifiers, {
				policy: this.policy,
				locale,
				classifierContext: { locale },
			})
			proposalsSummary = { filtered: proposals, writeback }
		}

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
				...(proposalsSummary ? { proposals: proposalsSummary } : {}),
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
