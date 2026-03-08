#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import {
  findProjectConfigPath,
  getDefaultProjectConfig,
  getProjectConfig,
  saveProjectConfig
} from "@price-patrol/core";

const command = process.argv[2] ?? "help";
const subcommand = process.argv[3];

main().catch((error) => {
  if (error && typeof error === "object" && error.code === "ABORT_ERR") {
    writeLine("");
    writeLine("Setup cancelled.");
    process.exitCode = 130;
    return;
  }

  throw error;
});

async function main() {
  switch (`${command}${subcommand ? `:${subcommand}` : ""}`) {
    case "setup":
      await runSetupWizard();
      break;
    case "config:show":
      await showConfig();
      break;
    default:
      printHelp();
      process.exitCode = command === "help" ? 0 : 1;
  }
}

async function runSetupWizard() {
  const configPath = (await findProjectConfigPath()) ?? join(process.cwd(), "price-patrol.toml");
  const existingConfig = await loadConfig();
  const config = cloneConfig(existingConfig);

  const rl = createInterface({ input, output });
  try {
    printHeader("Price Patrol Setup Wizard");
    writeLine(`Config file: ${configPath}`);
    writeLine("Press Enter to keep the current value shown in brackets.");
    writeLine("Type 'none' for postcode or suburb if you want to clear that default.");
    writeLine("");

    config.defaultLocation.postcode = await promptText(rl, "Default postcode", config.defaultLocation.postcode, { allowNone: true });
    config.defaultLocation.suburb = await promptText(rl, "Default suburb", config.defaultLocation.suburb, { allowNone: true });

    printSection("Browser");
    config.browser.headless = await promptBoolean(rl, "Run Chromium in headless mode", config.browser.headless);
    config.browser.minHumanDelayMs = await promptNumber(rl, "Minimum human delay (ms)", config.browser.minHumanDelayMs, { min: 0 });
    config.browser.maxHumanDelayMs = await promptNumber(rl, "Maximum human delay (ms)", config.browser.maxHumanDelayMs, {
      min: config.browser.minHumanDelayMs
    });

    printSection("Scrape Policy");
    config.cache.liveScrapeEnabled = await promptBoolean(rl, "Enable live scraping globally", config.cache.liveScrapeEnabled);
    config.cache.useHistoricalFallbackOnFailure = await promptBoolean(
      rl,
      "Fallback to the historical SQLite catalog when live scraping fails",
      config.cache.useHistoricalFallbackOnFailure
    );
    config.cache.ttlMs = await promptNumber(rl, "Cache TTL (ms)", config.cache.ttlMs, { min: 1_000 });

    printSection("Rate Limits");
    config.resilience.maxAttempts = await promptNumber(rl, "Max live scrape attempts", config.resilience.maxAttempts, { min: 1 });
    config.resilience.baseBackoffMs = await promptNumber(rl, "Initial backoff (ms)", config.resilience.baseBackoffMs, { min: 100 });
    config.resilience.maxBackoffMs = await promptNumber(rl, "Maximum backoff (ms)", config.resilience.maxBackoffMs, {
      min: config.resilience.baseBackoffMs
    });
    config.resilience.cooldownMs = await promptNumber(rl, "Cooldown after throttling or challenge (ms)", config.resilience.cooldownMs, {
      min: config.resilience.baseBackoffMs
    });
    config.resilience.jitterMs = await promptNumber(rl, "Backoff jitter (ms)", config.resilience.jitterMs, { min: 0 });
    config.resilience.maxConcurrentRetailerTasks = await promptNumber(
      rl,
      "Concurrent live tasks per retailer",
      config.resilience.maxConcurrentRetailerTasks,
      { min: 1 }
    );

    printSection("Retailers");
    for (const retailer of ["coles", "woolworths", "aldi"]) {
      writeLine(retailerLabel(retailer));
      config.retailers[retailer].enabled = await promptBoolean(rl, `  Enable ${retailerLabel(retailer)}`, config.retailers[retailer].enabled);
      config.retailers[retailer].liveScrape = await promptBoolean(
        rl,
        `  Allow live scraping for ${retailerLabel(retailer)}`,
        config.retailers[retailer].liveScrape
      );
      config.retailers[retailer].maxResults = await promptNumber(
        rl,
        `  Max results returned for ${retailerLabel(retailer)}`,
        config.retailers[retailer].maxResults,
        { min: 1 }
      );
    }

    printSection("Summary");
    printSummary(config);

    const shouldWrite = await promptBoolean(rl, `Write config to ${configPath}`, true);
    if (!shouldWrite) {
      writeLine("Aborted without changing the config file.");
      return;
    }

    const writtenPath = await saveProjectConfig(config, configPath);
    writeLine(`Saved ${writtenPath}`);
    writeLine("Next steps:");
    writeLine("  npm run build");
    writeLine("  npm run dev");
  } finally {
    rl.close();
  }
}

async function showConfig() {
  const configPath = await findProjectConfigPath();
  const config = await loadConfig();

  printHeader("Price Patrol Config");
  writeLine(`Config file: ${configPath ?? "(using defaults only)"}`);
  printSummary(config);
}

async function loadConfig() {
  try {
    return await getProjectConfig();
  } catch {
    return getDefaultProjectConfig();
  }
}

function cloneConfig(config) {
  return {
    browser: { ...config.browser, blockResourceTypes: [...config.browser.blockResourceTypes], launchArgs: [...config.browser.launchArgs] },
    cache: { ...config.cache },
    resilience: { ...config.resilience },
    defaultLocation: { ...config.defaultLocation },
    retailers: {
      coles: { ...config.retailers.coles },
      woolworths: { ...config.retailers.woolworths },
      aldi: { ...config.retailers.aldi }
    }
  };
}

async function promptText(rl, label, currentValue, options = {}) {
  const response = (await rl.question(`${label} [${currentValue ?? ""}]: `)).trim();
  if (!response) {
    return currentValue;
  }
  if (options.allowNone && response.toLowerCase() === "none") {
    return undefined;
  }
  return response;
}

async function promptBoolean(rl, label, currentValue) {
  while (true) {
    const response = (await rl.question(`${label} [${currentValue ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
    if (!response) {
      return currentValue;
    }
    if (["y", "yes"].includes(response)) {
      return true;
    }
    if (["n", "no"].includes(response)) {
      return false;
    }
    writeLine("  Enter y or n.");
  }
}

async function promptNumber(rl, label, currentValue, options = {}) {
  while (true) {
    const response = (await rl.question(`${label} [${currentValue}]: `)).trim();
    if (!response) {
      return currentValue;
    }
    const parsed = Number(response);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      writeLine("  Enter a whole number.");
      continue;
    }
    if (options.min != null && parsed < options.min) {
      writeLine(`  Enter a value >= ${options.min}.`);
      continue;
    }
    return parsed;
  }
}

function printSummary(config) {
  writeLine(`Default location: ${config.defaultLocation.postcode ?? "none"} ${config.defaultLocation.suburb ?? ""}`.trim());
  writeLine(`Headless browser: ${yesNo(config.browser.headless)}`);
  writeLine(`Live scraping: ${yesNo(config.cache.liveScrapeEnabled)}`);
  writeLine(`Historical SQLite fallback: ${yesNo(config.cache.useHistoricalFallbackOnFailure)}`);
  writeLine(
    `Backoff: ${config.resilience.maxAttempts} attempts, ${config.resilience.baseBackoffMs}-${config.resilience.maxBackoffMs}ms, cooldown ${config.resilience.cooldownMs}ms`
  );
  writeLine(`Per-retailer concurrency: ${config.resilience.maxConcurrentRetailerTasks}`);
  for (const retailer of ["coles", "woolworths", "aldi"]) {
    const retailerConfig = config.retailers[retailer];
    writeLine(
      `${retailerLabel(retailer)}: enabled ${yesNo(retailerConfig.enabled)}, live ${yesNo(retailerConfig.liveScrape)}, max ${retailerConfig.maxResults}`
    );
  }
}

function retailerLabel(retailer) {
  if (retailer === "aldi") {
    return "ALDI";
  }
  return retailer.charAt(0).toUpperCase() + retailer.slice(1);
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function printHelp() {
  printHeader("Price Patrol CLI");
  writeLine("Commands:");
  writeLine("  price-patrol setup        Run the interactive setup wizard");
  writeLine("  price-patrol config show  Print the effective config");
}

function printHeader(title) {
  writeLine(title);
  writeLine("=".repeat(title.length));
}

function printSection(title) {
  writeLine("");
  writeLine(title);
  writeLine("-".repeat(title.length));
}

function writeLine(message) {
  output.write(`${message}\n`);
}
