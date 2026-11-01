function parseTraceValue(value) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function reconstructLlmInput(traces, selectedEntry) {
  const selectedIndex = traces.findIndex((entry) => entry.id === selectedEntry.id);
  const selectedInput = parseTraceValue(selectedEntry.input);
  if (selectedIndex < 0 || selectedInput?.contextMode !== "delta") {
    return selectedEntry.input ?? selectedEntry.rawContent;
  }

  let systemPrompt = "";
  let messages = [];
  for (const entry of traces.slice(0, selectedIndex + 1)) {
    if (entry.kind !== "llm") continue;
    const input = parseTraceValue(entry.input);
    if (!input) continue;
    if (input.contextMode !== "delta") {
      if (Array.isArray(input.messages)) messages = input.messages;
      if (typeof input.systemPrompt === "string") systemPrompt = input.systemPrompt;
      continue;
    }
    if (input.contextReset) messages = [];
    if (typeof input.systemPrompt === "string") systemPrompt = input.systemPrompt;
    if (Array.isArray(input.messages)) messages.push(...input.messages);
  }
  return JSON.stringify({ systemPrompt, messages }, null, 2);
}