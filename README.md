# price-patrol

Private grocery price comparison for Australian supermarkets. The system searches retailer sites, normalizes product data into a shared model, compares equivalent items, and exposes the results through an HTTP API, an MCP server, a web UI, and a terminal setup flow.

This project is scraping-first and browser-led. Playwright drives real browser sessions so the app behaves like a normal shopper, keeps cookies and store context between runs, and falls back gracefully when a retailer site changes or pushes back.

## Current status

- Woolworths live scraping is working in local smoke tests.
- Coles live scraping is working in local smoke tests against the current `__NEXT_DATA__` search payload.
- ALDI live scraping is working in local smoke tests against the current first-party search flow.
- Historical SQLite fallback is enabled by default so the app can still return useful results when a live adapter degrades.

## Features

- Single-item comparison across Coles, Woolworths, and ALDI
- Basket comparison with split-basket and single-store totals
- Specials and price-drop detection from recorded price observations (`GET /api/deals`)
- Watchlist trigger states (watching, on special, target hit) and favourite price trends
- Shared internal product model for scraping or future API-backed retailers
- Root TOML configuration with an interactive terminal wizard
- MCP server for assistant/tool use
- Aurelia 2 web UI for manual browsing and shopping-list workflows
- SQLite-backed request cache, price history, favorites, and watchlist storage
- Cache, retries, backoff, cooldown, per-attempt deadlines, and per-retailer concurrency limits
- Circuit breaker that pauses live scraping for a retailer after repeated failures and serves saved data meanwhile
- Identical concurrent searches share one scrape instead of queueing twice
- Adapter health reporting (including circuit and cooldown state) and scrape diagnostics

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
- Playwright's Chromium build (used for ALDI)
- Google Chrome installed in its default location (Coles and Woolworths are driven through the Chrome channel because they are challenge-sensitive)

## Installation

```bash
npm install
npx playwright install chromium
```

`GET /api/health` reports `config.browser.runtime` so you can confirm both browsers were found. The API also logs a warning at startup if either is missing.

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

If port `8787` is already in use, start the API with a different `PORT` value. The API binds to `0.0.0.0` so other devices on your network can reach it; set `HOST=127.0.0.1` to keep it local.

## Root config

The app reads [price-patrol.toml](/Users/dwayne/Code/price-patrol/price-patrol.toml) from the project root. The setup wizard edits this file for you.

Main sections:

- `[browser]` browser identity, timeouts, viewport, headers, delays, session reuse, and the user data directory where per-retailer session state (cookies, store selection) is persisted between restarts
- `[cache]` cache TTL, live-scrape enablement, and historical fallback policy
- `[resilience]` retry attempts, exponential backoff, jitter, cooldown after throttling/challenge, per-retailer concurrency, the per-attempt deadline (`attemptTimeoutMs`), and the circuit breaker (`circuitBreakerFailureThreshold`, `circuitBreakerOpenMs`)
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
- `GET /api/deals` (recent promotions, price drops and new lows from recorded observations)

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

- today page (watchlist triggers, specials radar, favourites with price trends, adapter health, quick compare)
- compare page (live versus saved-data toggle, retailer filters, sorting, price-history sparkline, match explanations)
- basket page (per-store run sheet, single-store totals, retailer health)
- lists page (saved lists, favourites, watchlist with trigger states)

Both compare and basket requests accept `allowLiveScrape`; when disabled or when stores fail to answer, results come from recorded observations instead.

It talks only to the internal API and does not scrape directly.

## Scraping model

The scraping path is designed around realistic browser sessions rather than raw HTTP fetching.

Current behavior:

- one shared Playwright browser per retailer
- reusable browser contexts per retailer and location
- cookie and store-selection persistence via Playwright storage state saved under `[browser].userDataDir`, so Coles does not need to re-select a store after every restart
- configurable delays and headers
- challenge and rate-limit detection
- retry with exponential backoff and jitter, bounded by a per-attempt deadline
- cooldown after throttling or challenge behavior
- circuit breaker: after `circuitBreakerFailureThreshold` consecutive failed searches the retailer is skipped for `circuitBreakerOpenMs`, then a single probe is allowed through
- per-retailer concurrency limiting and coalescing of identical in-flight searches
- observation capture into SQLite for historical price context
- fallback to the historical SQLite catalog when live extraction fails and fallback is enabled

## Testing and verification

Implemented checks currently cover the shared core package:

- config parsing defaults
- resilience helper behavior, circuit breaker, and attempt deadlines
- in-flight search coalescing and cache reuse in the base adapter
- comparison service behavior, basket quantities, and savings maths
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
