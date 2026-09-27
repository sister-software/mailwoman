import { dataRootPath } from "@mailwoman/core/data-root"
import { isFile, pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { workspacePath } from "@mailwoman/core/paths"
import { runFileSync } from "@mailwoman/core/process"
import { NeuralAddressClassifier, resolveWeights } from "@mailwoman/neural"
import { $public } from "@mailwoman/neural/env"
import { PairIndexResolver, serializePairIndex, type PairIndexLike } from "@mailwoman/neural/pair"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"
import { afterAll, describe, expect, test, vi } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const TOKENIZER_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

const MODEL_PATH =
	$public.MAILWOMAN_TEST_ONNX_MODEL ?? dataRootPath("models", "quantized", "model-stage1-coarse-step-050000-int8.onnx")

const haveModel = await pathExists(MODEL_PATH)

const linkedLocales = new Set<string>()

function ensureDevWeightsLinked(...locales: readonly string[]): void {
	for (const locale of locales) {
		if (linkedLocales.has(locale)) continue

		runFileSync(process.execPath, [workspacePath(`neural-weights-${locale}`, "scripts", "link-dev-weights.ts")], {
			stdio: "pipe",
		})

		linkedLocales.add(locale)
	}
}

const CLI_PATH = workspacePath("mailwoman", "out", "cli", "index.js")
const haveCLI = await pathExists(CLI_PATH)

const PPD_SOURCE_CSV_PATH = dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")
const havePPDSource = await pathExists(PPD_SOURCE_CSV_PATH)

const NZ_SOURCE_CSV_PATH = dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv")
const haveNZSource = await pathExists(NZ_SOURCE_CSV_PATH)

const LINK_SCRIPT_TIMEOUT_MS = 600_000

const GB_DEPENDENT_LOCALITY_ADDRESS = "Beulah Hill, Fishburn, Stockton-on-Tees, TS21 3AB"

const GB_WIDE_MARGIN_ADDRESS = "Holland Fen Lincoln"

function findChildPieceIndex(pieces: ReadonlyArray<{ piece: string }>, word: string): number {
	const needle = word.slice(0, 4).toLowerCase()

	return pieces.findIndex((p) => p.piece.replace(/^▁/, "").toLowerCase().startsWith(needle))
}

const NO_MATCH_PAIR_INDEX: PairIndexLike = { probe: () => undefined }

describe("resolveWeights — explicit-path mode", () => {
	test.skipIf(!haveModel)("returns the explicit paths verbatim when both are valid", async () => {
		const r = await resolveWeights({ modelPath: MODEL_PATH, tokenizerPath: TOKENIZER_PATH })
		expect(r.modelPath).toBe(MODEL_PATH.toString())
		expect(r.tokenizerPath).toBe(TOKENIZER_PATH)
		expect(r.source).toBe("explicit")
	})

	test("throws actionably when explicit modelPath is missing", async () => {
		await expect(resolveWeights({ modelPath: "/no/such/model.onnx", tokenizerPath: TOKENIZER_PATH })).rejects.toThrow(
			/Explicit modelPath does not exist/
		)
	})
})

describe("NeuralAddressClassifier.loadFromWeights — explicit-path mode", () => {
	test.skipIf(!haveModel)("loads + parses a known address into a non-empty tree", async () => {
		const cls = await NeuralAddressClassifier.loadFromWeights({
			modelPath: MODEL_PATH,
			tokenizerPath: TOKENIZER_PATH,
		})

		const tree = await cls.parse("75004 Paris")
		expect(tree.roots.length).toBeGreaterThan(0)
	})
})

describe("resolveWeights — package auto-resolve", () => {
	test.skipIf(!haveModel)(
		"Surfaces fstPath for a weights package shipping fst-<locale>.bin",
		async () => {
			ensureDevWeightsLinked("en-us")

			const r = await resolveWeights({ locale: "en-us" })
			expect(r.fstPath).toMatch(/\/fst-en-us\.bin$/)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel)(
		"finds model.onnx + tokenizer.model after running link-dev-weights.ts",
		async () => {
			ensureDevWeightsLinked("en-us")

			const r = await resolveWeights({ locale: "en-us" })

			expect(r.source).toMatch(/^(package|overlay|cache):/)
			expect(r.modelPath).toMatch(/\/model\.onnx$/)
			expect(r.tokenizerPath).toMatch(/\/tokenizer\.model$/)

			expect(r.modelCardPath).toMatch(/\/model-card\.json$/)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI)(
		"en-gb resolves model/tokenizer from the en-us base with its own model-card, resolves the RETURNED postcode-gb.bin, and parses",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })

			expect(r.source).toMatch(/^(package|overlay):/)
			expect(r.modelPath).toMatch(/\/model\.onnx$/)
			expect(r.tokenizerPath).toMatch(/\/tokenizer\.model$/)
			expect(r.anchorLookupPath?.binary).toBe(true)
			expect(r.anchorLookupPath?.path).toMatch(/\/postcode-gb\.bin$/)

			expect(r.modelCardPath).toMatch(/\/model-card\.json$/)

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const tree = await cls.parse("10 Downing Street, London SW1A 2AA")
			expect(tree.roots.length).toBeGreaterThan(0)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test("neural-weights-en-gb names a postcode binary in `files` IFF its card declares span_mode shaped", async () => {
		const manifest = await readPackageJSON(workspacePath("neural-weights-en-gb", "package.json"))

		const card = await readLocalJSONFile<{ requires?: { anchor?: { span_mode?: string } } }>(
			workspacePath("neural-weights-en-gb", "model-card.json")
		)

		const shaped = card.requires?.anchor?.span_mode === "shaped"
		const { files } = manifest

		expect(files, "neural-weights-en-gb/package.json declares no files array").toBeDefined()
		expect(files!.filter((entry) => entry.startsWith("postcode-"))).toEqual(shaped ? ["postcode-gb.bin"] : [])

		expect(files).toContain("pair-index-gb.bin")
	})

	test.skipIf(!haveModel || !haveCLI || !haveNZSource)(
		"en-nz resolves model/tokenizer from the en-us base + pair-index-nz.bin locally, with NO anchor lookup (no NZ postcode extract), and parses",
		async () => {
			ensureDevWeightsLinked("en-us", "en-nz")

			const r = await resolveWeights({ locale: "en-nz" })
			expect(r.source).toMatch(/^(package|overlay):/)
			expect(r.modelPath).toMatch(/\/model\.onnx$/)
			expect(r.tokenizerPath).toMatch(/\/tokenizer\.model$/)

			expect(r.anchorLookupPath).toBeUndefined()
			expect(r.modelCardPath).toMatch(/\/model-card\.json$/)
			expect(r.pairIndexPath).toMatch(/\/pair-index-nz\.bin$/)

			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))
			expect(resolver.header.country).toBe("nz")
			expect(resolver.header.delta).toBe(10)
			expect(resolver.probe("plimmerton", "porirua")?.tag).toBe("dependent_locality")
			expect(resolver.probe("mangawhai", "mangawhai")?.tag).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-nz" })
			const tree = await cls.parse("7 Katipo Drive, Mangawhai, Northland")
			expect(tree.roots.length).toBeGreaterThan(0)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)
})

describe("NeuralAddressClassifier.loadFromWeights — placetype-pair prior (check)", () => {
	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: pairIndexPath resolves and the country-restricted default fires (WIRING — margin-independent)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			expect(r.pairIndexPath).toMatch(/\/pair-index-gb\.bin$/)

			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))
			expect(resolver.header.country).toBe("gb")
			expect(resolver.probe("fishburn", "stocktonontees")?.tag).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")

			expect(placetypePairRecord?.applied).toBe(true)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: the placetype-pair bias at the child token equals the artifact's calibrated delta (margin-independent)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })

			const biasedTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)

			const unbiasedTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS, {
				placetypePair: { index: NO_MATCH_PAIR_INDEX },
			})

			expect(unbiasedTrace.priors.find((p) => p.kind === "placetypePair")?.applied).toBe(false)

			const bDepLocCol = biasedTrace.labels.indexOf("B-dependent_locality")
			expect(bDepLocCol).toBeGreaterThanOrEqual(0)

			const pieceIdx = findChildPieceIndex(biasedTrace.pieces, "Fish")
			expect(pieceIdx).toBeGreaterThanOrEqual(0)

			const delta = biasedTrace.emissions[pieceIdx]![bDepLocCol]! - unbiasedTrace.emissions[pieceIdx]![bDepLocCol]!
			expect(delta).toBeCloseTo(resolver.header.delta, 5)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: explicit `placetypePair: false` disables the auto-wired config default for one call (trace applied:false)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })

			const wiredTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			expect(wiredTrace.priors.find((p) => p.kind === "placetypePair")?.applied).toBe(true)

			const disabledTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS, { placetypePair: false })

			expect(disabledTrace.priors.find((p) => p.kind === "placetypePair")).toEqual({
				kind: "placetypePair",
				applied: false,
			})

			const bDepLocCol = disabledTrace.labels.indexOf("B-dependent_locality")
			const pieceIdx = findChildPieceIndex(disabledTrace.pieces, "Fish")
			expect(disabledTrace.emissions[pieceIdx]![bDepLocCol]).toBe(disabledTrace.logits[pieceIdx]![bDepLocCol])
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: a wide-margin real pair flips the decode — Holland Fen decodes as dependent_locality (the arc's ONE flip assertion)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))

			expect(resolver.probe("holland fen", "lincoln")?.tag).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })

			const json = await cls.parseJSON(GB_WIDE_MARGIN_ADDRESS, {
				placetypePair: { index: resolver, probeMode: "window" },
			})

			expect(json.dependent_locality).toBe("Holland Fen")
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: the transitionBeta=5 artifact carries its header interface; the comma-free fused-path row recovers in both legs (TRANSITION-BETA)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))

			expect(resolver.header.delta).toBe(10)
			expect(resolver.header.transitionBeta).toBe(5)
			expect(resolver.probe("upton", "bude")?.tag).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const row = "12 Church Road Glenfield Leicester LE3 8DP"

			const betaLessView: PairIndexLike = { probe: (c, p) => resolver.probe(c, p), delta: resolver.delta }

			const betaLessTrace = await cls.traceParse(row, { placetypePair: { index: betaLessView } })
			expect(betaLessTrace.priors.find((p) => p.kind === "placetypePair")?.applied).toBe(true)
			const betaLessJSON = await cls.parseJSON(row, { placetypePair: { index: betaLessView } })
			expect(betaLessJSON.dependent_locality).toBe("Glenfield")

			const json = await cls.parseJSON(row)
			expect(json.dependent_locality).toBe("Glenfield")
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI)(
		"en-us: ships its OWN us-conditional pair index — a GB-shaped input still applies NO placetype-pair bias",
		async () => {
			ensureDevWeightsLinked("en-us")

			const r = await resolveWeights({ locale: "en-us" })
			expect(r.pairIndexPath).toMatch(/pair-index-us\.bin$/)

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
			const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")
			expect(placetypePairRecord?.applied).toBe(false)
		}
	)
})

describe("loadFromWeights — pair-index country check (warn branch)", () => {
	test.skipIf(!haveModel)(
		"mispackaged sibling (header country ≠ locale country) warns and skips the prior",
		async () => {
			ensureDevWeightsLinked("en-us")

			const packageDir = PathBuilder.from((await resolveWeights({ locale: "en-us" })).modelPath).dirname()
			const cacheRoot = fixtures.use(await temporaryDirectory("mailwoman-pair-check-")).path
			const fakePackageDir = weightsCachePackageDir(cacheRoot, "en-us")
			await makeDirectories(fakePackageDir)

			for await (const entry of Globerator.from("*", { cwd: packageDir, absolute: false })) {
				const source = packageDir(entry)

				if ((await isFile(source)) && entry !== "pair-index-us.bin") {
					await createSymbolicLink(source, fakePackageDir(entry))
				}
			}

			await writeLocalFile(
				serializePairIndex(
					{
						country: "gb",
						delta: 5,
						foldVersion: 1,
						sourceMD5s: [],
						buildDate: "2026-07-23",
					},
					[{ child: "holland fen", parent: "boston", tag: "dependent_locality", parentTag: "locality" }]
				),
				fakePackageDir("pair-index-us.bin")
			)

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			try {
				const r = await resolveWeights({ locale: "en-us", cacheRoot })
				expect(r.pairIndexPath).toMatch(/pair-index-us\.bin$/)

				const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot })

				expect(
					warnSpy.mock.calls.some(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes('pair-index country "gb"') &&
							call[0].includes(`does not match the resolved locale's country "us"`)
					)
				).toBe(true)

				const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
				const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")
				expect(placetypePairRecord?.applied).toBe(false)

				const tree = await cls.parse("75004 Paris")
				expect(tree.roots.length).toBeGreaterThan(0)
			} finally {
				warnSpy.mockRestore()
			}
		},
		LINK_SCRIPT_TIMEOUT_MS
	)
})
