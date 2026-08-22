export function composedInput(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return "";
  return text.includes("\n") ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`;
}
