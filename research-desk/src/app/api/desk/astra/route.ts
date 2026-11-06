import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { rejectCrossSite } from "@/app/api/api-route";
import { loadWatchlist } from "@/lib/config";

export const dynamic = "force-dynamic";
let busy = false;

export async function POST(request: Request) {
  if (process.env.DESK_CHATGPT !== "1") return new Response(null, { status: 404 });
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.get("host") ?? "")) {
    return new Response(null, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const question = typeof body?.text === "string" ? body.text.trim() : "";
  if (!question || question.length > 8000) return new Response("Use 1–8000 characters.", { status: 400 });
  const effort = body.effort === undefined ? "medium" : body.effort;
  if (effort !== "medium" && effort !== "high") return new Response("Use medium or high.", { status: 400 });
  if (busy) return new Response("A model request is already running.", { status: 429 });
  busy = true;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "research-desk-"));
    const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
      "-s", "read-only", "--disable", "plugins", "--disable", "shell_tool", "--disable", "unified_exec",
      "-c", 'web_search="disabled"', "-c", 'forced_login_method="chatgpt"',
      "-m", "gpt-6-astra", "-c", `model_reasoning_effort="${effort}"`, "-"];
    const prompt = ["Answer the question using the supplied data. Do not use tools. Identify missing evidence.",
      "Desk watchlist: " + loadWatchlist().join(", "), question].join("\n");
    const answer = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.env.CODEX_BIN || "codex", args, {
        cwd: dir, timeout: 120000, killSignal: "SIGKILL", maxBuffer: 2 ** 20,
        env: { ...process.env, OPENAI_API_KEY: "", CODEX_API_KEY: "" },
      }, (err, stdout, stderr) => {
        if (err || !stdout.trim()) return reject(new Error("Codex invocation failed"));
        const header = stderr.split(/^user$/m, 1)[0];
        const actualModel = /^model: ([\w.-]+)$/m.exec(header)?.[1];
        const actualEffort = /^reasoning effort: ([\w-]+)$/m.exec(header)?.[1];
        if (actualModel && actualEffort) {
          console.info("[desk/astra] Codex CLI model=%s reasoning_effort=%s", actualModel, actualEffort);
          if (actualModel !== "gpt-6-astra" || actualEffort !== effort) {
            return reject(new Error("Codex ran with unexpected settings"));
          }
        }
        resolve(stdout.trim());
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    });
    return Response.json({ answer, model: "gpt-6-astra", effort });
  } catch {
    return new Response("ChatGPT request failed. Check codex login status and subscription limits.", { status: 502 });
  } finally {
    busy = false;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
