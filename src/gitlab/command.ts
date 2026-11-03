export interface CorvexCommand {
  name: "review" | "explain" | "fix" | "status" | "cancel";
  args: string[];
  rawArgs: string;
}

export class NotCorvexCommandError extends Error {
  constructor() {
    super("not a Corvex command");
    this.name = "NotCorvexCommandError";
  }
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
    throw new Error("commands must start with /; use /review, /explain, /fix, /status, or /cancel");
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
  const commandMatch = /^\s*\S+\s+\S+/.exec(note);
  let rawArgs = commandMatch ? note.slice(commandMatch[0].length) : "";
  rawArgs = rawArgs.replace(/^[\t ]+/, "");
  if (rawArgs.startsWith("\r\n")) rawArgs = rawArgs.slice(2);
  else if (/^\s/u.test(rawArgs)) rawArgs = rawArgs.slice(1);
  if (!rawArgs.trim()) rawArgs = "";
  return { name: name as CorvexCommand["name"], args: fields.slice(2), rawArgs };
}
