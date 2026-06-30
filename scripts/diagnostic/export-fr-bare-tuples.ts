/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Export distinct real French (street, number, city) tuples from **BAN** (Base Adresse Nationale —
 *   France's official address DB, Licence Ouverte / permissive) for the #251 `fr-bare-street`
 *   augmentation. BAN, NOT OpenStreetMap, on purpose: the augmentation trains the SHIPPED model, which
 *   must stay permissive — the ODbL OSM data is quarantined to the opt-in rooftop shards and must not
 *   contaminate the core model. BAN is also the source DeepSeek identified as postcode-COMPLETE, so the
 *   bare (postcode-dropped) forms minted here are exactly the distribution the model never saw.
 *
 *   Strided sampling spreads the draw across all départements (BAN is sorted by code_insee), one tuple
 *   per distinct street to keep the set diverse rather than re-teaching the same name.
 *
 *   Run: node scripts/diagnostic/export-fr-bare-tuples.ts [--n 12000] [--stride 1200] [--out <jsonl>]
 */

import { createReadStream, createWriteStream } from "node:fs"
import { createInterface } from "node:readline"

import { mailwomanDataRoot } from "mailwoman/resolver-backend"

import { arg } from "../lib/cli-args.ts"

const N = Number(arg("n", "12000"))
const STRIDE = Number(arg("stride", "1200"))
const BAN = `${mailwomanDataRoot()}/corpus/staging/ban-france.csv`
const OUT = arg("out", `${mailwomanDataRoot()}/osm/fr-bare-tuples.jsonl`)

// BAN header: id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;…
const NUMERO = 2
const REP = 3
const NOM_VOIE = 4
const NOM_COMMUNE = 7

const seen = new Set<string>()
const ws = createWriteStream(OUT)
const rl = createInterface({ input: createReadStream(BAN, { encoding: "utf8" }), crlfDelay: Infinity })

let lineNo = 0
let written = 0

for await (const line of rl) {
	lineNo++

	if (lineNo === 1) continue
	// header

	if (lineNo % STRIDE !== 0) continue // strided sample
	const c = line.split(";")
	const street = (c[NOM_VOIE] ?? "").trim()
	const numero = (c[NUMERO] ?? "").trim()
	const rep = (c[REP] ?? "").trim()
	const locality = (c[NOM_COMMUNE] ?? "").trim()

	if (!street || !numero || !locality || !street.includes(" ")) continue
	const key = street.toLowerCase()

	if (seen.has(key)) continue
	seen.add(key)
	const number = rep ? `${numero} ${rep}` : numero
	ws.write(JSON.stringify({ street, number, locality }) + "\n")
	written++

	if (written >= N) break
}
ws.end()
console.log(`wrote ${written} distinct FR (street, number, city) tuples from BAN → ${OUT}`)
