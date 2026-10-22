import { Children, ReactElement, ReactNode, isValidElement, lazy, Suspense } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { prepareMath } from "../lib/mathText";
import ServerImage from "./ServerImage";
import "katex/dist/katex.min.css";

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));

// The plain text inside a rendered node (code blocks arrive as highlighted spans).
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

export interface MarkdownBodyProps {
  text: string;
  // The reply is still being written: a diagram would be re-drawn on every
  // chunk (and fail while incomplete), so it stays code until the reply ends.
  streaming?: boolean;
}

// A chat message as markdown: tables and task lists, highlighted code, formulas
// ($$ … $$, \( … \), \[ … \]) and Mermaid diagrams.
export default function MarkdownBody({ text, streaming }: MarkdownBodyProps) {
  return (
    <ReactMarkdown
      // A single $ is left alone, so prices like "$5 and $10" stay text.
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[
        [rehypeKatex, { throwOnError: false, strict: "ignore" }],
        [rehypeHighlight, { ignoreMissing: true }],
      ]}
      components={{
        img: ({ src, alt }) => <ServerImage src={typeof src === "string" ? src : undefined} alt={alt} />,
        pre({ children, ...rest }) {
          const code = Children.toArray(children)[0];
          const className = isValidElement(code) ? (code.props as { className?: string }).className : undefined;
          if (!streaming && className?.split(" ").includes("language-mermaid")) {
            return (
              <Suspense fallback={<div className="mermaid-diagram mermaid-loading">…</div>}>
                <MermaidDiagram code={textOf(code).replace(/\n$/, "")} />
              </Suspense>
            );
          }
          return <pre {...rest}>{children}</pre>;
        },
      }}
    >
      {prepareMath(text)}
    </ReactMarkdown>
  );
}
