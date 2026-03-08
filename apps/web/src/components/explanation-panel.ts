import { customElement } from "aurelia";
import template from "./explanation-panel.html?raw";
import type { ItemExplanation } from "../services/api-client";

@customElement({
  name: "explanation-panel",
  template,
  bindables: ["explanation", "isLoading", "error"]
})
export class ExplanationPanel {
  explanation?: ItemExplanation;
  isLoading = false;
  error = "";
}
