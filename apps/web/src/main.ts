import "@fontsource-variable/commissioner";
import "@fontsource-variable/commissioner/slnt.css";
import "@fontsource/zilla-slab/latin-400.css";
import "@fontsource/zilla-slab/latin-500.css";
import "@fontsource/zilla-slab/latin-500-italic.css";
import "@fontsource/zilla-slab/latin-600.css";
import "@fontsource/zilla-slab/latin-700.css";
import Aurelia, { Registration } from "aurelia";
import { RouterConfiguration } from "@aurelia/router";
import { SVGAnalyzer } from "@aurelia/runtime-html";
import { PricePatrolApp } from "./app";
import * as GlobalComponents from "./components";
import { ApiClient } from "./services/api-client";
import "./styles/app.css";

await Aurelia
  .register(
    SVGAnalyzer,
    GlobalComponents,
    Registration.singleton(ApiClient, ApiClient),
    RouterConfiguration.customize({ useUrlFragmentHash: false, useHref: false })
  )
  .app(PricePatrolApp)
  .start();
