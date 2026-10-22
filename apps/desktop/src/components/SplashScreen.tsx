import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

// Deliberately always light (not the theme-aware color-mix(canvas...) tokens
// the rest of the app uses) — the logo PNG has an opaque white background,
// not a transparent one, so it only looks right on a light panel regardless
// of which theme the user has chosen (or hasn't chosen yet, on a first run).
export default function SplashScreen() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="splash-screen">
      <img src="/logo.png" alt="Open DesktopUI" className="splash-logo" />
      <span className="splash-credit">Developed by Markus Begerow</span>
      {version && <span className="splash-version">v{version}</span>}
    </div>
  );
}
