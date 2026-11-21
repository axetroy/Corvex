import "./csp.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "antd/dist/reset.css";
import { App } from "./App.js";
import "./theme.css";
import "./styles.css";

/** 挂载 Agent 控制台根组件；缺少挂载节点说明页面模板被破坏。 */
const container = document.querySelector<HTMLDivElement>("#root");
if (!container) throw new Error("agent console root element is missing");
createRoot(container).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
