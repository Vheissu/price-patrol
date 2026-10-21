Grocery Price Comparison MCP Service - Technical Specification

Overview

This document defines the technical specification for a private-use grocery price comparison system that collects publicly accessible product pricing and availability data from Australian supermarket websites and exposes the results through an internal API and MCP-compatible server.

The goal is to reduce household grocery costs by allowing a user to query products such as flour, milk, bread, eggs, yoghurt, mince, or a full shopping list and receive a comparison of the cheapest available options across supported supermarkets, including the store, price, savings compared with other retailers, and relevant caveats such as pack size differences, uncertain matches, or unavailable stock.

The initial implementation is scraping-first and browser-led. Public retailer websites are the source of truth. The system must be designed so retailer-specific scraping adapters can later be replaced or supplemented with official APIs without changing the external API contract, comparison logic, MCP tooling, or user-facing functionality.

The system is intended for private household use rather than public multi-tenant access.

Core Objectives

The system must:
	•	Search supported retailers for grocery items using normal user language.
	•	Compare equivalent products across retailers.
	•	Identify the cheapest result by shelf price and by unit price where appropriate.
	•	Show cost savings compared with alternative retailers.
	•	Support both single-item comparison and full basket comparison.
	•	Support postcode or store-context-aware pricing where retailer sites expose location-dependent prices.
	•	Expose functionality through both an internal HTTP API and an MCP server.
	•	Preserve a stable internal product model regardless of whether source data comes from browser scraping or official APIs later.
	•	Track freshness, source confidence, and comparison assumptions.
	•	Be resilient to retailer site changes and partial source failures.

Non-Goals

The system does not attempt to:
	•	Place orders with any retailer.
	•	Automate checkout.
	•	Use authenticated customer accounts.
	•	Access loyalty-only data that is not publicly visible.
	•	Provide public anonymous access.
	•	Guarantee exact in-store pricing where a retailer only exposes online or location-estimated pricing.
	•	Perform public commercial redistribution of collected pricing data.

Supported Retailers

The initial system supports:
	•	Coles
	•	Woolworths
	•	ALDI

Each retailer is integrated through a dedicated source adapter.

The system must be capable of adding more retailers later through the same adapter contract.

Product Philosophy

The product is a grocery comparison engine, not a scraping script.

Scraping is an implementation detail. Matching, normalization, pricing logic, basket comparison, savings logic, HTTP API responses, MCP tool outputs, and front-end behavior must all operate on a stable internal retail model.

This separation allows the system to:
	•	Replace scraping with official APIs later.
	•	Run mixed-mode integrations where one retailer uses scraping and another uses an API.
	•	Test product matching and price comparison independently from source extraction.
	•	Survive retailer page changes without rewriting the whole app.

High-Level Architecture

The system consists of the following logical layers.

Retailer Source Adapters

Each retailer has an adapter responsible for browsing public pages, collecting public product candidates, retrieving product detail information, applying public location context where relevant, and transforming raw source data into a normalized internal representation.

Each adapter must be isolated from the others. A failure in one adapter must not prevent the remaining adapters from returning results.

Normalization Layer

The normalization layer converts retailer-specific raw fields into a shared product shape.

This includes:
	•	Canonical product naming
	•	Brand extraction
	•	Variant extraction
	•	Pack size parsing
	•	Unit parsing
	•	Price normalization
	•	Promotion extraction
	•	Category normalization
	•	Availability normalization
	•	Location-context normalization

Matching and Equivalency Layer

This layer determines whether products are the same item, a high-confidence equivalent, a weak substitute, or non-comparable.

Comparison Engine

The comparison engine ranks candidates for a single item or basket and produces:
	•	Cheapest option
	•	Ranked alternatives
	•	Savings calculations
	•	Assumptions and caveats
	•	Confidence indicators
	•	Availability considerations
	•	Basket totals and split-basket results

Caching and Snapshot Layer

This layer stores fetched and normalized results so the system can reduce repeated browsing, improve response times, and build price history.

Internal HTTP API

The internal API is the stable contract used by the front end and the MCP server.

MCP Server

The MCP server wraps the internal API with focused shopping tools for assistant-driven use.

Web Front End

The front end provides a private household UI for search, basket comparison, shopping lists, result inspection, and savings review.

Browser-Led Scraping Strategy

The scraping implementation is browser-based and must behave like a normal browsing session rather than a simplistic request-only crawler.

Puppeteer is a first-class part of the retrieval strategy and is used to replicate realistic browsing behavior with appropriate headers, cookies, navigation flow, rendering support, and store-selection persistence.

Why Puppeteer Is Required

Puppeteer is used because retailer sites may:
	•	Depend on client-side rendering or hydration
	•	Gate pricing behind store or postcode selection flows
	•	Render product content differently after cookies or consent are set
	•	Populate product information through in-page network activity
	•	Behave inconsistently when accessed through raw non-browser requests

Puppeteer Responsibilities

The browser automation layer must support:
	•	Realistic navigation through search, category, and product pages
	•	Standard browser request headers
	•	Cookie persistence across related browsing steps
	•	Store or postcode selection within a session where publicly available
	•	DOM extraction from rendered content
	•	Inspection of public in-page network responses when helpful
	•	Recovery from navigation timing issues and incomplete page render states

Browser Session Model

Each retailer adapter operates with reusable browser sessions that preserve:
	•	Cookie state
	•	Consent state where relevant
	•	Selected store or postcode context
	•	Locale and region assumptions
	•	Related navigation context for multiple product lookups

The session model must avoid repeating consent or store-selection flows for every product query.

Retrieval Modes

The adapter may use different retrieval modes depending on the retailer and page structure.

Search Page Retrieval
A retailer search page or public search flow is used to gather initial candidate products for a user query.

Category Retrieval
When search quality is poor, the adapter may use category pages to gather relevant candidate products and then filter them locally.

Product Detail Retrieval
A public product detail page is used to enrich a candidate with better product name, pack size, unit price, variant data, promotion text, or availability status.

Network-Aware Retrieval
If a retailer page loads public product data through network responses during rendering, the adapter may capture and use that public data to improve consistency and reduce brittle DOM parsing.

Store and Location Context

Retailer pricing may depend on postcode, suburb, or selected store.

The adapter must support public location-setting flows where available. This includes:
	•	Entering a postcode or suburb
	•	Choosing a store from a public list
	•	Confirming that store context is applied to the session
	•	Preserving the result for subsequent lookups in the same session

The adapter must record the resulting store context and expose it downstream.

Cookie and Consent Handling

The browser layer must detect and handle public consent banners where relevant.

It must:
	•	Recognize whether a consent state is required for the page to function normally
	•	Preserve resulting cookies for subsequent pages
	•	Avoid unnecessary repetition of consent interactions

Request Realism

The browser-led scraping flow must resemble normal browsing behavior.

This includes:
	•	Stable browser identity
	•	Consistent navigation paths
	•	Appropriate wait conditions for rendered content
	•	Reuse of cookies and context
	•	Avoidance of bursty and unnecessary repeated page loads

Page Stability Strategy

Extraction must wait for a stable page state before parsing. Stability may be determined by:
	•	Presence of product cards or price elements
	•	Presence of rendered product titles
	•	Quiet network windows where appropriate
	•	Confirmation that store context has been applied
	•	Completion of relevant public network responses

The scraper must not rely entirely on arbitrary fixed delays.

Selector and Parsing Resilience

The extraction layer must not depend on one fragile selector for critical information.

It should support:
	•	Multiple fallback selectors for price, title, unit price, and size
	•	Embedded metadata extraction where available
	•	Text-based fallback parsing for obvious price and size strings
	•	Structural heuristics for product cards and detail layouts

Failure Detection in Browser Sessions

The browser layer must detect and classify failures such as:
	•	Search returned no results
	•	Page loaded but product data was missing
	•	Store-selection state failed to apply
	•	Session reset or cookie state lost
	•	Retailer page structure changed materially
	•	Temporary navigation failure
	•	Retailer-side throttling or challenge behavior

These must be surfaced as adapter warnings or adapter errors rather than silent empty results.

Browser Resource Strategy

The system must balance realism with efficiency.

This includes:
	•	Reusing browser instances where appropriate
	•	Reusing retailer contexts for the same location
	•	Recycling tabs or pages rather than reopening everything unnecessarily
	•	Limiting concurrent browser-heavy work
	•	Cleaning up stale pages and contexts to avoid memory waste

Browser Observability

The system must record browser-level diagnostics for maintenance.

This includes:
	•	Which retrieval mode succeeded
	•	Whether cookies were reused or refreshed
	•	Whether store context was applied successfully
	•	Whether DOM extraction or network-aware extraction was used
	•	Which critical fields were extracted confidently versus inferred
	•	Whether a retailer page structure appears to have changed

Data Collection Rules

The scraping-based MVP collects only data from publicly accessible retailer pages and public browsing flows.

Allowed Collection Scope

The system may collect:
	•	Product names
	•	Brands
	•	Pack sizes
	•	Shelf prices
	•	Unit prices where shown
	•	Promotion labels or sale text where shown publicly
	•	Availability indicators where shown publicly
	•	Store or location context where shown publicly
	•	Product and category URLs
	•	Freshness timestamps

Excluded Collection Scope

The system must not depend on:
	•	Logged-in customer sessions
	•	Checkout flows
	•	Account-only pricing
	•	Saved carts
	•	Authenticated loyalty pricing that is not public
	•	Private APIs requiring credentials

Collection Frequency Expectations

The system should fetch fresh data often enough to be useful but should strongly prefer caching and result reuse over redundant browsing.

Internal Normalized Product Model

All retailer outputs must map into the same internal product representation.

Identity Fields
	•	Internal record identifier
	•	Retailer identifier
	•	Retailer product identifier if available
	•	Source URL
	•	Source type
	•	Store identifier if known
	•	Store display name if known
	•	Location context such as suburb or postcode if known

Product Description Fields
	•	Canonical display name
	•	Raw retailer product name
	•	Brand
	•	Product line if identifiable
	•	Variant descriptor
	•	Category path
	•	Structured attributes such as plain, self-raising, gluten-free, organic, wholemeal, full cream, skim, unsalted, free range

Pack and Unit Fields
	•	Pack size value
	•	Pack size unit
	•	Multipack quantity if applicable
	•	Derived total quantity
	•	Comparable unit type
	•	Unit price value
	•	Unit price unit
	•	Whether unit price was source-provided or inferred

Pricing Fields
	•	Shelf price
	•	Promotional price if distinct
	•	Promotion text
	•	Effective comparison price
	•	Currency
	•	Price scope
	•	Price confidence

Availability Fields
	•	Availability state
	•	Availability confidence
	•	Low stock indicator where visible

Freshness Fields
	•	Last fetched timestamp
	•	Last parsed timestamp
	•	Source snapshot timestamp
	•	Staleness classification

Comparison Fields
	•	Match group identifier
	•	Match confidence
	•	Eligible comparison modes
	•	Notes and warnings

Query Understanding

The system must transform user-friendly shopping queries into comparison-ready search intents.

Examples include:
	•	flour
	•	plain flour
	•	1kg plain flour
	•	gluten free flour
	•	cheap milk
	•	full cream milk 2L
	•	eggs
	•	greek yoghurt
	•	beef mince

The query pipeline must identify:
	•	Core product type
	•	Desired variant or subtype
	•	Pack size preference if stated
	•	Brand preference if stated
	•	Dietary or quality constraints
	•	Comparison mode if stated or implied

If the user does not specify a mode, the default behavior should be equivalent-item comparison with pack-size-aware ranking.

Comparison Modes

Exact Match Mode

Exact match mode attempts to find the same product or near-identical SKU across retailers.

This mode strongly prioritizes:
	•	Same brand
	•	Same product type
	•	Same variant
	•	Same pack size
	•	Very similar naming

This mode is appropriate when the user wants a specific product.

Equivalent Item Mode

Equivalent item mode compares functionally similar products across retailers.

This is the default mode for generic grocery shopping queries.

This mode prioritizes:
	•	Same category and subtype
	•	Same intended use
	•	Similar pack size
	•	Similar quality tier
	•	Same dietary constraints

Example: plain flour 1kg across standard supermarket house-brand or similar entry-level options.

Best Value Mode

Best value mode ranks by unit price after filtering out non-equivalent variants.

This mode is appropriate when the user wants the cheapest usable option in a category rather than the lowest absolute shelf price for any random pack.

The ranking logic must:
	•	Exclude clearly non-equivalent variants
	•	Normalize pack sizes before comparison
	•	Prefer reliable source-provided unit prices where available
	•	Derive unit pricing where enough information exists
	•	Show actual shelf price alongside unit-price ranking
	•	Explain when a larger pack is better value but costs more upfront

Matching and Equivalency Rules

The system must decide whether products are identical, substitutable, or not comparable.

Match Inputs

Matching considers:
	•	Product type
	•	Brand
	•	Variant
	•	Pack size
	•	Structured product attributes
	•	Unit type
	•	Category placement
	•	Naming similarity
	•	Pricing coherence

Match Outcomes

Every candidate comparison must be assigned one of the following outcomes:
	•	Exact match
	•	High-confidence equivalent
	•	Moderate-confidence equivalent
	•	Low-confidence possible substitute
	•	Rejected as non-equivalent

Equivalent Examples

The following should usually be treated as equivalents if pack size is comparable:
	•	Plain flour 1kg across standard house brands
	•	Full cream milk 2L across standard supermarket own-brand lines
	•	Greek yoghurt tubs of similar weight and plain style
	•	Free range eggs of the same count and similar size classification

Non-Equivalent Examples

The following should not be treated as equivalent without explicit user intent:
	•	Plain flour versus self-raising flour
	•	Wheat flour versus gluten-free flour
	•	Salted butter versus unsalted butter
	•	Full cream milk versus skim milk
	•	Premium branded item versus generic home-brand substitute when exact match is requested

Size and Quantity Normalization

Pack-size-aware comparison is critical.

The system must normalize sizes across:
	•	g and kg
	•	ml and L
	•	item counts
	•	multipacks
	•	mixed pack descriptors

Where products differ in size, the system must:
	•	Compare unit price when products remain equivalent
	•	Show the pack-size difference clearly
	•	Indicate when a larger pack is cheaper per unit but more expensive at the shelf

Brand Sensitivity

Brand influences matching differently depending on mode.
	•	Exact mode strongly prefers same-brand or same-SKU results
	•	Equivalent mode allows different brands within the same functional class
	•	Best-value mode may prefer home-brand or budget-tier items when they satisfy the same use case

Attribute Sensitivity

Certain attributes must be treated as match-critical.

Examples include:
	•	Gluten-free
	•	Organic
	•	Lactose-free
	•	Wholemeal
	•	Full cream
	•	Skim
	•	Unsalted
	•	Free range
	•	Cage free

If the user specifies one of these attributes, products without that attribute must be excluded.

Match Confidence

Every matched result must carry a confidence score based on:
	•	Query alignment
	•	Variant alignment
	•	Pack-size comparability
	•	Naming similarity
	•	Attribute overlap
	•	Brand compatibility
	•	Category consistency

Confidence must influence ranking and must also be exposed in explanations.

Pricing Logic

Shelf Price

Shelf price is the visible public price a user would pay for the product unit shown.

Promotional Price

If the source exposes a promotional price or sale state publicly, the system must capture:
	•	Promotional price
	•	Promotion description
	•	Promotion scope if inferable
	•	Whether the standard price appears replaced or crossed out

Effective Comparison Price

The comparison engine must define an effective comparison price for ranking.

For exact and equivalent mode, this is usually the shelf or promotional price for the relevant pack.

For best-value mode, this may prioritize unit price while still exposing the shelf price.

Unit Price

Unit price must be used whenever pack sizes differ but the products remain comparable.

If the source does not provide a unit price, the system should derive it when sufficient pack-size information exists. Derived unit pricing must be marked as inferred.

Savings Calculations

The system must calculate savings against other retailers in a way that is easy to explain.

For each result it should provide:
	•	Savings versus the next cheapest comparable option
	•	Savings versus the most expensive comparable option
	•	Savings per item
	•	Basket-level savings when applicable

Pricing Caveats

The result must display caveats when:
	•	Store context is missing or uncertain
	•	Pricing may differ by store
	•	The price source is older than the preferred freshness window
	•	Unit price was inferred rather than source-provided
	•	The match is lower confidence than normal

Availability Logic

Availability should be captured where it is publicly visible.

Possible states include:
	•	In stock
	•	Low stock
	•	Out of stock
	•	Availability unknown

Availability affects ranking but should not automatically exclude a result unless the user explicitly wants only in-stock items.

If all retailer candidates are unavailable, the system should still show the last known comparable results with clear warnings.

Freshness and Staleness Model

Each result must include freshness information because price data can change frequently.

Freshness Levels

The system should classify data into broad levels such as:
	•	Fresh
	•	Recent
	•	Aging
	•	Stale

Freshness Policy

The comparison engine should prefer fresher data when choosing between otherwise similar results.

Different actions may tolerate different freshness windows.
	•	Single-item comparison may tolerate slightly older cached data if the result is still useful
	•	Basket totals should prefer fresher data where practical
	•	Price history views require clear timestamping of every recorded snapshot

Revalidation

When cached data is near or beyond the preferred freshness window, the relevant adapter should refresh it before returning the result where practical.

Caching and Snapshot Strategy

Caching is required for both performance and browsing discipline.

Query Cache

Search terms such as plain flour or eggs should reuse recent candidate sets when they remain fresh enough.

Product Snapshot Cache

Product detail pages and normalized product records should be cached separately from raw search results.

Store-Context Cache

Location-specific sessions and public store selections should be reusable for a limited period where the session remains valid.

Raw Snapshot Retention

The system should retain enough raw snapshot detail to:
	•	Re-parse products if normalization improves
	•	Investigate source changes when extraction fails
	•	Explain why a particular price was recorded

Historical Price Tracking

When the same normalized product is seen again, the system should record a new price snapshot rather than simply overwrite the existing one.

This enables later features such as:
	•	Price trends
	•	Sale credibility checks
	•	Retailer price-range analysis
	•	Basket cost change tracking over time

Single-Item Comparison Flow

A single-item comparison starts with a user query and returns the cheapest suitable product options across retailers.

Flow
	1.	The user submits an item query and optional location.
	2.	The system resolves comparison mode and filters.
	3.	Relevant retailer adapters retrieve or reuse public product candidates.
	4.	The normalization layer structures the products.
	5.	The matching layer filters candidates into valid comparison groups.
	6.	The comparison engine ranks results.
	7.	The API returns the recommendation, alternatives, savings, freshness, and caveats.

Output Expectations

The result must include:
	•	Recommended cheapest option
	•	Retailer name
	•	Product name
	•	Pack size
	•	Shelf price
	•	Unit price where relevant
	•	Savings versus alternatives
	•	Match confidence
	•	Availability state
	•	Source timestamp
	•	Warnings or assumptions

Basket Comparison Flow

Basket comparison evaluates a list of items and determines the most cost-effective shopping strategy.

Basket Modes

The system must support at least two basket strategies.

Single-Retailer Basket
All matched items are priced using the same retailer where possible. The output must include:
	•	Basket total per retailer
	•	Missing items per retailer
	•	Best single-store option

Split Basket
Each item is sourced from the cheapest valid retailer independently. The output must include:
	•	Cheapest combined total
	•	Per-item retailer allocation
	•	Total savings versus each single-retailer basket
	•	A note that this strategy requires visiting multiple stores

Missing Items

If an item cannot be matched confidently for a retailer, the basket response must show:
	•	Item unmatched
	•	Reason for mismatch or absence
	•	Whether near matches exist

Basket Substitution Rules

Basket comparison should allow configurable substitution strictness.

Examples:
	•	Exact-only basket
	•	Equivalent-items basket
	•	Best-value basket
	•	Exclude low-confidence matches

Internal HTTP API Behavior

The internal API is the stable contract used by both the front end and the MCP server.

Core Capabilities

The API must support:
	•	Single-item comparison
	•	Basket comparison
	•	Product detail lookup
	•	Comparison explanation
	•	Retailer health visibility
	•	Refresh triggering where appropriate

Response Qualities

All responses must be:
	•	Human-readable enough for direct UI rendering
	•	Structured enough for assistant use through MCP
	•	Explicit about assumptions and confidence
	•	Consistent regardless of source adapter implementation

Comparison Explanation

The API must be able to explain why a product was chosen.

This explanation should cover:
	•	Which comparison mode was used
	•	Why alternative products were excluded or ranked lower
	•	Whether unit price or shelf price drove the ranking
	•	Whether pack-size differences affected the outcome
	•	Whether freshness or availability influenced the choice

MCP Server Behavior

The MCP server wraps the internal API and exposes focused tools for shopping queries.

Tooling Goals

The MCP layer must make it easy for an assistant to answer questions such as:
	•	Where is the cheapest flour this week
	•	Compare milk prices near me
	•	Which supermarket is cheapest for this shopping list
	•	How much would I save if I bought these items at ALDI instead of Woolworths
	•	Why did you choose this product as the cheapest option

MCP Tool Categories

The MCP tool surface should include:
	•	Single-item comparison
	•	Basket comparison
	•	Product explanation
	•	Store-specific comparison
	•	Savings summary for a known list

MCP Output Qualities

Results returned to an assistant must include:
	•	Clean product summaries
	•	Store names
	•	Prices and unit prices where relevant
	•	Savings calculations
	•	Warnings and assumptions
	•	Location context
	•	Timestamps

The MCP layer must not expose raw scraping internals unless debugging is explicitly requested.

Front-End Application Behavior

The front end is a private household interface built with Aurelia 2, TypeScript, Vite, and Tailwind v4.

Main User Journeys

The application must support:
	•	Searching for a single grocery item
	•	Comparing a weekly shopping basket
	•	Saving reusable shopping lists
	•	Reviewing cheapest store recommendations
	•	Inspecting why a result was selected
	•	Viewing current prices and recent savings

Search and Compare Screen

The single-item comparison UI must show:
	•	Search input
	•	Optional postcode or suburb input
	•	Comparison mode selection
	•	Product result list
	•	Cheapest recommendation card
	•	Alternatives with prices and savings
	•	Freshness and availability indicators
	•	Notes about pack-size differences or uncertain matches

Basket Screen

The basket UI must allow the user to:
	•	Add multiple grocery items
	•	Reorder or remove items
	•	Set comparison mode for the whole basket
	•	Compare single-store and split-basket outcomes
	•	View per-retailer totals
	•	View savings against alternative strategies

Saved Lists

The system should allow reusable shopping lists such as:
	•	Weekly groceries
	•	Baking supplies
	•	School lunch items
	•	BBQ supplies

Saved lists should retain:
	•	Item names
	•	Optional quantity hints
	•	Optional preferred variants
	•	Comparison preferences where relevant

Result Explanation UI

Each result should provide a plain-language explanation of:
	•	Why the product matched the query
	•	Why it was considered cheapest
	•	Whether size normalization affected the ranking
	•	Whether another product was excluded for not being equivalent

Freshness and Reliability Indicators

The UI must communicate:
	•	When results were last refreshed
	•	Whether pricing is location-specific
	•	Whether unit price was inferred
	•	Whether a result is lower confidence than usual

Error Handling and Degraded Modes

The system must continue working even when one or more retailer adapters fail.

Partial Retailer Failure

If one retailer is unavailable, the comparison should return results from the remaining retailers and clearly indicate that one source could not be checked.

Low-Confidence Match Sets

If the system finds only weak substitutes, it should return them with a warning rather than silently presenting them as fully equivalent.

Empty Result Sets

If no suitable products are found, the response should explain whether:
	•	No products matched the query
	•	The location context was too narrow
	•	Retailer adapters failed
	•	The requested filters were too strict

Browser Degradation

If Puppeteer-based extraction fails for a retailer due to site changes or temporary issues, the adapter must mark itself degraded and avoid poisoning comparison output with misleading data.

Observability and Maintenance

Retailer sites change, so the system must make maintenance straightforward.

Adapter Health Signals

Each adapter should report:
	•	Last successful retrieval
	•	Current health state
	•	Failure trend
	•	Extraction confidence
	•	Store-context success rate
	•	Whether browser-driven retrieval is functioning normally

Extraction Diagnostics

The system should preserve enough diagnostics to understand:
	•	Which pages failed
	•	Which fields could not be extracted
	•	Whether selectors or embedded metadata changed
	•	Whether page rendering changed materially

Comparison Diagnostics

For tuning and debugging, the system should be able to show:
	•	Which products were considered
	•	Which products were rejected and why
	•	Which attributes drove equivalence decisions
	•	Why the chosen product outranked alternatives

Adapter Replaceability and API Migration

A core requirement is that scraping adapters can later be replaced by official API-backed adapters.

Stable Adapter Contract

Each retailer integration must present the same normalized outputs regardless of whether the source is:
	•	Browser scraping
	•	Public network responses observed through the browser
	•	Official retailer API
	•	Hybrid mode

Migration Path

When official API access becomes available for a retailer:
	•	The retailer adapter may switch to API-backed retrieval
	•	The normalization layer remains the same unless richer fields are introduced
	•	Matching and comparison logic remain unchanged
	•	The internal HTTP API remains unchanged
	•	MCP tool behavior remains unchanged
	•	Historical price tracking remains continuous where product identity can be preserved

Mixed-Mode Support

The system must support a state where:
	•	One retailer uses official APIs
	•	One retailer uses browser-based scraping
	•	One retailer uses a hybrid strategy

This mixed mode must not affect the front end or assistant consumers.

Security and Private Deployment Assumptions

The service is intended for trusted private use.

Access Model

The application and MCP server are intended for a private environment rather than public anonymous access.

Internal Exposure

The API should be reachable only by the household front end, local tools, or approved assistant integrations.

Data Retention

The system should retain only the data necessary for comparison, caching, explanation, and limited price history.

Future Enhancements

The following features are compatible with the architecture but are not required for the initial MVP:
	•	Price alerts for tracked items
	•	Price history charts
	•	Favorite brand preferences
	•	Travel-aware savings logic for split-basket shopping
	•	Pantry-aware bulk-buy recommendations
	•	Promotion trust analysis based on recent price history

Acceptance Criteria

The scraping-based MVP is functionally complete when it can:
	•	Compare a single grocery item across Coles, Woolworths, and ALDI using public data
	•	Apply postcode or store context where public retailer flows support it
	•	Use Puppeteer to browse and retrieve public pricing data in a browser-realistic way
	•	Normalize product names, pack sizes, prices, and availability into a shared model
	•	Distinguish exact matches from equivalent products and weak substitutes
	•	Rank by shelf price and unit price appropriately
	•	Return savings calculations against alternative retailers
	•	Compare a multi-item basket with both single-store and split-basket outcomes
	•	Expose comparison capabilities through a stable internal API and MCP server
	•	Present results clearly in the Aurelia front end with explanations, freshness indicators, and caveats
	•	Continue functioning when one retailer adapter is degraded or temporarily unavailable
	•	Allow scraping adapters to be replaced later with official API-backed implementations without changing user-facing behavior

Summary

This system is a private grocery price comparison service that uses browser-based scraping of public retailer data to help reduce household shopping costs.

Its key technical characteristics are:
	•	Public-data retrieval only
	•	Puppeteer-driven browser realism for retailer interaction
	•	Stable normalized product model
	•	Match-aware comparison logic
	•	Pack-size and unit-price-aware ranking
	•	Basket comparison support
	•	MCP integration for assistant-driven shopping queries
	•	Front-end support for manual household use
	•	Adapter isolation and replaceability for future official API migration

The design ensures scraping remains a replaceable source strategy while the comparison engine, user experience, and assistant integration stay stable over time.