function shorten(text, limit = 220) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function structuredEventView(event) {
  const text = String(event.text || "");
  if (event.type === "status") return { text: "", detail: "", detailLabel: "", compact: false };
  if (event.type === "diff") {
    return { text: "Working diff updated", detail: text, detailLabel: "Working diff", compact: true };
  }
  if (event.type === "tool" && event.title === "Command") {
    const command = text.split("\n", 1)[0];
    const preview = shorten(command || "Shell command");
    return {
      text: preview,
      detail: text,
      detailLabel: "Command",
      compact: true,
    };
  }
  return { text, detail: "", detailLabel: "", compact: false };
}
