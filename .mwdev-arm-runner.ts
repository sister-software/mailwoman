
import { createGeocodeSession } from "mailwoman/geocode"

const request = JSON.parse(await new Response(process.stdin).text())
const session = await createGeocodeSession(request.options)
const answers = []

for (const input of request.inputs) {
	try {
		const { result } = await session.geocode(input)
		answers.push({ input, lat: result.lat, lon: result.lon, tier: result.resolution_tier, components: result.components })
	} catch (error) {
		answers.push({ input, lat: null, lon: null, tier: null, components: {}, error: String(error && error.message) })
	}
}

session[Symbol.dispose]()
process.stdout.write(JSON.stringify({ answers }))
