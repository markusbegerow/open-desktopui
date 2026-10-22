import { useEffect, useState } from "react";

// Whether the app currently shows a dark surface (the theme follows the system
// or a setting, so ask the browser what `canvas` resolves to).
function isDark(): boolean {
  const probe = document.createElement("div");
  probe.style.background = "canvas";
  document.body.appendChild(probe);
  const channels = getComputedStyle(probe).backgroundColor.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
  probe.remove();
  const [r, g, b] = channels;
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

// A ```mermaid block drawn as a diagram. The library is large, so it is only
// loaded when a reply actually contains one. Mermaid sanitizes the SVG it
// returns (securityLevel "strict"); a block it can't parse stays visible as code.
export default function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${crypto.randomUUID()}`;
    setSvg(null);
    setFailed(false);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default" });
        const rendered = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered.svg);
      } catch {
        // mermaid leaves a half-built element behind when it fails
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <pre className="mermaid-failed">
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) return <div className="mermaid-diagram mermaid-loading">…</div>;
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
