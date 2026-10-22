// A model's reasoning, and how it travels.
//
// While streaming it arrives either as separate `reasoning` chunks or inline in
// the text between <think> … </think>. Open WebUI stores it inside the message
// text as a <details type="reasoning"> block. Here it is kept apart from the
// answer: `content` is the answer only, `reasoning` the thinking.

export interface SplitText {
  content: string;
  reasoning: string;
  // true while a <think> is open (the thinking is still going on)
  open: boolean;
  // seconds Open WebUI recorded in a <details … duration="N"> block
  seconds?: number;
}

const THINK_PAIRS: Array<[string, string]> = [
  ["<think>", "</think>"],
  ["<thinking>", "</thinking>"],
  ["<reasoning>", "</reasoning>"],
  ["<|begin_of_thought|>", "<|end_of_thought|>"],
];

const DETAILS = /<details\s+type="reasoning"([^>]*)>([\s\S]*?)<\/details>\s*/g;

// Takes the thinking out of a text: inline tags (also an unterminated one while
// it streams) and Open WebUI's <details type="reasoning"> blocks.
export function splitThinking(text: string): SplitText {
  let content = text;
  const parts: string[] = [];
  let seconds: number | undefined;

  content = content.replace(DETAILS, (_all, attrs: string, inner: string) => {
    const duration = /duration="(\d+)"/.exec(attrs);
    if (duration) seconds = Math.max(seconds ?? 0, Number(duration[1]));
    parts.push(
      inner
        .replace(/<summary>[\s\S]*?<\/summary>/g, "")
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim(),
    );
    return "";
  });

  let open = false;
  for (const [start, end] of THINK_PAIRS) {
    for (;;) {
      const from = content.indexOf(start);
      if (from === -1) break;
      const to = content.indexOf(end, from + start.length);
      if (to === -1) {
        parts.push(content.slice(from + start.length).trim());
        content = content.slice(0, from);
        open = true;
        break;
      }
      parts.push(content.slice(from + start.length, to).trim());
      content = content.slice(0, from) + content.slice(to + end.length);
    }
  }

  return {
    content: content.replace(/^\s+/, ""),
    reasoning: parts.filter(Boolean).join("\n\n"),
    open,
    seconds,
  };
}

// The text as Open WebUI stores it: the thinking as a <details> block in front
// of the answer, so the web interface shows it as a collapsible "Thought for N
// seconds". Without thinking the answer is returned as it is.
export function joinForServer(content: string, reasoning: string | null | undefined, seconds?: number | null): string {
  const thinking = reasoning?.trim();
  if (!thinking) return content;
  const duration = Math.max(0, Math.round(seconds ?? 0));
  const quoted = thinking
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return (
    `<details type="reasoning" done="true" duration="${duration}">\n` +
    `<summary>Thought for ${duration} seconds</summary>\n${quoted}\n</details>\n${content}`
  );
}
