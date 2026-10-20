import { cropToSquareDataUrl, isDefaultProfileImage } from "./avatar";
import { CurrentUser, fetchProfileImage } from "./openWebUiClient";
import { setAppPrefs } from "./settingsStore";

// Mirrors the account's Open WebUI profile image into local prefs as a small
// square data URL. Best-effort: a failed download keeps the previously synced
// image, while an account without a picture clears it. Never throws.
// Returns true when the stored image changed.
export async function syncServerAvatar(
  baseUrl: string,
  token: string,
  user: Pick<CurrentUser, "profileImageUrl">,
): Promise<boolean> {
  try {
    const imageUrl = user.profileImageUrl;
    if (isDefaultProfileImage(imageUrl)) {
      await setAppPrefs({ serverAvatar: undefined });
      return true;
    }
    const bytes =
      imageUrl!.startsWith("data:")
        ? new Uint8Array(await (await fetch(imageUrl!)).arrayBuffer())
        : new Uint8Array(await fetchProfileImage(baseUrl, token, imageUrl!));
    await setAppPrefs({ serverAvatar: await cropToSquareDataUrl(bytes) });
    return true;
  } catch {
    return false;
  }
}
