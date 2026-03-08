import { describe, expect, it } from "vitest";
import { extractAldiSearchResults } from "../adapters/aldi-adapter.js";
import { extractColesResults } from "../adapters/coles-adapter.js";
import { extractWoolworthsResults } from "../adapters/woolworths-adapter.js";

describe("retailer adapter parsers", () => {
  it("extracts Coles product results from __NEXT_DATA__", () => {
    const results = extractColesResults({
      results: [
        { _type: "AD", id: "ad-1", name: "promo" },
        {
          _type: "PRODUCT",
          id: 5881232,
          name: "White Plain Flour",
          brand: "Coles",
          size: "1Kg",
          availability: true,
          pricing: {
            now: 1.3,
            was: 0,
            comparable: "$1.30/ 1kg",
            promotionType: "EVERYDAY"
          }
        }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(5881232);
    expect(results[0]?.pricing?.now).toBe(1.3);
  });

  it("extracts Woolworths products from the current products array", () => {
    const results = extractWoolworthsResults({
      products: [
        {
          Stockcode: 33282,
          DisplayName: "Essentials Plain Flour 1kg",
          Brand: "Essentials",
          Price: 1.3,
          CupString: "$1.30 / 1KG"
        }
      ],
      items: [
        {
          type: "Product",
          model: {
            Stockcode: 33282,
            DisplayName: "Essentials Plain Flour 1kg",
            Price: 1.3
          }
        }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.Stockcode).toBe(33282);
    expect(results[0]?.DisplayName).toContain("Plain Flour");
  });

  it("falls back to legacy Woolworths grouped results", () => {
    const results = extractWoolworthsResults({
      results: {
        Products: [
          {
            Products: [
              {
                Stockcode: 1001,
                DisplayName: "Legacy Product",
                Price: 2.5
              }
            ]
          }
        ]
      }
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.Stockcode).toBe(1001);
  });

  it("extracts ALDI product-search payloads", () => {
    const results = extractAldiSearchResults({
      meta: {
        pagination: {
          totalCount: 1
        }
      },
      data: [
        {
          sku: "000000000000400054",
          name: "Plain Flour 1kg",
          brandName: "WHITE MILL",
          urlSlugText: "white-mill-plain-flour-1kg",
          sellingSize: "1 kg",
          price: {
            amountRelevant: 125,
            comparisonDisplay: "$1.25 per 1 kg"
          }
        }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.sku).toBe("000000000000400054");
    expect(results[0]?.price?.amountRelevant).toBe(125);
  });
});
