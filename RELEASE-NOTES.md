## Upgrading from 1.0.x

This release has breaking changes. `npx -y @danskebank/mcp-api-proxy@latest`
picks it up automatically; to stay on the previous release while you prepare,
pin it with `npx -y @danskebank/mcp-api-proxy@1.0.1`.

| In 1.0.x | Now | What to do |
| -------- | --- | ---------- |
| A `.env` file in the working directory was read automatically. | It is never read on its own. The proxy says on stderr when it finds one it did not load. | Pass `--settings-file <path>`. |
| `TOKEN_SCOPE` defaulted to `accounts`. | **Breaking:** the default is `accounts payments`, requested in one token request. A client registered for fewer products can have the token request rejected. | If it is rejected, set `TOKEN_SCOPE` to what your client is registered for, for example `TOKEN_SCOPE=accounts`. The error says so. |
| Any `Host` header was accepted in HTTP mode. | **Breaking for some setups:** on a loopback `--host`, requests not addressed to `localhost`, `127.0.0.1` or `[::1]` on the proxy's port get 403 (DNS-rebinding protection). | Keep a loopback `Host` in a reverse proxy or port forward. |
| `MCP_HTTP_PORT`, `MCP_HTTP_HOST` | Removed. | Use `--port` and `--host`. |
| `MCP_MAX_SESSIONS`, `MCP_SESSION_TTL_MS`, `MCP_RATE_LIMIT_PER_IP`, `MCP_RATE_LIMIT_WINDOW_MS` | Removed from the CLI, which uses the former defaults: 100 sessions, 30 minutes idle, 10 new sessions per IP per minute. | Embedding the package? Set them as options of `createHttpSessionHandler`. |
| `MCP_TRUST_PROXY` | Removed. The CLI no longer trusts `X-Forwarded-For`. | Behind a reverse proxy every client now appears with the proxy's address and shares one limit of 10 new sessions per minute. Embedding the package? Pass `trustProxy` to `createHttpSessionHandler`. |
| `MCP_SERVER_URL`, `MCP_API_HOST_MOCK`, `MCP_API_HOST_SANDBOX`, `MCP_API_HOST_LIVE` | Removed. Hosts are built into the package. | Delete them. |
| `SANDBOX_TOKEN_URL`, `LIVE_TOKEN_URL` | Removed. Each tier has one token endpoint for every API, including the Payment Collection API. | Delete them, including the Payment Collection overrides. |
| `MCP_ENV` selected the environment: `prod` or `production` used the built-in hosts, anything else (or nothing) was a custom environment. | Ignored: this package supports production only. `prod` and `production` are accepted silently; any other value is reported on stderr. | Delete it; you no longer need to set it. Custom environments are no longer supported. |

Removed settings are ignored, not rejected: the proxy lists the ones it finds
on stderr, by name only.

## Changes

- **Breaking:** the changes in the table above.
- A missing or rejected `MCP_SERVER_API_KEY` is now reported on stderr, in the
  proxy instructions and in discovery tool results as `[auth]` (or
  `[rate_limited]` after too many invalid attempts). A rejected key is no longer
  retried and is remembered for a minute per process, so many HTTP sessions do
  not keep sending it. When the hosted server cannot verify the key right now,
  the proxy still retries three times and then reports `[upstream]` in the same
  places. Other connection failures behave as before.
- The proxy warns at startup when the client credentials are set but
  `CLIENT_KEY_PASSPHRASE` is not, since private keys are normally encrypted.
- A CA bundle set with `MCP_SERVER_CA_CERT` is now trusted in addition to
  Node's built-in CAs (and, on Node.js 22.15 or newer, those of
  `NODE_EXTRA_CA_CERTS`). It used to replace them, which broke publicly signed
  hosts.
- The `Host` check is also available to embedders as `createLoopbackHostCheck`.
  The rest of the exported API is unchanged.
- Update `zod` to 4.6.7 and `body-parser` to 2.4.0 to resolve reported
  denial-of-service advisories. The `call_endpoint` input schema and its
  validation messages are unchanged.

## Known limits

- Catalog discovery requires an available hosted MCP server and, where
  enabled, an authorized MCP API key.
- Calling bank APIs requires the appropriate API access and credentials;
  catalog visibility does not grant API entitlement.
- One HTTP proxy process shares its configured bank credentials across its
  sessions. Use separate instances for separate bank tenants.
- Live API calls are GET-only. Discovery and mock checks do not verify
  customer mTLS/OAuth access or live API behavior.
- This package does not include client credentials.

## Feedback

Report proxy issues through:
https://developers.danskebank.com/premium-apis/contact-us

Include the installed package version, Node.js version, transport, runtime
environment/tier, a safe error category and redacted reproduction steps.
Never include credentials, unredacted API data or private settings files.
