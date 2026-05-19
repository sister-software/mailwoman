/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Redis } from "ioredis"
import { pluckPlacetypeSpec, ResourceMapCache, WOFFeature } from "mailwoman/core"
import { readFileSync } from "node:fs"

class FeatureCache extends Redis implements AsyncDisposable {
	public async [Symbol.asyncDispose]() {
		await this.quit()
	}
}

const resourceIndex = new ResourceMapCache((key: string) => {
	return new FeatureCache({
		keyPrefix: key + ":",
	})
})

const WOFCache = resourceIndex.open("wof")
const PlaceNameCache = resourceIndex.open("placename")

async function insertRecord(filePath: string): Promise<void> {
	const fileContent = readFileSync(filePath, "utf8")

	const feature: WOFFeature = JSON.parse(fileContent)
	const superseded_by = feature.properties["wof:superseded_by"]

	if (superseded_by && superseded_by.length !== 0) {
		return
	}

	// TODO: We could probably use the props as written since they're delimited by colons,
	// just like the keys in the properties object.
	// So we could just use the keys as the keys in the localizedPropMap.
	const { localizedPropMap, placetype, ...props } = pluckPlacetypeSpec(feature.properties)

	const placeTypeCache = resourceIndex.open(placetype)

	for (const [languageCode, localizedPropsMap] of localizedPropMap) {
		for (const [kind, value] of localizedPropsMap) {
			await Promise.all([
				WOFCache.sadd(placetype, value),
				placeTypeCache.sadd(languageCode, value),
				PlaceNameCache.sadd(value, kind),
			])
		}
	}
}

export default insertRecord
