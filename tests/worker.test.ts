import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";

describe("bootstrap worker", () => {
  it("returns safe bootstrap health metadata on GET /health", async () => {
    const response = handleRequest(new Request("https://example.workers.dev/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "ega-plugin",
      spec: "SPEC-001 Revision 6",
      phase: "bootstrap",
    });
  });

  it("returns 404 with no-store for unknown paths", async () => {
    const response = handleRequest(new Request("https://example.workers.dev/mcp"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("returns 404 for non-GET requests to /health", () => {
    const response = handleRequest(
      new Request("https://example.workers.dev/health", { method: "POST" })
    );

    expect(response.status).toBe(404);
  });
});
