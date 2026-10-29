# @danskebank/mcp-api-proxy

Open-source MCP auth proxy for Danske Bank APIs. Connects to the hosted Danske Bank MCP server for API discovery and adds a local `call_endpoint` tool that handles mTLS, OAuth, and URL validation.

> **Audience**: Developers who want to build, customize, or embed the proxy themselves
> (custom audit logging, programmatic config, contributing, etc.). Just want to use the
> published package as-is? See [GETTING-STARTED.md](GETTING-STARTED.md) instead.

## Table of Contents

- [Quick Start](#quick-start)
- [Transport Modes](#transport-modes)
- [Command-Line Options](#command-line-options)
- [Environment Variables](#environment-variables)
- [Client Configuration](#client-configuration)
- [Hosts](#hosts)
- [Tools](#tools)
- [Audit Logging](#audit-logging)
- [Development](#development)
- [Release notes and feedback](#release-notes-and-feedback)
- [License](#license)

## Quick Start

Use **Node.js 22.13.0 or newer within 22.x, or Node.js 24 or newer**.
This common runtime and development baseline covers the updated dependencies;
Node.js 20, 21 and 23 are not supported. Prefer a current, supported LTS
release. CI builds on Node.js 22 and also checks the compiled entry point,
types and source tests on exactly 22.13.0.

```bash
npm install
npm run build
```

Before starting the proxy against the hosted MCP server, get an
[API key](https://developers.danskebank.com/mcp/apikey) and put these settings
in a [settings file](#settings-file) outside your project, such as
`danske-proxy.env`:

```bash
MCP_SERVER_API_KEY=your-mcp-api-key
```

## Transport Modes

### stdio (default)

```bash
node dist/index.js --settings-file /absolute/path/to/danske-proxy.env
# or explicitly:
node dist/index.js --transport stdio --settings-file /absolute/path/to/danske-proxy.env
```

### HTTP

```bash
node dist/index.js --transport http --settings-file /absolute/path/to/danske-proxy.env
# Listens on http://127.0.0.1:3001/mcp by default

# Custom port:
node dist/index.js --transport http --port 8080 --settings-file /absolute/path/to/danske-proxy.env
```

> **Loopback by default.** The CLI binds to `127.0.0.1` and validates the
> `Origin` and `Host` headers to prevent DNS-rebinding attacks from browsers.
> The `Host` check applies only while `--host` is a loopback address
> (`127.0.0.1`, `::1` or `localhost`); the proxy then accepts requests
> addressed to `localhost`, `127.0.0.1` or `[::1]` on the `--port` port. A
> reverse proxy or port forward in front of that listener must keep such a
> `Host` (nginx does by default for `proxy_pass http://127.0.0.1:<port>`),
> otherwise its requests get 403 errors. On any other bind the check is
> skipped, because the proxy is then reached under other host names, and the
> proxy prints a notice. To expose
> the proxy to a wider network, deploy it behind your own auth/reverse-proxy
> wrapper (see [Add your own auth layer](#add-your-own-auth-layer) for the pattern)
> rather than rebinding the CLI directly. If you do need a different bind
> for trusted setups, pass `--host` (e.g. `--host 0.0.0.0`).

> **Single credential, single tenant.** All callers of one HTTP proxy share
> its configured bank client ID, client certificate/private key
> and token manager/cache. Separate MCP session IDs do not isolate bank
> credentials per customer. Adding caller authentication in a reverse proxy
> or wrapper authenticates those callers; it does not give each caller a
> different bank identity. Use separately configured, isolated instances for
> different bank tenants, not one shared HTTP instance.

## Command-Line Options

| Option                       | Default     | Description                                                                                                                |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--transport stdio\|http`    | `stdio`     | How the proxy talks to your MCP client                                                                                     |
| `--settings-file <path>`     | —           | File with the [settings](#environment-variables) below (see [Settings file](#settings-file))                              |
| `--port <number>`            | `3001`      | HTTP listen port (only in `--transport http` mode)                                                                         |
| `--host <address>`           | `127.0.0.1` | HTTP bind address (only in `--transport http` mode). Use `0.0.0.0` only behind your own auth/reverse proxy.               |

The production hosts, token endpoints and OAuth scope are built into the
package, so there is nothing to configure for them. Session limits and
rate limits of the HTTP transport are options of
`createHttpSessionHandler` (see [Custom Audit Logger](#custom-audit-logger)),
not command-line settings.

## Environment Variables

| Variable                   | Required         | Default           | Description                                                                                                          |
| -------------------------- | ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MCP_SERVER_API_KEY`       | Yes              | —                 | API key sent as `X-API-Key`. Required for the hosted MCP server, including production.                              |
| `CLIENT_ID`                | Sandbox/Live     | —                 | OAuth2 client ID from Developer Portal; partial auth settings produce a startup warning naming missing variables     |
| `CLIENT_CERT_PEM`          | Sandbox/Live     | —                 | Path to PEM-encoded x509 client certificate for mTLS (shared by both sandbox and live tiers)                         |
| `CLIENT_KEY_PEM`           | Sandbox/Live     | —                 | Path to PEM-encoded private key (encrypted by default)                                                               |
| `CLIENT_KEY_PASSPHRASE`    | Sandbox/Live     | —                 | Passphrase for `CLIENT_KEY_PEM`. Private keys are encrypted by default, so set it; leave it out only for a key you decrypted yourself. The proxy warns at startup when it is missing. |
| `MCP_SERVER_CA_CERT`       | No               | —                 | Optional extra CA bundle (PEM) for custom upstream MCP server or API hosts, trusted in addition to Node's built-in CAs. Not bundled — supply your own path, same as `CLIENT_CERT_PEM`. |
| `TOKEN_SCOPE`              | No               | `accounts payments` | Space-delimited OAuth2 scopes to request. Set it only if your client is registered for fewer products, for example `TOKEN_SCOPE=accounts`; see [Token endpoints and scope](#token-endpoints-and-scope). |

Settings that earlier versions accepted (`MCP_SERVER_URL`, `MCP_API_HOST_*`,
`SANDBOX_TOKEN_URL`, `LIVE_TOKEN_URL`, `MCP_HTTP_PORT`,
`MCP_HTTP_HOST`, `MCP_MAX_SESSIONS`, `MCP_SESSION_TTL_MS`, `MCP_RATE_LIMIT_*` and
`MCP_TRUST_PROXY`) are ignored. The proxy lists the ones it finds on stderr, by
name only. Use `--port` and `--host` for the HTTP listener.

#### Authentication readiness and default tier

Startup diagnostics on stderr show `enabled-tiers` and `default-tier`, using the same
host and credential checks as `call_endpoint`. Partial authentication settings name
the missing variables, never their values. A credential or key passphrase indicates
an authentication attempt. With no OAuth/mTLS settings, mock/discovery-only operation
is intentional and does not produce an incomplete-auth warning.

For compatibility, the default remains **live, then sandbox, then mock**, choosing
the first tier whose host and credentials are available. Adding complete live
credentials therefore changes omitted-tier path calls to **real data (GET only)**;
startup output explicitly warns when this is the default. Set `tier` on each call when the target must
not depend on credential availability. No new setting or default change is introduced.

#### Settings file

To keep settings and credential paths out of your MCP client's configuration, put them in a file (start from [.env.example](.env.example)) and start the proxy with `--settings-file`:

```bash
node dist/index.js --settings-file /absolute/path/to/danske-proxy.env
```

- `--settings-file <path>` (or `--settings-file=<path>`) loads that file whatever the working directory, and no other file. A relative path is resolved against the working directory, and a leading `~/` against your home directory. A missing file stops the proxy with an error.
- The proxy never reads a `.env` from its working directory on its own. MCP clients that launch the proxy over stdio choose that directory (VS Code uses the workspace folder), so a project's `.env` would otherwise end up in the proxy's settings. If one is there, the proxy says on stderr that it was not loaded; pass `--settings-file` to use it.
- Variables that are already set (your client's `env` block, your shell) win over the file.
- The file uses `.env` syntax: quote values that contain `#` or spaces, e.g. `CLIENT_KEY_PASSPHRASE="p#ss phrase"`.
- The proxy logs the path of the file it loaded, never the values. Never commit the file; `.env` is gitignored.
- The flag isn't called `--env-file` because Node reads that flag itself, wherever it appears on the command line.

#### PEM file format

- `*_CERT_PEM` files must contain a `-----BEGIN CERTIFICATE-----` block.
- `*_KEY_PEM` files must contain a `-----BEGIN PRIVATE KEY-----` (or `RSA PRIVATE KEY`, `EC PRIVATE KEY`, `ENCRYPTED PRIVATE KEY`) block.
- Private keys are encrypted by default (`ENCRYPTED PRIVATE KEY`), so set `CLIENT_KEY_PASSPHRASE`. Without it the proxy cannot read the key.
- The same client cert is used for **both** the OAuth2 token endpoint and the API calls themselves.

#### Token endpoints and scope

Token endpoints are built into the package. Each tier signs in at its own host, and every Premium API, including the Payment Collection API, uses that endpoint:

| Tier | Token URL |
| ---- | --------- |
| Sandbox | `https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token` |
| Live | `https://api.danskebank.com/corporate/api/dk/business/oauth2/token` |

By default the proxy requests the scopes `accounts payments` in a single token request: the OAuth 2.0 `scope` parameter is a space-delimited list in which each value adds an access range ([RFC 6749, section 3.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.3)). The token service decides what it grants, and the API enforces what your client is registered for.

If your client is registered for fewer products, the token service can reject that request. The `[auth]` error then says so and names the fix: set `TOKEN_SCOPE` to the scopes your client is registered for (for example `TOKEN_SCOPE=accounts`) in the `env` block or your [settings file](#settings-file), and restart the proxy. `TOKEN_SCOPE` only narrows what is requested; it cannot change where credentials are sent. The proxy does not echo a `TOKEN_SCOPE` you set.

## Client Configuration

The examples start the proxy from your build (`node /path/to/mcp-api-proxy/dist/index.js`). Users of the published package use `npx -y @danskebank/mcp-api-proxy@latest` instead, as in [GETTING-STARTED.md](GETTING-STARTED.md).

### VS Code (GitHub Copilot)

Run **MCP: Add Server**, choose **Command (stdio)**, enter the server ID `danske-bank-apis`, then select **Global** and **Copilot Global**. That writes the portable `mcpServers` file `.copilot/mcp-config.json` in your home folder. Add to it:

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "node",
      "args": ["/path/to/mcp-api-proxy/dist/index.js"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
      },
    },
  },
}
```

Or with sandbox credentials:

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "node",
      "args": ["/path/to/mcp-api-proxy/dist/index.js"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
        "CLIENT_ID": "your-client-id",
        "CLIENT_CERT_PEM": "/path/to/client-cert.pem",
        "CLIENT_KEY_PEM": "/path/to/client-key.pem",
        // Private keys are encrypted by default:
        "CLIENT_KEY_PASSPHRASE": "your-key-passphrase",
      },
    },
  },
}
```

To keep the credentials out of the config file, put them in a [settings file](#settings-file) and pass it with `--settings-file`. The portable file supports neither `envFile` nor VS Code input prompts:

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "node",
      "args": [
        "/path/to/mcp-api-proxy/dist/index.js",
        "--settings-file",
        "/absolute/path/to/danske-proxy.env",
      ],
    },
  },
}
```

The older VS Code format (a `servers` object in `.vscode/mcp.json` or the user-profile `mcp.json`) still works for Local sessions and also supports `envFile` and `${input:...}` prompts, but VS Code labels it deprecated and does not forward servers that need prompts to Copilot sessions. See VS Code's [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "node",
      "args": ["/path/to/mcp-api-proxy/dist/index.js"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
      },
    },
  },
}
```

Claude Desktop has no `envFile` and no input prompts, so keep credentials in a [settings file](#settings-file) and pass it with `--settings-file`:

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "node",
      "args": [
        "/path/to/mcp-api-proxy/dist/index.js",
        "--settings-file",
        "/absolute/path/to/danske-proxy.env",
      ],
    },
  },
}
```

### HTTP Mode (any client)

Start the server yourself with an explicit [settings file](#settings-file)
containing the required `MCP_SERVER_API_KEY`:

```bash
node dist/index.js --transport http --settings-file /absolute/path/to/danske-proxy.env
```

Then point any MCP client that supports Streamable HTTP to:

```
http://127.0.0.1:3001/mcp
```

For example, in VS Code (`.copilot/mcp-config.json`):

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
    },
  },
}
```

## Hosts

The proxy connects to these hosts. They are built into the package and cannot
be changed through settings:

| Service | Default host |
| ------- | ------------ |
| Hosted MCP server | mcp.danskebank.com |
| Mock API | mock-api.danskebank.com |
| Sandbox API | sandbox-api.danskebank.com |
| Live API | api.danskebank.com |

### Upstream MCP server API key

The hosted MCP server, including the production endpoint, requires an API
key. Get yours from the [MCP API-key page](https://developers.danskebank.com/mcp/apikey)
and set `MCP_SERVER_API_KEY` to that key before connecting. The proxy sends
it as `X-API-Key` on every request to the upstream MCP server.

Without a valid key, hosted catalog discovery is unavailable and only
`call_endpoint` is exposed. The proxy says why: on stderr, in the server
instructions and in the result of a discovery tool call, it reports

- `[auth]` when `MCP_SERVER_API_KEY` is not set or the hosted server rejected
  it (including an HTTP 401 or 403 from a gateway in front of it),
- `[rate_limited]` after too many invalid key attempts from your address, or
- `[upstream]` when the hosted server could not verify the key right now. This
  is usually temporary; the proxy tries three times before reporting it.

A rejected key is not retried. The proxy remembers a refusal for one minute
per process, so an HTTP proxy with many sessions, or an agent calling tools in
a loop, does not keep sending the key to a server that limits invalid attempts.
A different key, or a refusal older than a minute, is tried again. The key is
never printed. Fix `MCP_SERVER_API_KEY` and restart the proxy; discovery returns
only after a restart. This key is
separate from the mTLS and OAuth2 credentials required for sandbox/live API
calls.

## Tools

The proxy exposes all upstream discovery tools (from the hosted MCP server) plus one local tool:

### `call_endpoint`

Executes an HTTP request against a Danske Bank API on one of three tiers: `mock` (sample data, no auth), `sandbox` (test data) and `live` (real data, GET only). The tool description lists the tiers this deployment can call, with their hosts, and names the default tier.

**Building `url`.** Take the OpenAPI `servers` entry of the tier you call, which is the entry whose host is that tier's host (hosted specs often list the mock server first), and append the operation path to the entry's path. For example, entry `https://api.danskebank.com/corporate/api` and operation `/v1/accounts/list` give `url: "/corporate/api/v1/accounts/list"`. The operation path alone returns 404.

**Destination rules.** Credentials only ever go to the configured host of the resolved tier:

- A path (starting with `/`) goes to the host of `tier`, or of the default tier when `tier` is omitted.
- A full URL must be `https://` on the configured host of the tier, with no port other than 443 and no `user:password@`. Without `tier`, the host decides the tier; with `tier`, the host must be that tier's host.
- Anything else is rejected before a request is made.
- The default tier is `live` when its host and credentials are configured, otherwise `sandbox` when its host and credentials are configured, otherwise `mock`.

The proxy also:

- Enforces GET-only for live
- Injects mTLS + OAuth2 Bearer token for sandbox/live via [`TokenManager`](src/auth/token-manager.ts)
- Never follows a redirect on sandbox and live calls or on the token request: an API's `3xx` comes back as the result, and a `3xx` from the token endpoint is an error
- Caches validated access tokens per tier and refreshes up to 60s before expiry, never more than halfway through their lifetime
- On a 401, invalidates the cached token and retries the call once
- Skips auth entirely for mock URLs
- Limits serialized request bodies to 1 MiB (1,048,576 UTF-8 bytes), not characters; the exact limit is accepted
- Limits API responses to 10 MiB, cancelling the body when either the declared or streamed size exceeds the limit
- Parses `application/json` and `application/*+json` responses (including `application/problem+json`) as JSON, case-insensitively and ignoring media-type parameters; malformed JSON is returned as raw text, and an empty JSON body as `null`

#### OAuth token response validation

Before caching a sandbox or live token, the proxy requires a JSON object with:

- `access_token`: a non-blank string, used exactly as returned.
- `expires_in`: a finite positive number of seconds that produces a finite refresh timestamp.
- `token_type`: optional; when present, it must be `Bearer` (case-insensitive). A missing value remains accepted for compatibility.

Malformed JSON or invalid fields fail with an `[auth]` error naming the tier and invalid fields, never their values or a response-body excerpt. The response is not cached; a later call can request a new token.

The returned `scope` is ignored, including when it differs from the requested scopes. The proxy continues requesting the same scopes when minting and refreshing tokens; it does not compare granted scopes or change API permissions. The API enforces the token's actual grants, so a narrower grant can still cause an API authorization failure.

### Error reporting

`call_endpoint` returns the same envelope in MCP `structuredContent` and the
existing `content[].text` JSON text. `tools/list` advertises an `outputSchema` for
both API responses and proxy-generated errors; text-only clients keep the same
text, formatting and error semantics.

API responses include the resolved `tier` and the API's original `status`,
`headers` and `body`. The body keeps its original JSON value (including arrays,
scalars and `null`) or raw text; it is not JSON-encoded again inside
`structuredContent`. Only HTTP `2xx` indicates API-level success; the
assistant must still check the expected response shape before claiming business
success. Redirects are not success and are not followed on authenticated calls.
HTTP `400` and above sets MCP `isError: true`, while retaining the complete API
response for the caller. Statuses below `400`, including redirects, keep `isError`
omitted; absence of the flag alone is not a success rule.

Errors include an `error` object with `category`, `retryable` and `nextStep`:

| Category | Meaning | Recovery |
| --- | --- | --- |
| `validation` | Invalid tool input or another request-related `4xx` | Correct the request against the schema and API specification |
| `auth` | Authentication/authorization failure, including API `401`/`403` | Check credentials, scope and API access before retrying |
| `not_found` | API `404` | Check the tier-specific base path, operation and resource |
| `rate_limited` | API `429` | Respect `Retry-After` and the API's retry policy |
| `upstream` | Transport failure, API `408` or `5xx` | Check connectivity and service availability |
| `configuration` | Missing or invalid proxy settings | Correct the named settings and restart |
| `internal` | Another proxy-owned failure | Review safe diagnostics or contact support |

`retryable` is advisory, not an automatic retry. It is true only for GET transport
failures or GET responses with status `408`, `429`, `500`, `502`, `503` or `504`.
Non-GET errors never invite automatic replay: confirm the operation's outcome
before repeating it. The existing single token-refresh retry after an API `401`
is unchanged.

Proxy-generated errors additionally include a safe `error.message` and the tier
when resolved; they do not invent an API status, headers or body when no API
response was obtained. Raw exception text, stack traces and OAuth token-response
bodies remain hidden. Discovery failures remain sanitized text errors.
The original API response is intentionally visible to the caller, but neither
default nor custom audit error fields receive its headers or body.

## Audit Logging

All tool calls are logged to stderr as structured JSON. The default `ConsoleAuditLogger` works out of the box for stdio and HTTP modes.

- URL userinfo, fragments and query values are omitted. Only query parameter names are logged.
- Every non-empty path segment is replaced with `[redacted]`: without route templates, the proxy cannot reliably distinguish a route name from a customer identifier. The scheme and host remain visible.
- Invalid, relative and non-HTTP URLs are logged as `[redacted]`, never as the original input.
- The `error` field contains a category, not free text or a response body. Unknown error text becomes `tool_error`.
- Startup and cleanup errors use safe messages rather than raw exceptions. Startup URLs are masked and certificate paths are not printed.

### Custom Audit Logger

When you deploy the proxy in your own infrastructure (with user auth, monitoring, etc.), you can provide your own `AuditLogger` implementation. Package upgrades won't touch your code — the interface stays stable.

`AuditEvent` retains the same fields, including the original request URL when present. Explicitly supplying a custom logger opts into handling that fuller request information: apply your own redaction, access controls and retention policy before persisting it. Do not forward whole events to a central sink without that policy. There is no built-in switch to print raw exceptions or token-response bodies.

**Install the package:**

```bash
npm install @danskebank/mcp-api-proxy
```

**Create your custom logger:**

```ts
// my-logger.ts
import type { AuditLogger, AuditEvent } from "@danskebank/mcp-api-proxy";

export class SplunkAuditLogger implements AuditLogger {
  constructor(private resolveUser: () => string) {}

  async logToolCall(event: AuditEvent): Promise<void> {
    await sendToSplunk({
      ...event,
      user: this.resolveUser(),
      direction: "request",
    });
  }

  async logToolResult(event: AuditEvent): Promise<void> {
    await sendToSplunk({
      ...event,
      user: this.resolveUser(),
      direction: "response",
    });
  }
}
```

**Create your entry point:**

```ts
// server.ts — your deployment wrapper
import { createServer as createHttpServer } from "node:http";
import {
  createHttpSessionHandler,
  createLoopbackHostCheck,
  createLoopbackOriginCheck,
} from "@danskebank/mcp-api-proxy";
import { SplunkAuditLogger } from "./my-logger.js";
import { getCurrentUser } from "./auth.js";

const sessions = createHttpSessionHandler({
  maxSessions: 100,
  sessionTtlMs: 30 * 60 * 1000,
  rateLimitPerIp: 10,
  rateLimitWindowMs: 60_000,
  // Set when behind a trusted reverse proxy that sanitises XFF.
  trustProxy: false,
  proxyOptions: {
    auditLogger: new SplunkAuditLogger(() => getCurrentUser()),
  },
});

const isAllowedOrigin = createLoopbackOriginCheck({ port: 3001 });
// Only valid when clients reach this server directly under a loopback name, as below.
const isAllowedHost = createLoopbackHostCheck({ port: 3001 });

const httpServer = createHttpServer((req, res) => {
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    res.writeHead(403).end();
    return;
  }
  // Add your own auth middleware here.
  if (req.url?.split("?")[0] === "/mcp") {
    sessions.handleRequest(req, res).catch(() => {
      console.error("Proxy HTTP request failed.");
      if (!res.headersSent) res.writeHead(500).end();
    });
  } else {
    res.writeHead(404).end("Not found");
  }
});

httpServer.listen(3001, "127.0.0.1", () => {
  console.error("Custom MCP proxy running on http://127.0.0.1:3001/mcp");
});

// On shutdown:
//   httpServer.close();
//   await sessions.closeAll();
```

`createHttpSessionHandler` enforces the same protections as the built-in CLI:
max-session cap, idle reaper, per-IP rate limit, shared upstream
`TokenManager`, and graceful shutdown. Prefer it over wiring
`StreamableHTTPServerTransport` yourself. The CLI runs it with the values in the
example above, which only an embedding process like this one can change.

Rejected or disconnected initialization requests release their session slots and
close their per-request proxy resources. The session cap includes pending
initializations. Idle cleanup never interrupts an in-flight POST request,
including concurrent tool calls, and measures inactivity from request completion.
An open GET event stream alone does not keep an otherwise idle session alive.
Shutdown also closes pending initializations and rejects new sessions.

### Add your own auth layer

`CLIENT_ID` / `CLIENT_CERT_PEM` authenticate the **proxy itself** to Danske
Bank's APIs — they say nothing about who's allowed to call *your*
deployment. That's what the `// Add your own auth middleware here.` comment
above is for; the proxy has no opinion on it.

**Example: checking Entra ID (Azure AD) group membership**

```ts
// entra-auth.ts — your own dependency, not part of @danskebank/mcp-api-proxy
import jwt, { type JwtPayload } from "jsonwebtoken";
import jwksClient from "jwks-rsa";

export class EntraGroupAuth {
  private readonly jwks = jwksClient({
    jwksUri: `https://login.microsoftonline.com/${this.tenantId}/discovery/v2.0/keys`,
  });

  constructor(
    private readonly tenantId: string,
    private readonly audience: string,
    private readonly requiredGroupId: string,
  ) {}

  /** Verifies the bearer token and checks group membership. Returns the user id, or null. */
  async authenticate(authHeader: string | undefined): Promise<string | null> {
    const token = authHeader?.replace(/^Bearer /, "");
    if (!token) return null;

    try {
      const payload = await new Promise<JwtPayload>((resolve, reject) => {
        jwt.verify(
          token,
          (header, callback) => {
            this.jwks.getSigningKey(header.kid, (err, key) => {
              callback(err, key?.getPublicKey());
            });
          },
          {
            audience: this.audience,
            issuer: `https://login.microsoftonline.com/${this.tenantId}/v2.0`,
          },
          (err, decoded) => (err ? reject(err) : resolve(decoded as JwtPayload)),
        );
      });

      // Note: Entra omits the `groups` claim (replaced by an overage marker)
      // once a user belongs to 200+ groups — fall back to Microsoft Graph
      // (`/me/memberOf`) in that case instead of trusting this claim blindly.
      const groups = (payload.groups as string[] | undefined) ?? [];
      if (!groups.includes(this.requiredGroupId)) return null;

      return (payload.oid as string) ?? (payload.sub as string);
    } catch {
      return null;
    }
  }
}
```

Wire it in ahead of `sessions.handleRequest`, and thread the resolved user
through [`AsyncLocalStorage`](https://nodejs.org/api/async_context.html) —
`getCurrentUser()` above is a plain function with no request parameter, so a
module-level variable would leak between concurrent requests from different
users:

```ts
// auth.ts
import { AsyncLocalStorage } from "node:async_hooks";

const userContext = new AsyncLocalStorage<string>();
export const getCurrentUser = () => userContext.getStore() ?? "anonymous";

const entraAuth = new EntraGroupAuth(
  process.env.ENTRA_TENANT_ID!,
  process.env.ENTRA_AUDIENCE!,
  process.env.ENTRA_REQUIRED_GROUP_ID!,
);

export async function withAuth(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const user = await entraAuth.authenticate(req.headers.authorization);
  if (!user) {
    res.writeHead(401).end();
    return;
  }
  userContext.run(user, next);
}
```

```ts
// server.ts — merge `withAuth` into the existing `./auth.js` import at the
// top of the file (alongside `getCurrentUser`):
//   import { getCurrentUser, withAuth } from "./auth.js";
//
// Then, inside the httpServer callback above, replace everything from the
// `// Add your own auth middleware here.` comment onward — the
// isAllowedHost and isAllowedOrigin checks before it are unchanged:
if (req.url?.split("?")[0] !== "/mcp") {
  res.writeHead(404).end("Not found");
  return;
}
await withAuth(req, res, () => {
  sessions.handleRequest(req, res).catch(() => {
    console.error("Proxy HTTP request failed.");
    if (!res.headersSent) res.writeHead(500).end();
  });
});
```

### Programmatic configuration

By default the proxy reads configuration from environment variables. To embed
the proxy in a process that manages its own configuration source (vault,
config service, tests) pass a `config` directly:

```ts
import { createServer, type Config } from "@danskebank/mcp-api-proxy";

export async function startProxy(config: Config) {
  return createServer({ config });
}
```

Provide the hosted MCP server API key as `config.mcpServerApiKey`, separately
from any sandbox/live credentials.

When `config` is provided, environment variables are ignored entirely.

**Upgrading:**

```bash
npm update @danskebank/mcp-api-proxy
# Your wrapper + logger unchanged. New proxy features just work.
```

### Built-in CLI usage

If you don't need customization, run the built-in CLI with your
[settings file](#settings-file), including the required hosted MCP server API key:

```bash
# stdio
npx -y @danskebank/mcp-api-proxy@latest --settings-file /absolute/path/to/danske-proxy.env
# HTTP
npx -y @danskebank/mcp-api-proxy@latest --transport http --settings-file /absolute/path/to/danske-proxy.env
```

## Development

```bash
npm run dev -- --settings-file .env   # Run with tsx (no build step); the .env is not read unless you pass it
npm run lint         # Lint source and release tooling
npm run typecheck    # Type-check source, release tooling and tests without emitting files
npm run build        # Compile TypeScript
npm test             # Run tests
npm run test:watch   # Watch mode
```

The provenance tests use Git and tar installed on your `PATH`, on Windows,
macOS or Linux. Normal lint, type-check, build and test commands need no
release-specific settings.

## Release notes and feedback

Both MCP initialization identities report the version from the installed
package metadata, including prerelease identifiers.

[RELEASE-NOTES.md](RELEASE-NOTES.md) contains the curated changes, known limits
and feedback guidance. Update and commit it for each release, and associate
the notes with the published version in the existing release record.
Public releases do not require a custom checksum bundle, a post-publication
package download or a provenance-helper run.

When reporting a proxy issue through the
[Danske Bank Developer Portal](https://developers.danskebank.com), include the
installed package version (`npm list @danskebank/mcp-api-proxy --depth=0`, or
add `-g` for a global installation), Node.js version, transport, tier and
redacted reproduction steps.
Never send credentials, private configuration or raw API data.

## License

MIT

You run this proxy yourself, on your own infrastructure, with your own
credentials — so you own what happens when you do. If you fork it, change
the auth logic, or wire it into a bigger service, that customization is on
you: Danske Bank isn't operating it, isn't monitoring it, and isn't liable
for how it behaves once it leaves this repo. The [LICENSE](LICENSE) spells
out the formal "as is" terms.

Found a bug in the proxy itself? Report it at the
[Developer Portal](https://developers.danskebank.com) — the same place for
questions about the actual Danske Bank APIs.
