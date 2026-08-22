export function inlineParts(input, allowStrong = true) {
  const text = String(input || "");
  const pattern = allowStrong
    ? /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\))/g
    : /(`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\))/g;
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) parts.push({ type: "text", text: text.slice(offset, match.index) });
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push({ type: "strong", children: inlineParts(token.slice(2, -2), false) });
    } else if (token.startsWith("`")) {
      parts.push({ type: "code", text: token.slice(1, -1) });
    } else {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      parts.push({ type: /^https?:\/\//i.test(href) ? "link" : "reference", text: label, href });
    }
    offset = match.index + token.length;
  }
  if (offset < text.length) parts.push({ type: "text", text: text.slice(offset) });
  return parts;
}

export function messageBlocks(input) {
  const blocks = [];
  let paragraph = [];
  let list = [];
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", parts: inlineParts(paragraph.join("\n")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ type: "list", items: list.map((item) => inlineParts(item)) });
    list = [];
  };

  for (const line of String(input || "").split("\n")) {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code === null) code = [];
      else {
        blocks.push({ type: "code", text: code.join("\n") });
        code = null;
      }
    } else if (code !== null) {
      code.push(line);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (/^#{1,3}\s+/.test(line)) {
      flushParagraph();
      flushList();
      const [, marks, title] = line.match(/^(#{1,3})\s+(.+)$/);
      blocks.push({ type: "heading", level: marks.length, parts: inlineParts(title) });
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  if (code !== null) blocks.push({ type: "code", text: code.join("\n") });
  return blocks;
}
