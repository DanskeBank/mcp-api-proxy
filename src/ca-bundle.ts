import fs from "node:fs";
import tls from "node:tls";

/**
 * The CAs to trust when `MCP_SERVER_CA_CERT` is set: Node's default CAs plus
 * the bundle in the file. Passing the file alone would replace the defaults,
 * so a bundle with a single CA would break every publicly signed host.
 */
export function readCaBundle(caPath: string): string[] {
  // getCACertificates is missing before Node 22.15; rootCertificates lacks NODE_EXTRA_CA_CERTS.
  const defaults =
    typeof tls.getCACertificates === "function"
      ? tls.getCACertificates("default")
      : [...tls.rootCertificates];
  return [...defaults, fs.readFileSync(caPath, "utf8")];
}
