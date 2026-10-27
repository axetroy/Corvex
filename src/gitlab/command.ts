export interface CorvexCommand {
  name: "review" | "explain" | "fix" | "status" | "cancel";
  args: string[];
}

export class NotCorvexCommandError extends Error {
  constructor() {
    super("not a Corvex command");
    this.name = "NotCorvexCommandError";
  }
}

export function parseCommand(note: string): CorvexCommand {
  const fields = note.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 0 || fields[0]!.toLowerCase() !== "@corvex") {
    throw new NotCorvexCommandError();
  }
  if (fields.length < 2) {
    throw new Error("missing command; use review, explain, fix, status, or cancel");
  }
  const name = fields[1]!.toLowerCase();
  if (!["review", "explain", "fix", "status", "cancel"].includes(name)) {
    throw new Error(
      `unknown command "${fields[1]}"; supported commands are review, explain, fix, status, and cancel`,
    );
  }
  return { name: name as CorvexCommand["name"], args: fields.slice(2) };
}
