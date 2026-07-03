/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerate the ModelVisualizer story/test fixture: one real `NeuralParseTrace` from the
 *   locally-resolved en-us weights (`@mailwoman/neural-weights-en-us`). Committed so docs CI
 *   never needs a model download. Re-run after any trace-schema change or weights bump:
 *
 *       node --experimental-strip-types scripts/generate-trace-fixture.ts ["custom address"]
 *
 *   NOTE: on machines without the anchor lookup ($MAILWOMAN_DATA_ROOT), loadFromWeights warns
 *   and the trace's `anchor` channel is absent — the component's "channel not fed" state. The
 *   deployed demo feeds anchor from postcode-<cc>.bin, so regenerate on a lab box for a
 *   fully-fed fixture when that state matters.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"

const here = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(here, "../docs/src/components/ModelVisualizer/fixtures/white-house.trace.json")

// parseArgs with strict positionals: a flag-looking arg errors loudly instead of being traced as
// the literal address text and silently overwriting the committed fixture with garbage.
const { positionals } = parseArgs({ allowPositionals: true, options: {} })
const text = positionals[0] ?? "1600 Pennsylvania Ave NW, Washington, DC 20500"
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
const trace = await classifier.traceParse(text, { addressSystemConventions: "auto" })

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, `${JSON.stringify(trace, null, "\t")}\n`)
console.log(`wrote ${OUT_PATH} (${trace.pieces.length} pieces, ${trace.labels.length} labels)`)
