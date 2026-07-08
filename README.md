# nexxus-hub-api

> Coordination server for a Nexxus deployment — every running node registers here so operators and tooling can see the fleet in one place.

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.0-blue.svg)](https://www.typescriptlang.org/)

---

## What this is

`nexxus-hub-api` is a small standalone HTTP server that acts as the **centralized registry** for a Nexxus deployment. Every Nexxus node (the API tier, workers, custom nodes) calls it on startup with a self-generated id, its role, network address, the installed versions of the Nexxus packages it depends on, and a snapshot of its runtime stats. On graceful shutdown the same node de-registers. Hub keeps the whole set in memory and exposes it over HTTP.

The point is a single vantage beyond what the message queue already coordinates — one address where a human, dashboard, or automation can ask "what's up right now, running which versions, on which hosts?" and get an authoritative answer.

Hub is a peer to the runnable API process, not something you `import` from a library — a different kind of process running against the same config and pluggable-service patterns from [`nexxus-lib`](https://github.com/Mayhem93/nexxus-lib).

---

## Capabilities (v1)

- **Node registry**: three HTTP endpoints — register, de-register, list. See [Endpoints](#endpoints) below.
- **Shared-secret auth**: every request carries an `Nxx-Hub-Token` header. Missing or wrong token → 401. Same secret configured on Hub and on each node.
- **In-memory state**: the registry lives in a `Map<nodeId, NodeRecord>` inside the process. No database, no message queue, no Redis. Hub restart wipes it; nodes re-register when they next cycle.
- **Pluggable logger**: same factory-based resolution as the rest of Nexxus. `WinstonNexxusLogger` is the built-in default; any other class name is treated as an npm package name and dynamic-imported from the app's `node_modules`, and must extend `NexxusBaseLogger`.
- **JSON-schema-validated configuration**: the config file is parsed and validated at startup against the aggregated schemas of every registered service. Bad config = fatal error with a clear message before the server accepts a request.
- **Graceful shutdown**: `SIGTERM` / `SIGINT` close the HTTP server cleanly.

---

## Endpoints

All endpoints require the `Nxx-Hub-Token` header carrying the secret configured in `app.token`. Missing or wrong token returns 401 with no body.

| Method   | Path                    | Purpose                                                                    |
| -------- | ----------------------- | -------------------------------------------------------------------------- |
| `POST`   | `/node`                 | Register (upsert) a node. Returns the stored `NodeRecord`.                 |
| `DELETE` | `/node/:id`             | De-register a node. Idempotent — `204` whether the id existed or not.      |
| `GET`    | `/node[?role=<role>]`   | List currently-registered nodes, optionally filtered by role.              |

The `POST /node` JSON body carries `id`, `role`, `privateIpAddress`, `dependencies` (installed `@mayhem93/*` package versions), and `stats` (a `getStats()` snapshot at registration time). Fresh `nodeId`s are minted per node boot (uuid v4), so restarting a node produces a new entry rather than reviving an old one. Hub does not refresh the `stats` snapshot after registration — callers needing live values query the node's own management server.

---

## Configuration

A minimal `nexxus.conf.json`:

```json
{
  "app": {
    "name": "nexxus-hub",
    "port": 9000,
    "token": "replace-me-with-a-real-secret",
    "logger": "WinstonNexxusLogger"
  },
  "logger": {
    "level": "info",
    "logType": "json",
    "transports": [
      { "type": "stdout" }
    ]
  }
}
```

The file is resolved in this order:

1. Explicit path passed to `NexxusConfigManager`
2. `NXX_CONF_PATH` environment variable
3. `/etc/nexxus/nexxus.conf.json` (the default)

Per-service CLI args and env vars declared by registered services (Hub itself, the logger) are picked up automatically.

---

## Running

**Prerequisites:**

- Node.js ≥ 24

**Build and start:**

```bash
npm install
npm run build
npm start
```

`npm start` runs `node --enable-source-maps dist/index.js`.

---

## Status

🚧 **Very early development.** The wire contract, config shape, and internal structure may all still shift. v1 is deliberately just the in-memory node registry described above; persistence, application management, and cross-node fanout are planned for later versions but not implemented yet.

---

## Related

- [`nexxus-lib`](https://github.com/Mayhem93/nexxus-lib) — the umbrella framework: config manager, base service, logger, pluggable-service resolvers, and the client helpers nodes use to talk to Hub
- [`@mayhem93/nexxus-core-lib`](https://www.npmjs.com/package/@mayhem93/nexxus-core-lib) — the core-lib package Hub itself depends on (shared config + logger contracts, plus the `HubClient` module used on the node side)

---

## License

MPL-2.0
