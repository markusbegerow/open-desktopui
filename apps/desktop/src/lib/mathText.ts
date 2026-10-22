// Prepares markdown for math rendering. Models write formulas as \( … \) and
// \[ … \] (what LaTeX and ChatGPT-style output use) or as $$ … $$; the renderer
// understands $$ … $$ only. A single $ is left alone on purpose, so "costs $5
// and $10" never turns into a formula.

// Text inside fenced code blocks and `inline code` must not be touched.
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/g;

export function prepareMath(text: string): string {
  return text
    .split(CODE)
    .map((part, i) => {
      if (i % 2 === 1) return part; // the captured code segments
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$$${body.trim()}$$`);
    })
    .join("");
}
