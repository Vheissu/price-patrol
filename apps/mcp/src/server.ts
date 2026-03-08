import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const apiBase = process.env.PRICE_PATROL_API_URL ?? "http://127.0.0.1:8787/api";

const server = new McpServer({
  name: "price-patrol-mcp",
  version: "0.1.0"
});

server.registerTool(
  "compare_item",
  {
    description: "Compare a single grocery item across Coles, Woolworths, and ALDI.",
    inputSchema: {
      query: z.string().describe("Item query, for example plain flour or full cream milk 2L"),
      comparisonMode: z.enum(["exact", "equivalent", "best-value"]).default("equivalent"),
      postcode: z.string().optional().describe("Optional Australian postcode"),
      suburb: z.string().optional().describe("Optional suburb"),
      allowLiveScrape: z.boolean().optional().default(true)
    }
  },
  async ({ query, comparisonMode, postcode, suburb, allowLiveScrape }) => {
    const result = await apiCall("/compare/item", {
      method: "POST",
      body: {
        query,
        comparisonMode,
        location: { postcode, suburb },
        allowLiveScrape
      }
    });

    const recommended = result.recommended;
    const summary = recommended
      ? `${recommended.product.retailer}: ${recommended.product.canonicalDisplayName} at $${recommended.product.effectiveComparisonPrice.toFixed(2)}`
      : "No recommendation available.";

    return {
      content: [
        {
          type: "text",
          text: `${summary}\nWarnings: ${(result.warnings ?? []).join(" | ") || "None"}`
        }
      ],
      structuredContent: result
    };
  }
);

server.registerTool(
  "compare_basket",
  {
    description: "Compare a full grocery basket using single-store and split-basket strategies.",
    inputSchema: {
      items: z.array(z.string()).min(1).describe("Shopping list item names"),
      comparisonMode: z.enum(["exact", "equivalent", "best-value"]).default("equivalent"),
      postcode: z.string().optional(),
      suburb: z.string().optional(),
      allowLiveScrape: z.boolean().optional().default(true)
    }
  },
  async ({ items, comparisonMode, postcode, suburb, allowLiveScrape }) => {
    const result = await apiCall("/compare/basket", {
      method: "POST",
      body: {
        comparisonMode,
        location: { postcode, suburb },
        allowLiveScrape,
        items: items.map((name) => ({ name, quantity: 1 }))
      }
    });

    const bestSingle = [...result.singleRetailerTotals]
      .filter((summary: { missingItems: string[] }) => summary.missingItems.length === 0)
      .sort((left: { total: number }, right: { total: number }) => left.total - right.total)[0];

    return {
      content: [
        {
          type: "text",
          text:
            `Split basket total: $${result.splitBasket.total.toFixed(2)}.` +
            (bestSingle ? ` Best full-store basket is ${bestSingle.retailer} at $${bestSingle.total.toFixed(2)}.` : " No full-store basket covered every item.")
        }
      ],
      structuredContent: result
    };
  }
);

server.registerTool(
  "explain_item_choice",
  {
    description: "Explain why a specific comparison result was chosen or ranked.",
    inputSchema: {
      query: z.string(),
      productId: z.string(),
      comparisonMode: z.enum(["exact", "equivalent", "best-value"]).default("equivalent"),
      postcode: z.string().optional(),
      suburb: z.string().optional(),
      allowLiveScrape: z.boolean().optional().default(true)
    }
  },
  async ({ query, productId, comparisonMode, postcode, suburb, allowLiveScrape }) => {
    const result = await apiCall("/explain/item", {
      method: "POST",
      body: {
        query,
        productId,
        comparisonMode,
        location: { postcode, suburb },
        allowLiveScrape
      }
    });

    return {
      content: [
        {
          type: "text",
          text: result.explanation.join(" ")
        }
      ],
      structuredContent: result
    };
  }
);

server.registerTool(
  "retailer_health",
  {
    description: "Show the current health of the retailer adapters."
  },
  async () => {
    const result = await apiCall("/adapters/health");
    return {
      content: [
        {
          type: "text",
          text: result.adapters
            .map((adapter: { retailer: string; status: string; browserMode: string }) => `${adapter.retailer}: ${adapter.status} (${adapter.browserMode})`)
            .join("\n")
        }
      ],
      structuredContent: result
    };
  }
);

async function apiCall(path: string, init?: { method?: string; body?: unknown }) {
  const response = await fetch(`${apiBase}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json"
    },
    body: init?.body ? JSON.stringify(init.body) : undefined
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`API request failed for ${path}: ${message}`);
  }

  return response.json();
}

const transport = new StdioServerTransport();
await server.connect(transport);
