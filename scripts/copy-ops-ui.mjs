import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/app", { recursive: true });
await cp("src/app/ui", "dist/app/ui", { recursive: true, force: true });
