import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentUser, login } from "../lib/openWebUiClient";
import { getOpenWebUiConfig, setAppPrefs, setOpenWebUiConfig } from "../lib/settingsStore";
import { isInsecureRemoteUrl } from "../lib/network";

type Step = "loading" | "server" | "credentials";

export default function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [step, setStep] = useState<Step>("loading");
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "signing-in" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [insecureWarningAcked, setInsecureWarningAcked] = useState(false);

  useEffect(() => {
    // Returning users (server already known, just signed out) skip straight
    // to credentials; only a genuine first run walks through the server-URL
    // step too.
    getOpenWebUiConfig().then((config) => {
      if (config?.baseUrl) {
        setBaseUrl(config.baseUrl);
        setStep("credentials");
      } else {
        setStep("server");
      }
    });
  }, []);

  function handleContinue(e: FormEvent) {
    e.preventDefault();
    if (!baseUrl.trim()) return;
    if (isInsecureRemoteUrl(baseUrl.trim()) && !insecureWarningAcked) {
      setInsecureWarningAcked(true);
      return;
    }
    setStep("credentials");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("signing-in");
    setError(null);
    try {
      const url = baseUrl.trim().replace(/\/+$/, "");
      const token = await login(url, email.trim(), password);

      // Fetch the account's id/name before saving, so the per-account scope
      // key (Addendum 9) and the display name (Addendum 7) can both be set
      // in the same pass — this is also what powers scoping local chat
      // history/dashboard stats per account, not just personalization.
      let accountId: string | undefined;
      try {
        const user = await getCurrentUser(url, token);
        if (user.id) accountId = `${url}|${user.id}`;
        if (user.name) await setAppPrefs({ displayName: user.name });
      } catch {
        // Non-fatal: falls back to the "unscoped" history bucket and the
        // manual Settings display-name field.
      }

      await setOpenWebUiConfig({ baseUrl: url, apiKey: token, accountId });

      // Also wire the local oikb sync daemon's own default connection
      // (~/.config/oikb/config.yaml) — previously only happened if the user
      // manually hit Save in Settings; now that those fields are read-only
      // once signed in (Addendum 6), sign-in itself is the one place left
      // that establishes the connection for both chat and KB sync.
      try {
        await invoke("set_oikb_global_config", { url, token });
      } catch {
        // Non-fatal: chat still works even if this fails; KB sync just
        // won't have a default connection until Settings/daemon are checked.
      }
      onSignedIn();
      // Force a full remount so App.tsx re-checks auth from a clean state —
      // more robust than relying on the callback alone, which can lag under
      // Vite's hot-reload while iterating on this screen.
      window.location.reload();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (step === "loading") {
    return <div className="login-view" />;
  }

  if (step === "server") {
    return (
      <div className="login-view">
        <form className="login-card" onSubmit={handleContinue}>
          <img src="/logo.png" alt="Open DesktopUI" className="login-logo" />
          <h1>Connect to Open WebUI</h1>
          <p className="hint">Enter your Open WebUI server URL to continue...</p>
          <label>
            Server URL
            <input
              type="text"
              placeholder="http://localhost:3000"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setInsecureWarningAcked(false);
              }}
              autoFocus
            />
          </label>
          {insecureWarningAcked && isInsecureRemoteUrl(baseUrl.trim()) && (
            <p className="status-error">
              This connection isn't encrypted (plain http to a non-local address) — anything you send,
              including your password, could be readable on the network. Only continue if you trust this
              network.
            </p>
          )}
          <button type="submit" disabled={!baseUrl.trim()}>
            {insecureWarningAcked && isInsecureRemoteUrl(baseUrl.trim()) ? "Continue anyway" : "Continue"}
          </button>
        </form>
        <span className="login-credit">Developed by Markus Begerow</span>
      </div>
    );
  }

  return (
    <div className="login-view">
      {status === "signing-in" && (
        <div className="signing-in-overlay">
          <div className="signing-in-message">
            <span className="thinking-indicator">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </span>
            Signing in…
          </div>
        </div>
      )}
      <form className="login-card" onSubmit={handleSubmit}>
        <img src="/logo.png" alt="Open DesktopUI" className="login-logo" />
        <h1>Sign in</h1>
        <p className="hint server-line">
          {baseUrl}{" "}
          <button type="button" className="link-button inline" onClick={() => setStep("server")}>
            Change
          </button>
        </p>

        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && <p className="status-error">{error}</p>}

        <button type="submit" disabled={status === "signing-in"}>
          {status === "signing-in" ? "Signing in..." : "Sign in"}
        </button>

        <p className="hint">
          Prefer an API key instead? You can paste one directly in Settings after skipping sign-in.
        </p>
        <button type="button" className="link-button" onClick={onSignedIn}>
          Skip for now
        </button>
      </form>
      <span className="login-credit">Developed by Markus Begerow</span>
    </div>
  );
}
