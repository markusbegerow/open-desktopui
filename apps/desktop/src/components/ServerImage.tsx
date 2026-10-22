import { useEffect, useState } from "react";
import { imageDataUrl } from "../lib/imageData";
import { fetchProfileImage } from "../lib/openWebUiClient";
import { getOpenWebUiConfig } from "../lib/settingsStore";

// An image in a reply. Pictures the model drew (or any link to the user's own
// server) need the account's token, so they are fetched through the backend
// and shown as data. Links to other sites are not loaded — that would tell the
// site who is reading — and show their description instead.
export default function ServerImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(src?.startsWith("data:image/") ? src : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src || src.startsWith("data:image/")) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await getOpenWebUiConfig();
        if (!config?.baseUrl) throw new Error("not signed in");
        const buffer = await fetchProfileImage(config.baseUrl, config.apiKey, src);
        const data = imageDataUrl(buffer);
        if (!data) throw new Error("not an image");
        if (!cancelled) setUrl(data);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (failed || !src) return <span className="image-unavailable">{alt || src}</span>;
  if (!url) return <span className="image-loading">…</span>;
  return <img className="chat-image" src={url} alt={alt ?? ""} />;
}
