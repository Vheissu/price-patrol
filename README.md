# price-patrol

Private grocery price comparison for Australian supermarkets. The system searches retailer sites, normalizes product data into a shared model, compares equivalent items, and exposes the results through an HTTP API, an MCP server, a web UI, and a terminal setup flow.

This project is scraping-first and browser-led. Puppeteer is used to behave like a normal browsing session, preserve cookies and store context, and fall back gracefully when a retailer site changes or pushes back.

## Current status

- Woolworths live scraping is working in local smoke tests.
- Coles live scraping is working in local smoke tests against the current `__NEXT_DATA__` search payload.
- ALDI live scraping is working in local smoke tests against the current first-party search flow.
- Historical SQLite fallback is enabled by default so the app can still return useful results when a live adapter degrades.

## Features

- Single-item comparison across Coles, Woolworths, and ALDI
- Basket comparison with split-basket and single-store totals
- Shared internal product model for scraping or future API-backed retailers
- Root TOML configuration with an interactive terminal wizard
- MCP server for assistant/tool use
- Aurelia 2 web UI for manual browsing and shopping-list workflows
- SQLite-backed request cache, price history, favorites, and watchlist storage
- Cache, retries, backoff, cooldown, and per-retailer concurrency limits
- Adapter health reporting and scrape diagnostics

## Repository layout

- [apps/api](/Users/dwayne/Code/price-patrol/apps/api) Fastify HTTP API
- [apps/mcp](/Users/dwayne/Code/price-patrol/apps/mcp) MCP server over stdio
- [apps/web](/Users/dwayne/Code/price-patrol/apps/web) Aurelia 2 frontend
- [packages/core](/Users/dwayne/Code/price-patrol/packages/core) shared comparison engine, adapters, config, cache, and normalization
- [packages/cli](/Users/dwayne/Code/price-patrol/packages/cli) terminal setup/config CLI
- [price-patrol.toml](/Users/dwayne/Code/price-patrol/price-patrol.toml) root config file
- [tech-spec.md](/Users/dwayne/Code/price-patrol/tech-spec.md) product and implementation spec

## Prerequisites

- Node.js 22+
- npm 10+
- A Chromium-capable local environment for Puppeteer

## Installation

```bash
npm install
```

## Quick start

1. Configure the app:

```bash
npm run setup
```

2. Inspect the active config if needed:

```bash
npm run config:show
```

3. Start the development stack:

```bash
npm run dev
```

This starts:

- API at `http://127.0.0.1:8787`
- Web UI via Vite
- MCP server over stdio

If port `8787` is already in use, start the API with a different `PORT` value.

## Root config

The app reads [price-patrol.toml](/Users/dwayne/Code/price-patrol/price-patrol.toml) from the project root. The setup wizard edits this file for you.

Main sections:

- `[browser]` Puppeteer identity, timeouts, viewport, headers, delays, session reuse, and user data directory
- `[cache]` cache TTL, live-scrape enablement, and historical fallback policy
- `[resilience]` retry attempts, exponential backoff, jitter, cooldown after throttling/challenge, and per-retailer concurrency
- `[defaultLocation]` fallback postcode and suburb used when a request omits location
- `[retailers.<name>]` enable/disable, live scrape toggle, and per-retailer result limit

Runtime data is stored under `.price-patrol-data/`, including the SQLite database used for adapter cache entries, saved lists, favorites, watchlist entries, and product price observations.

## Terminal CLI

The CLI is intended for non-technical setup and day-to-day config checks.

Commands:

- `npm run setup` interactive configuration wizard
- `npm run config:show` print the effective config

The wizard supports:

- default postcode and suburb
- headless vs visible browser mode
- live scrape and historical fallback policy
- cache TTL
- retry/backoff and cooldown settings
- retailer enablement and live-scrape flags

## Development commands

- `npm run build` build every workspace
- `npm run test` run core tests
- `npm run dev` start API, web UI, and MCP together
- `npm run dev:api` start only the API
- `npm run dev:web` start only the web UI
- `npm run dev:mcp` start only the MCP server

## HTTP API

The API lives in [server.ts](/Users/dwayne/Code/price-patrol/apps/api/src/server.ts).

Routes:

- `GET /api/health`
- `GET /api/adapters/health`
- `POST /api/compare/item`
- `POST /api/compare/basket`
- `POST /api/explain/item`
- `GET /api/saved-lists`
- `POST /api/saved-lists`
- `DELETE /api/saved-lists/:id`
- `GET /api/favorites`
- `POST /api/favorites`
- `DELETE /api/favorites/:productId`
- `GET /api/watchlist`
- `POST /api/watchlist`
- `DELETE /api/watchlist/:id`
- `GET /api/match-preferences`
- `POST /api/match-preferences`
- `GET /api/products/:productId/history`

### Example: compare one item

```bash
curl -X POST http://127.0.0.1:8787/api/compare/item \
  -H 'content-type: application/json' \
  --data '{
    "query": "full cream milk",
    "comparisonMode": "equivalent"
  }'
```

If `location` is omitted, the API fills it from `[defaultLocation]` in the root TOML when available.

`GET /api/health` also reports:

- active config path
- default location
- browser flags relevant to scraping
- cache policy
- resilience policy
- current adapter health

## MCP server

The MCP server lives in [server.ts](/Users/dwayne/Code/price-patrol/apps/mcp/src/server.ts).

Available tools:

- `compare_item`
- `compare_basket`
- `explain_item_choice`
- `retailer_health`

By default it calls `http://127.0.0.1:8787/api`. Override that with `PRICE_PATROL_API_URL` if needed.

## Web UI

The web app lives in [apps/web](/Users/dwayne/Code/price-patrol/apps/web) and currently includes:

- compare page
- basket page
- saved lists page

It talks only to the internal API and does not scrape directly.

## Scraping model

The scraping path is designed around realistic browser sessions rather than raw HTTP fetching.

Current behavior:

- shared Puppeteer browser instance
- reusable browser contexts per retailer and location
- cookie and consent persistence through the browser profile
- configurable delays and headers
- challenge and rate-limit detection
- retry with exponential backoff and jitter
- cooldown after throttling or challenge behavior
- per-retailer concurrency limiting
- observation capture into SQLite for historical price context
- fallback to the historical SQLite catalog when live extraction fails and fallback is enabled

## Testing and verification

Implemented checks currently cover the shared core package:

- config parsing defaults
- resilience helper behavior
- comparison service behavior
- current Coles, Woolworths, and ALDI parser shapes

Run them with:

```bash
npm run test
```

Build verification:

```bash
npm run build
```

## Git and generated files

Generated build output is ignored via [/.gitignore](/Users/dwayne/Code/price-patrol/.gitignore). That includes workspace `dist/` folders, cache directories, and browser/session data.

Important distinction:

- `dist/` JavaScript files are generated and should not be committed
- [packages/cli/src/index.js](/Users/dwayne/Code/price-patrol/packages/cli/src/index.js) is intentional source code and should be committed

## Known limitations

- Browser stealth here is pragmatic, not a full anti-detection framework
- The API currently uses Node's experimental `node:sqlite` module, so modern Node is required and a runtime warning is expected
- Retailer site changes can still require selector and flow updates
- Saved lists, favorites, and watchlist data are local to the working directory database

## Safety and intended use

This project is intended for private household use. It does not automate checkout, use authenticated customer accounts, or rely on private retailer APIs.
