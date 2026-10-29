# Getting Started with the Danske Bank MCP API Proxy

> **Audience**: Users who just want to *use* the published
> `@danskebank/mcp-api-proxy` package to call Danske Bank APIs from an AI assistant —
> no cloning or building required. If you want to customize the proxy or build it
> from source yourself, see [README.md](README.md) instead.

This guide gets you from nothing to chatting with an AI assistant about Danske Bank APIs. You will:

1. [Install the prerequisites](#step-1--prerequisites)
2. [Get the proxy](#step-2--get-the-proxy)
3. [Connect it to your AI client](#step-3--connect-your-ai-client)
4. [Try it out](#step-4--try-it-out)
5. (Optional) [Add credentials to call real APIs](#step-5--calling-real-apis-optional)
6. (Optional) [Keep secrets out of your config file](#step-6--keep-secrets-out-of-your-config-file-optional)

The hosted API catalog requires an MCP server API key, supplied as
`MCP_SERVER_API_KEY`. This is separate from Danske Bank client credentials:
discovery and mock API calls need no OAuth/mTLS credentials, while
sandbox/live API calls do (Step 5).

---

## What this proxy does

The proxy is a local [Model Context Protocol](https://modelcontextprotocol.io) server. It connects to Danske Bank's hosted MCP server so your AI assistant can search the API catalog, and it adds a local `call_endpoint` tool that handles mTLS and OAuth2 for you when you call an actual API.

Your client certificate and private key never leave your machine.

---

## Step 1 — Prerequisites

- **Node.js 22.13.0 or newer within 22.x, or Node.js 24 or newer** — Node.js 20, 21 and 23 are not supported. Prefer a current, supported LTS release, available from [nodejs.org](https://nodejs.org). CI tests the exact minimum, 22.13.0. Verify with:

  ```bash
  node --version
  ```

- **An MCP server API key** — get one from the
  [MCP API-key page](https://developers.danskebank.com/mcp/apikey). It is required
  to connect to the hosted catalog, including production. Set it as
  `MCP_SERVER_API_KEY` in Step 3.

- **An MCP-capable AI client**, such as:
  - [Visual Studio Code](https://code.visualstudio.com) with GitHub Copilot (agent mode)
  - [Claude Desktop](https://claude.ai/download)
  - Any other client that supports MCP over stdio or Streamable HTTP

---

## Step 2 — Get the proxy

There is nothing to install. The configurations in Step 3 start the proxy with `npx -y @danskebank/mcp-api-proxy@latest`: your AI client runs it, and `npx` (which comes with Node.js) downloads it on the first start. That first start needs access to the npm registry and can take a little longer.

`@latest` makes every start use the newest published release, even if an older copy is already installed on your machine. To keep one version instead, replace `latest` with a version number.

`-y` answers npx's "Ok to proceed?" prompt for you. An AI client starts the proxy without a terminal, so without it the start would wait for an answer.

Optional: to run offline or to keep one version, install the proxy yourself and use `danske-mcp-proxy` as the `command` (with no `args`, or only the proxy's options) instead of `npx`:

```bash
npm install -g @danskebank/mcp-api-proxy
```

A global install does not update itself. To update it, run `npm install -g @danskebank/mcp-api-proxy@latest`.

If your client still runs an older version than you expect, restart the server in your client. If it still does, delete the `_npx` folder inside the folder that `npm config get cache` prints.

---

## Step 3 — Connect your AI client

Get your key from the [MCP API-key page](https://developers.danskebank.com/mcp/apikey),
then replace `your-mcp-api-key` in the examples with it.
The hosted catalog cannot be reached without a valid key. A personal
configuration file is not a secret store: keep it out of your projects, never
commit it, or keep the key in a private settings file instead (Step 6).

### Visual Studio Code

1. Open the Command Palette (**Ctrl+Shift+P**, on macOS **Cmd+Shift+P**) and run **MCP: Add Server**.
2. Choose **Command (stdio)** and enter `npx -y @danskebank/mcp-api-proxy@latest`.
3. Enter the server ID `danske-bank-apis`.
4. Select **Global**, then **Copilot Global**. This stores the server in `.copilot/mcp-config.json` in your home folder, outside any project. If **Copilot Global** is not offered, see VS Code's [Copilot harness requirements](https://code.visualstudio.com/docs/agents/run/agent-harnesses#_copilot).
5. Open that file and add your key. If it already lists other servers, add `danske-bank-apis` next to them:

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy@latest"],
      "tools": ["*"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
      },
    },
  },
}
```

Then start an agent session in the Chat view and confirm that tools such as `get_filters` and `search_apis` appear for `danske-bank-apis`.

**Older VS Code format.** `.vscode/mcp.json` and the user-profile `mcp.json` use a `servers` object instead of `mcpServers`. VS Code still reads them but labels them deprecated, so prefer the steps above. See VS Code's [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

### Claude Desktop

Add to your config file — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy@latest"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
      },
    },
  },
}
```

Restart Claude Desktop afterwards.

### Claude Code

Run this in a terminal. Everything after `--` is the command that starts the proxy:

```bash
claude mcp add danske-bank-apis --env MCP_SERVER_API_KEY=your-mcp-api-key -- npx -y @danskebank/mcp-api-proxy@latest
```

Run `claude mcp list` to confirm that `danske-bank-apis` is connected. Claude Code stores the key in its own configuration; to keep it out, use a settings file (Step 6).

### Any other client (HTTP)

Use an explicit settings file to keep credentials out of the shell command.
Put the following in a file outside your project, such as `danske-proxy.env`:

```bash
MCP_SERVER_API_KEY=your-mcp-api-key
```

Then start the proxy with that file:

```bash
npx -y @danskebank/mcp-api-proxy@latest --transport http --settings-file /absolute/path/to/danske-proxy.env
```

Point your client at `http://127.0.0.1:3001/mcp`. Use `--port` to listen on another port.

One HTTP proxy uses one bank credential set for all callers.
Authenticating callers in your own wrapper does not isolate bank credentials
per customer; use separate instances for separate tenants
([details](README.md#http)).

---

## Step 4 — Try it out

Ask your assistant questions like:

- _"What Danske Bank APIs are available for payments?"_
- _"What endpoints does the Account Information API have?"_
- _"Call the mock server for the accounts API and show me the response."_

Mock API calls need no OAuth/mTLS credentials. Catalog browsing still
requires the MCP server API key configured in Step 3.

---

## Step 5 — Calling real APIs (optional)

To call sandbox or production APIs you need credentials from the [Danske Bank Developer Portal](https://developers.danskebank.com):

1. Register your application to get a **client ID**.
2. Upload a certificate signing request and download your **client certificate**.
3. Keep the matching **private key** that you generated locally.

Then add them to the `env` block of your client configuration:

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy@latest"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
        "CLIENT_ID": "your-client-id",
        "CLIENT_CERT_PEM": "/absolute/path/to/client-cert.pem",
        "CLIENT_KEY_PEM": "/absolute/path/to/client-key.pem",
        // Private keys are encrypted by default:
        "CLIENT_KEY_PASSPHRASE": "your-key-passphrase",
      },
    },
  },
}
```

Notes:

- Use **absolute paths** for the PEM files.
- Certificate files must contain a `-----BEGIN CERTIFICATE-----` block; key files a `-----BEGIN PRIVATE KEY-----` or `-----BEGIN ENCRYPTED PRIVATE KEY-----` block. Private keys are encrypted by default, so `CLIENT_KEY_PASSPHRASE` is needed.
- The proxy requests the scopes `accounts payments` in one token request, and every Premium API, including the **Payment Collection API**, uses the same token endpoint. If your client is registered for only one product and the token request is rejected, the `[auth]` error says so: set `TOKEN_SCOPE` (for example `TOKEN_SCOPE=accounts`) in the `env` block or your settings file and restart. A returned `scope` does not change what the proxy requests; see [token response validation](README.md#oauth-token-response-validation).
- Values in the `env` block end up in your client's config file. To keep them out of it, use a settings file with `--settings-file` (Step 6).
- The proxy never reads a `.env` file from its working directory (VS Code uses your workspace folder). If there is one, the proxy says so on stderr. Pass `--settings-file` to use it.
- Production is **GET-only** in this proxy as a safety guard.
- Check stderr startup output for `enabled-tiers` and `default-tier`. Partial OAuth/mTLS settings list missing variable names without exposing values; leaving all OAuth/mTLS settings unset is a valid mock/discovery-only setup. The hosted MCP server API key is still required for discovery.
- The default remains live when its host and credentials are complete, otherwise sandbox, otherwise mock. Adding live credentials can make omitted-tier calls use real data; specify `tier` per call to choose explicitly.
- Request bodies are limited to 1 MiB of serialized UTF-8, and API responses to 10 MiB. JSON and `application/*+json` responses are parsed; malformed JSON remains raw text ([details](README.md#call_endpoint)).

See the [README](README.md) for the full list of environment variables and for embedding the proxy in your own service.

---

## Step 6 — Keep secrets out of your config file (optional)

Secrets such as `MCP_SERVER_API_KEY` and `CLIENT_KEY_PASSPHRASE` from Step 5
sit in plain text if you put them directly in your client's config file, and a
personal configuration file is not a secret store. The way to avoid that in
every client is a settings file.

### A settings file (any client)

Put the settings in a file outside your project, for example `danske-proxy.env` in your home folder:

```bash
MCP_SERVER_API_KEY=your-mcp-api-key
CLIENT_ID=your-client-id
CLIENT_CERT_PEM=/absolute/path/to/client-cert.pem
CLIENT_KEY_PEM=/absolute/path/to/client-key.pem
CLIENT_KEY_PASSPHRASE=your-key-passphrase
```

Then pass the file to the proxy with `--settings-file` and drop the `env` block:

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy@latest", "--settings-file", "/absolute/path/to/danske-proxy.env"],
    },
  },
}
```

- This is the same entry in VS Code (`.copilot/mcp-config.json`, with the `"type"` and `"tools"` lines from Step 3) and in Claude Desktop (without them). For Claude Code, run `claude mcp add danske-bank-apis -- npx -y @danskebank/mcp-api-proxy@latest --settings-file /absolute/path/to/danske-proxy.env`. In HTTP mode, start the proxy with `npx -y @danskebank/mcp-api-proxy@latest --transport http --settings-file /absolute/path/to/danske-proxy.env`.
- Use an absolute path (a leading `~/` also works). The proxy stops with an error if the file is missing, and it never logs the values.
- Quote values that contain `#` or spaces, e.g. `CLIENT_KEY_PASSPHRASE="p#ss phrase"`.
- Values in an `env` block still win over the file.
- Make the file readable only by you, and never commit it.

### VS Code input prompts

VS Code's masked `${input:...}` prompts (`"type": "promptString"` with `"password": true`) work only in the older VS Code format (`servers` in `.vscode/mcp.json` or the user-profile `mcp.json`), which VS Code now labels deprecated. Servers that need them are not forwarded to Copilot sessions, and the portable `mcpServers` files, such as `.copilot/mcp-config.json`, do not support them. Use a settings file instead. See VS Code's [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#_authentication-and-secrets).

---

## Troubleshooting

| Problem                                | What to try                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `node --version` fails                 | Node.js is not installed or not on your `PATH` — see Step 1                            |
| The server does not appear under Tools | Check the config file path and syntax (VS Code: `.copilot/mcp-config.json` in your home folder, top-level `mcpServers`), then restart your AI client |
| Nothing happens on the first start     | `npx` downloads the proxy the first time: check network access to the npm registry, wait a little, and check that `npx` is on the `PATH` your client uses (it comes with Node.js) |
| `Cannot find module`                   | Make sure the `args` start with `-y` and `@danskebank/mcp-api-proxy@latest`, or re-run `npm install -g @danskebank/mcp-api-proxy` if you use the global install |
| No tools / discovery unavailable       | Look for `[auth]`, `[rate_limited]` or `[upstream]` in the proxy log: `MCP_SERVER_API_KEY` is missing or was rejected (fix the key and restart), there were too many invalid key attempts (wait a few minutes, then restart), or the hosted server could not verify the key right now (try again later, then restart). Otherwise check network access to `https://mcp.danskebank.com/mcp` and inspect the proxy log for an upstream connection error |
| `401` on API calls                     | Verify `CLIENT_ID`, the certificate/key pair, and that your client is registered for the API's product (`accounts` or `payments`). The proxy requests both scopes by default; if your client is registered for only one, set `TOKEN_SCOPE` (for example `TOKEN_SCOPE=accounts`) and restart. |
| `[auth]` token error                   | Check the credential files and client ID. If the message says the token request was rejected, your client may be registered for fewer products than the default scopes: set `TOKEN_SCOPE` (for example `TOKEN_SCOPE=accounts`) and restart. Invalid token responses name the tier and invalid fields, not their values; see [token response validation](README.md#oauth-token-response-validation). The token response body is hidden. |
| `[upstream]` request error             | Check connectivity and the upstream settings. Raw upstream error text is intentionally hidden. |
| `[configuration]` startup error        | Check the named setting or file path locally; invalid values and stack traces are intentionally not printed. |
| `ENOENT` for a PEM file                | Use an absolute path, and check the file is readable by the user running the client    |
| `Cannot read the settings file`        | Check the path after `--settings-file`; use an absolute path                           |
| Requests rejected in production        | Production allows `GET` only                                                            |

An MCP tool call completing is not proof that the API succeeded. Check the
returned `tier`, HTTP status and expected body; API `400+` responses set `isError`
and include a category, retry advisory and next step while preserving the API
response. The same result is available as typed `structuredContent` with an
advertised output schema and as the existing JSON text for older clients.
See [Error reporting](README.md#error-reporting). Never automatically
replay a non-GET request after an error.

---

## Getting help

Default audit logs mask all URL path segments and query values; see [Audit Logging](README.md#audit-logging). Do not include credentials or raw API data when sharing diagnostics.

- API questions and credentials: [Danske Bank Developer Portal](https://developers.danskebank.com)
- Bugs in this proxy: report them through the [contact page](https://developers.danskebank.com/premium-apis/contact-us)

Include your installed package version (`npm list -g @danskebank/mcp-api-proxy --depth=0`
for a global install), Node.js version, transport, environment/tier, safe error
category and redacted reproduction steps. See
[Release notes and feedback](README.md#release-notes-and-feedback).
