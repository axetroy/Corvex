export interface CorvexCommand {
  name: "review" | "explain" | "fix" | "status" | "cancel" | "chat";
  args: string[];
  rawArgs: string;
}

export class NotCorvexCommandError extends Error {
  constructor() {
    super("not a Corvex command");
    this.name = "NotCorvexCommandError";
  }
}

function rawAfterTokens(note: string, tokenCount: number): string {
  let cursor = 0;
  for (let token = 0; token < tokenCount; token++) {
    while (cursor < note.length && /\s/u.test(note[cursor]!)) cursor++;
    while (cursor < note.length && !/\s/u.test(note[cursor]!)) cursor++;
  }
  let body = note.slice(cursor).replace(/^[\t ]+/, "");
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (/^\s/u.test(body)) body = body.slice(1);
  return body.trim() ? body : "";
}

export function parseCommand(note: string, botUsername = "corvex"): CorvexCommand {
  const fields = note.trim().split(/\s+/).filter(Boolean);
  const username = botUsername.trim().replace(/^@/, "") || "corvex";
  if (fields.length === 0 || fields[0]!.toLowerCase() !== `@${username}`.toLowerCase()) {
    throw new NotCorvexCommandError();
  }
  if (fields.length < 2) {
    throw new Error("missing command; use /review, /explain, /fix, /status, or /cancel");
  }
  if (!fields[1]!.startsWith("/")) {
    return {
      name: "chat",
      args: fields.slice(1),
      rawArgs: rawAfterTokens(note, 1),
    };
  }
  const name = fields[1]!.slice(1).toLowerCase();
  if (!name) {
    throw new Error("missing command; use /review, /explain, /fix, /status, or /cancel");
  }
  if (!["review", "explain", "fix", "status", "cancel"].includes(name)) {
    throw new Error(
      `unknown command "${fields[1]}"; supported commands are /review, /explain, /fix, /status, and /cancel`,
    );
  }
  const rawArgs = rawAfterTokens(note, 2);
  return { name: name as CorvexCommand["name"], args: fields.slice(2), rawArgs };
}
