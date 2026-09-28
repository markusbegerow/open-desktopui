import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { version } from "../../package.json";

type UpdateStatus = "idle" | "checking" | "upToDate" | "available" | "downloading" | "error";

const REPO_URL = "https://github.com/markusbegerow/open-desktopui";
const ISSUES_URL = `${REPO_URL}/issues`;
const LINKEDIN_SHARE_URL = `https://www.linkedin.com/sharing/share-offsite/?url=${REPO_URL}`;
const COFFEE_URL = "https://paypal.me/MarkusBegerow?country.x=DE&locale.x=de_DE";
const WEBSITE_URL = "https://www.markus-begerow.de";
const LINKEDIN_URL = "https://linkedin.com/in/markusbegerow";
const GITHUB_URL = "https://github.com/markusbegerow";
const TWITTER_URL = "https://x.com/markusbegerow";

function LinkButton({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <button type="button" className="link-button" onClick={() => openUrl(url)}>
      {children}
    </button>
  );
}

export default function AboutTab() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  async function handleCheckForUpdates() {
    setUpdateStatus("checking");
    setUpdateError(null);
    try {
      const update = await check();
      if (update) {
        setPendingUpdate(update);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("upToDate");
      }
    } catch (err) {
      setUpdateStatus("error");
      const message = err instanceof Error ? err.message : String(err);
      setUpdateError(
        message.includes("Could not fetch a valid release JSON")
          ? "No update available yet — this app hasn't published a release."
          : message,
      );
    }
  }

  async function handleInstallUpdate() {
    if (!pendingUpdate) return;
    setUpdateStatus("downloading");
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch (err) {
      setUpdateStatus("error");
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <fieldset>
        <legend>About the app</legend>
        <h3 className="about-app-name">Open DesktopUI <span className="hint">v{version}</span></h3>
        <p>
          Your native desktop companion for self-hosted Open WebUI - developed by Markus Begerow, with integrated Knowledge Base sync powered by oikb.
        </p>
        <div className="row">
          <button
            type="button"
            onClick={updateStatus === "available" ? handleInstallUpdate : handleCheckForUpdates}
            disabled={updateStatus === "checking" || updateStatus === "downloading"}
          >
            {updateStatus === "checking" && "Checking..."}
            {updateStatus === "downloading" && "Downloading..."}
            {updateStatus === "available" &&
              `Install update (v${pendingUpdate?.version}) and restart`}
            {(updateStatus === "idle" || updateStatus === "upToDate" || updateStatus === "error") &&
              "Check for updates"}
          </button>
          {updateStatus === "upToDate" && <span className="status-ok">You're up to date</span>}
        </div>
        {updateStatus === "error" && <p className="status-error">{updateError}</p>}
      </fieldset>

      <fieldset>
        <legend>Get Involved</legend>
        <p className="hint">If you encounter any issues or have questions:</p>
        <div className="row">
          <LinkButton url={ISSUES_URL}>🐛 Report bugs</LinkButton>
          <LinkButton url={ISSUES_URL}>💡 Request features</LinkButton>
          <LinkButton url={REPO_URL}>⭐ Star the repo</LinkButton>
        </div>
      </fieldset>

      <fieldset>
        <legend>Support the Project</legend>
        <p className="hint">If you like this project, support further development with a repost or coffee:</p>
        <div className="row">
          <LinkButton url={LINKEDIN_SHARE_URL}>💼 Share on LinkedIn</LinkButton>
          <LinkButton url={COFFEE_URL}>☕ Buy me a coffee</LinkButton>
        </div>
      </fieldset>

      <fieldset>
        <legend>Contact</legend>
        <div className="row">
          <LinkButton url={WEBSITE_URL}>🌐 Website</LinkButton>
          <LinkButton url={LINKEDIN_URL}>🧑‍💻 LinkedIn</LinkButton>
          <LinkButton url={GITHUB_URL}>💾 GitHub</LinkButton>
          <LinkButton url={TWITTER_URL}>✉️ Twitter</LinkButton>
        </div>
      </fieldset>
    </div>
  );
}
