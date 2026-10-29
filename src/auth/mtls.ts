import fs from "node:fs";
import { Agent, type Dispatcher } from "undici";
import { readCaBundle } from "../ca-bundle.js";
import type { EnvironmentAuth } from "../types/index.js";

/**
 * Build an undici Dispatcher that performs mutual-TLS for the given client
 * credentials. Used for both the OAuth2 token endpoint and the API calls
 * themselves — both require the same client cert.
 *
 * The cert/key files are read synchronously at agent-build time so that any
 * filesystem or PEM-format error surfaces immediately rather than on the
 * first network call.
 */
export function buildMtlsAgent(
  auth: EnvironmentAuth,
  caPath?: string,
): Dispatcher {
  const cert = fs.readFileSync(auth.certPath);
  const key = fs.readFileSync(auth.keyPath);
  if (!cert.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(
      `Client certificate at ${auth.certPath} does not contain a CERTIFICATE block.`,
    );
  }
  if (
    !/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(
      key.toString("utf8"),
    )
  ) {
    throw new Error(
      `Client key at ${auth.keyPath} does not contain a PRIVATE KEY block.`,
    );
  }
  const ca = caPath ? readCaBundle(caPath) : undefined;

  return new Agent({
    connect: {
      cert,
      key,
      ...(auth.keyPassphrase ? { passphrase: auth.keyPassphrase } : {}),
      ...(ca ? { ca } : {}),
    },
  });
}
