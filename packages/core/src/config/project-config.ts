import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { RetailerId } from "../types/domain.js";

const retailerSchema = z.object({
  enabled: z.boolean().default(true),
  liveScrape: z.boolean().default(true),
  maxResults: z.number().int().positive().default(24)
});

const browserSchema = z.object({
  headless: z.boolean().default(true),
  navigationTimeoutMs: z.number().int().positive().default(60_000),
  protocolTimeoutMs: z.number().int().positive().default(120_000),
  stabilityDelayMs: z.number().int().nonnegative().default(1_500),
  minHumanDelayMs: z.number().int().nonnegative().default(150),
  maxHumanDelayMs: z.number().int().nonnegative().default(600),
  viewportWidth: z.number().int().positive().default(1440),
  viewportHeight: z.number().int().positive().default(900),
  locale: z.string().default("en-AU"),
  timezone: z.string().default("Australia/Brisbane"),
  acceptLanguage: z.string().default("en-AU,en;q=0.9"),
  userAgent: z
    .string()
    .default("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"),
  platform: z.string().default("MacIntel"),
  blockResourceTypes: z.array(z.string()).default(["media", "font"]),
  launchArgs: z.array(z.string()).default(["--no-sandbox", "--disable-setuid-sandbox"]),
  userDataDir: z.string().default(".price-patrol-data/browser"),
  maskAutomation: z.boolean().default(true),
  reuseSessions: z.boolean().default(true)
});

const cacheSchema = z.preprocess(
  (value) => {
    const input = typeof value === "object" && value ? (value as Record<string, unknown>) : {};
    return {
      ...input,
      useHistoricalFallbackOnFailure: input.useHistoricalFallbackOnFailure ?? input.useFixturesOnFailure ?? true
    };
  },
  z.object({
    ttlMs: z.number().int().positive().default(15 * 60 * 1000),
    liveScrapeEnabled: z.boolean().default(true),
    useHistoricalFallbackOnFailure: z.boolean().default(true)
  })
);

const resilienceSchema = z.object({
  maxAttempts: z.number().int().positive().default(3),
  baseBackoffMs: z.number().int().positive().default(1_500),
  maxBackoffMs: z.number().int().positive().default(20_000),
  cooldownMs: z.number().int().positive().default(60_000),
  jitterMs: z.number().int().nonnegative().default(350),
  maxConcurrentRetailerTasks: z.number().int().positive().default(1),
  attemptTimeoutMs: z.number().int().positive().default(120_000),
  circuitBreakerFailureThreshold: z.number().int().positive().default(3),
  circuitBreakerOpenMs: z.number().int().positive().default(5 * 60 * 1000)
});

const defaultLocationSchema = z.object({
  postcode: z.string().optional(),
  suburb: z.string().optional()
});

const retailersSchema = z.object({
  coles: z.preprocess((value) => value ?? {}, retailerSchema),
  woolworths: z.preprocess((value) => value ?? {}, retailerSchema),
  aldi: z.preprocess((value) => value ?? {}, retailerSchema)
});

const configSchema = z.object({
  browser: z.preprocess((value) => value ?? {}, browserSchema),
  cache: cacheSchema,
  resilience: z.preprocess((value) => value ?? {}, resilienceSchema),
  defaultLocation: z.preprocess((value) => value ?? {}, defaultLocationSchema),
  retailers: z.preprocess((value) => value ?? {}, retailersSchema)
});

export type ProjectConfig = z.infer<typeof configSchema>;

let cachedConfig: ProjectConfig | undefined;
let cachedPath: string | undefined;

export async function getProjectConfig(): Promise<ProjectConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = await findConfigPath();
  cachedPath = configPath;
  if (!configPath) {
    cachedConfig = parseProjectConfig({});
    return cachedConfig;
  }

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = parse(raw);
  cachedConfig = parseProjectConfig(parsed);
  return cachedConfig;
}

export function getCachedConfigPath(): string | undefined {
  return cachedPath;
}

export function parseProjectConfig(input: unknown): ProjectConfig {
  return configSchema.parse(input);
}

export function getDefaultProjectConfig(): ProjectConfig {
  return parseProjectConfig({});
}

export async function getRetailerConfig(retailer: RetailerId) {
  const config = await getProjectConfig();
  return config.retailers[retailer];
}

export async function saveProjectConfig(config: ProjectConfig, targetPath?: string): Promise<string> {
  const resolvedPath = targetPath ? resolve(targetPath) : (await findConfigPath()) ?? join(process.cwd(), "price-patrol.toml");
  const normalized = parseProjectConfig(config);
  const toml = stringify(normalized);
  await fs.writeFile(resolvedPath, `${toml}\n`, "utf8");
  cachedConfig = normalized;
  cachedPath = resolvedPath;
  return resolvedPath;
}

export function resolveProjectPath(projectPath: string): string {
  if (projectPath.startsWith("/")) {
    return projectPath;
  }

  const root = cachedPath ? dirname(cachedPath) : process.cwd();
  return resolve(root, projectPath);
}

async function findConfigPath(): Promise<string | undefined> {
  let current = resolve(process.cwd());
  while (true) {
    const candidate = join(current, "price-patrol.toml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function findProjectConfigPath(): Promise<string | undefined> {
  return findConfigPath();
}
