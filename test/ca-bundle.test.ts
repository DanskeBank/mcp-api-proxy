import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const agentOptions = vi.hoisted(() => [] as Array<{ connect?: Record<string, unknown> }>);

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    Agent: class {
      constructor(options: { connect?: Record<string, unknown> }) {
        agentOptions.push(options);
      }
    },
  };
});

import { buildMtlsAgent } from "../src/auth/mtls.js";
import { readCaBundle } from "../src/ca-bundle.js";
import { buildFetchWithCa } from "../src/clients/fetch-with-ca.js";

const EXTRA_CA = "-----BEGIN CERTIFICATE-----\nextra-ca\n-----END CERTIFICATE-----\n";

// getCACertificates is missing before Node 22.15, which package.json still allows.
const defaultCas = (): string[] =>
  typeof tls.getCACertificates === "function"
    ? tls.getCACertificates("default")
    : [...tls.rootCertificates];

describe("CA bundle", () => {
  let dir: string;
  let caPath: string;

  beforeEach(() => {
    agentOptions.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ca-"));
    caPath = path.join(dir, "extra-ca.pem");
    fs.writeFileSync(caPath, EXTRA_CA);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("readCaBundle", () => {
    it("adds the file to Node's default CAs instead of replacing them", () => {
      const bundle = readCaBundle(caPath);

      expect(bundle.slice(0, -1)).toEqual(defaultCas());
      expect(bundle.at(-1)).toBe(EXTRA_CA);
    });

    it("falls back to the bundled root CAs where getCACertificates does not exist", () => {
      const original = tls.getCACertificates;
      (tls as { getCACertificates?: unknown }).getCACertificates = undefined;
      try {
        const bundle = readCaBundle(caPath);

        expect(bundle.slice(0, -1)).toEqual(tls.rootCertificates);
        expect(bundle.at(-1)).toBe(EXTRA_CA);
      } finally {
        tls.getCACertificates = original;
      }
    });

    it("fails when the file cannot be read, rather than trusting the defaults only", () => {
      expect(() => readCaBundle(path.join(dir, "missing.pem"))).toThrow(/ENOENT/);
    });
  });

  describe("buildFetchWithCa", () => {
    it("trusts the default CAs and the file", () => {
      buildFetchWithCa(caPath);

      expect(agentOptions).toHaveLength(1);
      expect(agentOptions[0].connect?.ca).toEqual(readCaBundle(caPath));
    });
  });

  describe("buildMtlsAgent", () => {
    function writeClientFiles() {
      const certPath = path.join(dir, "client-cert.pem");
      const keyPath = path.join(dir, "client-key.pem");
      fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n");
      fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n");
      return { certPath, keyPath, tokenUrl: "https://api.example/token" };
    }

    it("trusts the default CAs and the file next to the client certificate", () => {
      buildMtlsAgent(writeClientFiles(), caPath);

      expect(agentOptions[0].connect?.ca).toEqual(readCaBundle(caPath));
      expect(agentOptions[0].connect).toHaveProperty("cert");
      expect(agentOptions[0].connect).toHaveProperty("key");
    });

    it("leaves the CAs to Node when no file is configured", () => {
      buildMtlsAgent(writeClientFiles());

      expect(agentOptions[0].connect).not.toHaveProperty("ca");
    });
  });
});
