import findFreePorts from "find-free-ports"

const MIN_PORT = 20_000
const MAX_PORT = 40_000
const startPort = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT
const [port] = await findFreePorts(1, { startPort, endPort: MAX_PORT })

process.stdout.write(String(port))
