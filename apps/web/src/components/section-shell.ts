import { customElement } from "aurelia";
import template from "./section-shell.html?raw";

@customElement({
  name: "section-shell",
  template,
  bindables: ["heading", "subheading", "aside"]
})
export class SectionShell {
  heading = "";
  subheading = "";
  aside = "";
}
