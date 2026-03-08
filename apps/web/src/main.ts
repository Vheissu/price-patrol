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
