import { useEffect, useState } from "react";
import { ServerFeatures, ServerTool, getServerFeatures, listTools } from "./openWebUiClient";

// What the server offers for a reply beyond the model: which optional features
// it has on and which tools exist. Both are best effort — a failure means
// "unknown" (everything stays offered) and "no tools", never an error message.
export function useServerOptions(baseUrl: string | null, token: string | undefined) {
  const [features, setFeatures] = useState<ServerFeatures | null>(null);
  const [tools, setTools] = useState<ServerTool[]>([]);

  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    getServerFeatures(baseUrl)
      .then((f) => !cancelled && setFeatures(f))
      .catch(() => undefined);
    if (token) {
      listTools(baseUrl, token)
        .then((t) => !cancelled && setTools(t))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token]);

  return { features, tools };
}
