import { WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
const DB = process.argv[2] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const lookup = new WofSqlitePlaceLookup({ databasePath: DB })
console.log("DB:", DB)

const ny = await lookup.findPlace({ text: "New York", placetype: ["locality"], country: "US", limit: 3 })
const nycRank = ny.findIndex((p) => p.id === 85977539)
console.log("New York → top:", ny[0] && { id: ny[0].id, name: ny[0].name, pop: ny[0].population }, "| NYC rank:", nycRank + 1)

const il = await lookup.findPlace({ text: "Illinois", placetype: ["region"], country: "US", limit: 1 })
const spr = await lookup.findPlace({ text: "Springfield", placetype: ["locality"], parentId: il[0]?.id, limit: 1 })
console.log("Springfield@Illinois (parent-constraint):", spr[0] && { id: spr[0].id, name: spr[0].name, lat: spr[0].lat?.toFixed(2), lon: spr[0].lon?.toFixed(2) })

// proximity (needs place_bbox): localities near Chicago (41.88, -87.63)
const near = await lookup.findPlace({ text: "Springfield", placetype: ["locality"], country: "US", near: { lat: 41.88, lon: -87.63, maxDistanceKm: 300 }, limit: 1 })
console.log("Springfield near Chicago (bbox/proximity):", near[0] && { id: near[0].id, name: near[0].name, lat: near[0].lat?.toFixed(2), lon: near[0].lon?.toFixed(2) })
