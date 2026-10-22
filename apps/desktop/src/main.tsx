import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickChat from "./components/QuickChat";
import ErrorBoundary from "./components/ErrorBoundary";

// The global shortcut opens this same bundle in a small window (`?quick=1`).
const quick = new URLSearchParams(window.location.search).get("quick") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>{quick ? <QuickChat /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
