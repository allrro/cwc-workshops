// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import SubscriptionDesk from "@/components/SubscriptionDesk";
import { POST } from "@/app/api/desk/astra/route";

vi.mock("node:child_process", () => {
  const execFile = vi.fn((_bin: string, _args: string[], _options: unknown,
    done: (error: null, stdout: string, stderr: string) => void) => ({
    stdin: {
      on() {},
      end() { done(null, "Test answer", ""); },
    },
  }));
  return { execFile, default: { execFile } };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("runs Astra at medium, high, then medium as the same desk enters and exits manual review", async () => {
  vi.stubEnv("DESK_CHATGPT", "1");
  vi.stubEnv("CODEX_BIN", "/nonexistent/test-only-codex");
  // Dispatch the component's real request to the real route, entirely in process.
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("/api/desk/astra");
    const headers = new Headers(init.headers);
    headers.set("host", "127.0.0.1:3100");
    return POST(new Request(new URL(url, "http://127.0.0.1:3100"), { ...init, headers }));
  });

  render(<SubscriptionDesk />);
  const review = screen.getByRole<HTMLInputElement>("checkbox", { name: /manual review/i });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Compare the two filings." } });

  async function submit(expected: "medium" | "high", callCount: number) {
    expect(review.checked).toBe(expected === "high");
    expect(screen.getByRole("heading").textContent).toMatch(new RegExp(expected, "i"));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByText("Test answer");
    expect(execFile).toHaveBeenCalledTimes(callCount);
    const [bin, args] = vi.mocked(execFile).mock.calls[callCount - 1];
    expect(bin).toBe("/nonexistent/test-only-codex");
    if (!Array.isArray(args)) throw new Error("Expected Codex CLI arguments");
    expect(args[0]).toBe("exec");
    const settings = args.filter((_, index) => args[index - 1] === "-c");
    expect(settings.filter(setting => setting.startsWith("model_reasoning_effort=")))
      .toEqual([`model_reasoning_effort="${expected}"`]);
    expect(settings).toContain('forced_login_method="chatgpt"');
    expect(args.filter((_, index) => args[index - 1] === "-m")).toEqual(["gpt-6-astra"]);
  }

  await submit("medium", 1);
  fireEvent.click(review);
  await submit("high", 2);
  fireEvent.click(review);
  await submit("medium", 3);
});
