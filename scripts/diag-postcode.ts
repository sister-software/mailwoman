import { WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
const lookup = new WofSqlitePlaceLookup({
	databasePath: [
		"/mnt/playpen/mailwoman-data/wof/admin-global-priority.db",
		"/mnt/playpen/mailwoman-data/wof/postalcode-us.db",
	],
})
for (const zip of ["10025", "94110", "60601"]) {
	const r = await lookup.findPlace({ text: zip, placetype: ["postalcode"], limit: 1 })
	console.log(
		`${zip} →`,
		r[0] && { id: r[0].id, name: r[0].name, lat: r[0].lat?.toFixed(3), lon: r[0].lon?.toFixed(3) }
	)
}
// confirm admin shard still works through the same multi-shard connection
const ny = await lookup.findPlace({ text: "New York", placetype: ["locality"], country: "US", limit: 1 })
console.log("New York (admin shard) →", ny[0] && { id: ny[0].id, name: ny[0].name })
