// Test-only preload for CLI subprocess tests: points the hosted upstream at a
// local synthetic server, since the proxy takes its endpoints from the package
// and cannot be redirected through settings.
const upstream = process.env.TEST_UPSTREAM_URL;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (!upstream || new URL(request.url).hostname !== "mcp.danskebank.com") {
    return realFetch(request);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return realFetch(upstream, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  });
};
