import { customElement } from "aurelia";
import template from "./section-shell.html?raw";

@customElement({
  name: "section-shell",
  template,
  bindables: ["heading", "note", "meta"]
})
export class SectionShell {
  heading = "";
  note = "";
  meta = "";
}
