import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeTelegram } from "./telegram";
import "./styles.css";

const launchContext = initializeTelegram();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App launchContext={launchContext} />
  </StrictMode>
);
