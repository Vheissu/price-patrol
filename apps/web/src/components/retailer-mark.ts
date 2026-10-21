import { customElement } from "aurelia";
import template from "./retailer-mark.html?raw";
import { retailerLabel, retailerLogoUrl } from "../format";

@customElement({
  name: "retailer-mark",
  template,
  bindables: ["retailer"]
})
export class RetailerMark {
  retailer = "";

  get label(): string {
    return retailerLabel(this.retailer);
  }

  get logoUrl(): string {
    return retailerLogoUrl(this.retailer);
  }

  get hasLogo(): boolean {
    return ["coles", "woolworths", "aldi"].includes(this.retailer);
  }
}
