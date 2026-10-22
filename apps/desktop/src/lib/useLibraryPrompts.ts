import { useEffect, useState } from "react";
import { LibraryPrompt, listLibraryPrompts } from "./library";
import { LIBRARY_UPDATED_EVENT } from "./librarySync";

// The prompts of the local copy, reloaded whenever a sync changed them.
export function useLibraryPrompts(): LibraryPrompt[] {
  const [prompts, setPrompts] = useState<LibraryPrompt[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      listLibraryPrompts()
        .then((list) => !cancelled && setPrompts(list))
        .catch(() => undefined);
    load();
    window.addEventListener(LIBRARY_UPDATED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(LIBRARY_UPDATED_EVENT, load);
    };
  }, []);
  return prompts;
}
