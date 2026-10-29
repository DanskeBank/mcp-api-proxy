import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

/** A GET to a path the proxy does not serve, so an allowed request ends in 404 and never reaches a session. */
function get(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/not-served", method: "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Sends the text as is. HTTP/1.0 closes the connection after the response, which ends the read. */
function rawRequest(port: number, text: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (response += chunk));
    socket.on("end", () => {
      const [head, ...body] = response.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), body: body.join("\r\n\r\n") });
    });
    socket.on("error", reject);
    socket.write(text);
  });
}

describe("CLI HTTP listener on loopback", () => {
  let home: string;
  let port: number;
  let child: ChildProcess;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-http-host-"));
    port = await freePort();
    child = spawn(process.execPath, [TSX_CLI, ENTRY, "--transport", "http", "--port", String(port)], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("The proxy did not start.")), 20_000);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes("MCP proxy running on http://")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`The proxy exited early with code ${code}.`));
      });
    });
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    fs.rmSync(home, { recursive: true, force: true });
  }, 15_000);

  it.each(["127.0.0.1", "localhost", "[::1]"])(
    "serves requests addressed to the loopback name %s, with or without an Origin",
    async (name) => {
      const host = `${name}:${port}`;

      expect((await get(port, { Host: host })).status).toBe(404);
      expect((await get(port, { Host: host, Origin: `http://${host}` })).status).toBe(404);
    },
  );

  it.each(["evil.example", "localhost.evil.example", "127.0.0.1.evil.example"])(
    "rejects a rebound request addressed to %s, even without an Origin",
    async (name) => {
      const run = await get(port, { Host: `${name}:${port}` });

      expect(run.status).toBe(403);
      expect(run.body).toContain("Forbidden host");
    },
  );

  it("still rejects a foreign Origin on a loopback Host", async () => {
    const run = await get(port, { Host: `127.0.0.1:${port}`, Origin: "http://evil.example" });

    expect(run.status).toBe(403);
    expect(run.body).toContain("Forbidden origin");
  });

  it("rejects an HTTP/1.0 request without a Host header", async () => {
    // Node answers HTTP/1.1 requests without Host with 400 itself; HTTP/1.0 ones reach the proxy.
    const run = await rawRequest(port, "GET /not-served HTTP/1.0\r\n\r\n");

    expect(run.status).toBe(403);
    expect(run.body).toContain("Forbidden host");
  });
});
