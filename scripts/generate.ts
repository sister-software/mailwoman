/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Usage: node resources/whosonfirst/generate.js /data/wof/sqlite/whosonfirst-data-admin-latest.db
 *
 *   Note: after running this command there may be many dictionaries generated which are ignored by
 *   the .gitignore but still loaded when the parser starts up.
 *
 *   This is usually noticable as the start time is slow and the tests are failing. It will only
 *   affect your local installation but can be difficult to debug.
 *
 *   To remove generated files from your local tree which aren't included by the .gitignore: git clean
 *   -fx resources/whosonfirst
 */

import sqlite from "better-sqlite3"
// import { Presets, SingleBar } from "cli-progress"
import { resourceDictionaryPathBuilder } from "@mailwoman/core/utils"
import { WhosOnFirstPlacetype } from "mailwoman/core/resources/whosonfirst"
import { mkdir, writeFile } from "node:fs/promises"

const resourceDictionaryDirectory = resourceDictionaryPathBuilder("whosonfirst")

interface WOFRow {
	id: number
	placetype: WhosOnFirstPlacetype
	path:
		| `$.name:${string}`
		| `$.abrv:${string}`
		| "$.wof:country"
		| "$.wof:country_alpha3"
		| "$.wof:shortcode"
		| "$.wof:abbreviation"
	fullkey: "$.wof:country" | "$.wof:country_alpha3" | "$.wof:shortcode" | "$.wof:abbreviation" | string
	value: string
}

// language blacklist
const blacklist = new Set<string>(["unk", "vol"])

await mkdir(resourceDictionaryDirectory, {
	recursive: true,
})

if (process.argv.length !== 3) {
	console.error("usage: node %s {dbpath.sqlite}", resourceDictionaryPathBuilder("whosonfirst").toString())
	process.exit(1)
}

const databasePath = process.argv[2]

console.log(`Opening database... ${databasePath}`)
const db = sqlite(databasePath, {
	fileMustExist: true,
	readonly: true,
})

console.log("Preparing statement...")

console.log("Preparing temporary view...")

db.exec(/* sql */ `
	CREATE TEMP VIEW introspection AS
	WITH properties AS (
		SELECT id, body ->> 'properties' AS body
		FROM geojson
	)
	SELECT
		properties.id AS id,
		prop.path as path,
		properties.body ->> '$.wof:placetype' AS placetype,
		fullkey,
		LOWER(TRIM(prop.value)) AS value

	FROM properties, json_tree(body) AS prop
	WHERE prop.type = 'text';
`)

console.log("Preparing statement...")

const stmt = db.prepare<[], WOFRow>(/* sql */ `
	SELECT * FROM temp.introspection
	WHERE (
		fullkey IN (
			'$."wof:abbreviation"',
			'$."wof:country"',
			'$."wof:country_alpha3"',
			'$."wof:shortcode"'
		)
		OR path LIKE '$."name:%_x_preferred"'
		OR path LIKE '$."abrv:%_x_preferred"'
	);
`)

/**
 * { id: 85633337, placetype: 'country', path: '$.name:zho_x_preferred', value: '荷兰' }
 */

console.log("Reading data...")

type PlacetypeData = Map<string, Set<string>>

const placetypeMap = new Map<string, PlacetypeData>()

// const rowProgress = new SingleBar({}, Presets.shades_classic)

for (const row of stmt.iterate()) {
	// rowProgress.increment()
	// rowProgress.render()

	await Promise.resolve()
	if (!row.placetype.length) {
		console.error("invalid placetype: %d '%s' '%s'", row.id, row.path, row.placetype)
		continue
	}

	if (!row.value.length) {
		// console.error('invalid value: %d \'%s\' \'%s\'', row.id, row.path, row.value)
		continue
	}

	// default lang
	let lang = "all"

	// if it's an abbreviation field such as 'wof:country'
	// then write it under the catchall 'all' language, else:
	if (row.fullkey.startsWith("$.wof:")) {
		// parse path
		const parts = row.path.match(/^\$\."([\w]+):([\w]+)"$/)

		if (!parts || parts.length !== 3) {
			console.error("invalid path: %d '%s'", row.id, row.path)
			continue
		}

		// split language tag in to components
		const s = parts[2]!.split("_")
		lang = s.slice(0, s.length - 2).join("_")
	}

	// enforce langauge blacklist
	if (blacklist.has(lang)) continue

	let placetypeEntry = placetypeMap.get(row.placetype)

	if (!placetypeEntry) {
		placetypeEntry = new Map()
		placetypeMap.set(row.placetype, placetypeEntry)
	}

	// generate in-memory data structure
	const [, field] = row.fullkey.match(/^\$\."([\w:_]+)"/) || []

	if (!field) {
		throw new Error(`Invalid field: ${row.fullkey}`)
	}

	let fieldData = placetypeEntry.get(field)

	if (!fieldData) {
		fieldData = new Set()
		placetypeEntry.set(field, fieldData)
	}

	fieldData.add(row.value)
}

// rowProgress.stop()

let processed = 0
performance.mark("start-importer")

// const writeProgress = new SingleBar({}, Presets.shades_classic)
// writeProgress.start(placetypeMap.size, 0)

for (const [placetype, record] of placetypeMap) {
	processed++
	console.log(`${processed}/${placetypeMap.size} ${placetype}`)

	console.log(`Writing ${placetype}...`)

	const placetypePath = resourceDictionaryDirectory(placetype)

	await mkdir(placetypePath, {
		recursive: true,
	})

	for (const [field, fieldData] of record) {
		const filePath = placetypePath(`${field}.txt`)

		await writeFile(filePath, Array.from(fieldData).sort().join("\n"))
	}
}

// writeProgress.stop()

performance.mark("end-importer")

const importerMeasure = performance.measure("importer", "start-importer", "end-importer")

console.log(`Processed ${processed} placetypes in ${importerMeasure.duration.toFixed(2)}ms`)
