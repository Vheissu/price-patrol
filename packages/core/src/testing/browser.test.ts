import { describe, expect, it, vi } from "vitest";
import { getDefaultProjectConfig } from "../config/project-config.js";
import { applyBrowserIdentity, applyBrowserIdentityOnce, buildBrowserContextOptions, buildLaunchArgs, resolveLaunchProfile } from "../adapters/shared/browser.js";

describe("browser identity", () => {
  it("builds the configured Playwright context options", () => {
    const config = getDefaultProjectConfig().browser;

    expect(buildBrowserContextOptions(config)).toEqual({
      locale: config.locale,
      timezoneId: config.timezone,
      userAgent: config.userAgent,
      viewport: {
        width: config.viewportWidth,
        height: config.viewportHeight
      }
    });
  });

  it("applies the configured browser headers and automation masking", async () => {
    const config = getDefaultProjectConfig().browser;
    const context = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined)
    };

    await applyBrowserIdentity(context, config);

    expect(context.setExtraHTTPHeaders).toHaveBeenCalledWith({
      "accept-language": config.acceptLanguage
    });
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(context.addInitScript).toHaveBeenCalledWith(expect.any(Function), {
      locale: config.locale,
      platform: config.platform
    });
  });

  it("skips automation masking when disabled", async () => {
    const config = {
      ...getDefaultProjectConfig().browser,
      maskAutomation: false
    };
    const context = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined)
    };

    await applyBrowserIdentity(context, config);

    expect(context.addInitScript).not.toHaveBeenCalled();
  });

  it("only applies browser identity once per context object", async () => {
    const config = getDefaultProjectConfig().browser;
    const context = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined)
    };

    await applyBrowserIdentityOnce(context, config);
    await applyBrowserIdentityOnce(context, config);

    expect(context.setExtraHTTPHeaders).toHaveBeenCalledTimes(1);
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
  });

  it("adds browser launch flags needed for locale and automation masking", () => {
    const config = getDefaultProjectConfig().browser;

    expect(buildLaunchArgs(config)).toEqual(
      expect.arrayContaining([
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--deny-permission-prompts",
        `--lang=${config.locale}`,
        `--window-size=${config.viewportWidth},${config.viewportHeight}`,
        "--disable-blink-features=AutomationControlled"
      ])
    );
  });

  it("uses headed Chrome for retailers that are currently challenge-sensitive", () => {
    const config = getDefaultProjectConfig().browser;

    expect(resolveLaunchProfile({ retailer: "coles" }, config)).toEqual({ headless: false, channel: "chrome" });
    expect(resolveLaunchProfile({ retailer: "woolworths" }, config)).toEqual({ headless: false, channel: "chrome" });
    expect(resolveLaunchProfile({ retailer: "aldi" }, config)).toEqual({ headless: config.headless });
  });
});
