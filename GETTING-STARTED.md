# Getting Started with the Danske Bank MCP API Proxy

> **Audience**: Users who just want to *use* the published
> `@danskebank/mcp-api-proxy` package to call Danske Bank APIs from an AI assistant —
> no cloning or building required. If you want to customize the proxy or build it
> from source yourself, see [README.md](README.md) instead.

This guide gets you from nothing to chatting with an AI assistant about Danske Bank APIs. You will:

1. [Install the prerequisites](#step-1--prerequisites)
2. [Install the proxy](#step-2--install-the-proxy)
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

## Step 2 — Install the proxy

Open a terminal:

- In Visual Studio Code: menu bar **Terminal > New Terminal**.
- On Windows: the **Command Prompt** or **PowerShell** app.
- On macOS: the **Terminal** app (in Applications > Utilities).

Then type or paste the following command and press Enter:

```bash
npm install -g @danskebank/mcp-api-proxy
```

This installs the `danske-mcp-proxy` command. To avoid a global install, you can skip this step entirely and use `npx @danskebank/mcp-api-proxy` in the configuration below instead — your AI client will download and run it automatically, no terminal needed.

---

## Step 3 — Connect your AI client

Get your key from the [MCP API-key page](https://developers.danskebank.com/mcp/apikey),
then replace `your-mcp-api-key` in the examples with it.
The hosted catalog cannot be reached without a valid key. Never commit
configuration containing the real key.

### Visual Studio Code

Run **MCP: Add Server** from the Command Palette and choose **Command (stdio)**.
For the VS Code-specific format below, use `.vscode/mcp.json` in your project,
or run **MCP: Open User Configuration** for the VS Code user-profile `mcp.json`.
Do not paste an `mcp` wrapper into general user settings. Portable configurations
use a different root key; see the [VS Code MCP configuration guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

```jsonc
{
  "servers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
      },
    },
  },
}
```

Then open the Chat view, switch the mode selector to **Agent**, and confirm `danske-bank-apis` appears under **Tools**.

### Claude Desktop

Add to your config file — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
      },
    },
  },
}
```

Restart Claude Desktop afterwards.

### Any other client (HTTP)

Use an explicit settings file to keep credentials out of the shell command.
Put the following in a file outside your project, such as `danske-proxy.env`:

```bash
MCP_SERVER_API_KEY=your-mcp-api-key
```

Then start the proxy with that file:

```bash
danske-mcp-proxy --transport http --settings-file /absolute/path/to/danske-proxy.env
```

Point your client at `http://127.0.0.1:3001/mcp`.

One HTTP proxy uses one bank credential set and OAuth scope for all callers.
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
  "servers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy"],
      "env": {
        "MCP_SERVER_API_KEY": "your-mcp-api-key",
        "CLIENT_ID": "your-client-id",
        "CLIENT_CERT_PEM": "/absolute/path/to/client-cert.pem",
        "CLIENT_KEY_PEM": "/absolute/path/to/client-key.pem",
        // Only if your key is encrypted:
        // "CLIENT_KEY_PASSPHRASE": "…",
        "TOKEN_SCOPE": "accounts",
      },
    },
  },
}
```

Notes:

- Use **absolute paths** for the PEM files.
- Certificate files must contain a `-----BEGIN CERTIFICATE-----` block; key files a `-----BEGIN PRIVATE KEY-----` block.
- `TOKEN_SCOPE` selects one Premium API product per process. Restart with a different scope to use another. A returned `scope` does not override this setting; see [token response validation](README.md#oauth-token-response-validation).
- The **Payment Collection API** has its own token endpoint: also set `SANDBOX_TOKEN_URL` and `LIVE_TOKEN_URL` as listed in the [README](README.md#token-url-defaults). If you use other Premium APIs too, put it in a separate proxy entry with a name that says so, such as `danske-payment-collection`.
- Values in the `env` block end up in your client's config file. To keep them out of it, use a settings file with `--settings-file` (Step 6).
- Without `--settings-file`, the proxy also reads a `.env` file from its working directory, which your client chooses. VS Code uses your workspace folder, so a `.env` in your project is read too (values in the `env` block win). Pass `--settings-file` to choose the file yourself.
- Production is **GET-only** in this proxy as a safety guard.
- Check stderr startup output for `enabled-tiers` and `default-tier`. Partial OAuth/mTLS settings list missing variable names without exposing values; leaving all OAuth/mTLS settings unset is a valid mock/discovery-only setup. The hosted MCP server API key is still required for discovery.
- The default remains live when its host and credentials are complete, otherwise sandbox, otherwise mock. Adding live credentials can make omitted-tier calls use real data; specify `tier` per call to choose explicitly.
- Request bodies are limited to 1 MiB of serialized UTF-8, and API responses to 10 MiB. JSON and `application/*+json` responses are parsed; malformed JSON remains raw text ([details](README.md#call_endpoint)).

See the [README](README.md) for the full list of environment variables and for embedding the proxy in your own service.

---

## Step 6 — Keep secrets out of your config file (optional)

Secrets such as `MCP_SERVER_API_KEY` and `CLIENT_KEY_PASSPHRASE` from Step 5
sit in plain text if you put them directly in your client's config file.
There are two ways to avoid that.

### Option A: a settings file (any client)

Put the settings in a file outside your project, for example `danske-proxy.env` in your home folder:

```bash
MCP_SERVER_API_KEY=your-mcp-api-key
CLIENT_ID=your-client-id
CLIENT_CERT_PEM=/absolute/path/to/client-cert.pem
CLIENT_KEY_PEM=/absolute/path/to/client-key.pem
# CLIENT_KEY_PASSPHRASE=…
TOKEN_SCOPE=accounts
```

Then pass the file to the proxy with `--settings-file` and drop the `env` block:

```jsonc
{
  "servers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy", "--settings-file", "/absolute/path/to/danske-proxy.env"],
    },
  },
}
```

- Claude Desktop uses the same `args`, under `mcpServers` instead of `servers`. In HTTP mode, start the proxy with `danske-mcp-proxy --transport http --settings-file /absolute/path/to/danske-proxy.env`.
- Use an absolute path (a leading `~/` also works). The proxy stops with an error if the file is missing, and it never logs the values.
- Quote values that contain `#` or spaces, e.g. `CLIENT_KEY_PASSPHRASE="p#ss phrase"`.
- Values in an `env` block still win over the file.
- Make the file readable only by you, and never commit it.

### Option B: VS Code input prompts

VS Code can prompt for the MCP server API key instead of putting it in plain
text. This example also prompts for the passphrase of an encrypted client
private key for sandbox/live calls. Each `inputs` entry is referenced with
`${input:<id>}`:

```jsonc
{
  "servers": {
    "danske-bank-apis": {
      "command": "npx",
      "args": ["-y", "@danskebank/mcp-api-proxy"],
      "env": {
        "MCP_SERVER_API_KEY": "${input:mcpApiKey}",
        "CLIENT_ID": "your-client-id",
        "CLIENT_CERT_PEM": "/absolute/path/to/client-cert.pem",
        "CLIENT_KEY_PEM": "/absolute/path/to/client-key.pem",
        "CLIENT_KEY_PASSPHRASE": "${input:keyPassphrase}",
        "TOKEN_SCOPE": "accounts",
      },
    },
  },
  "inputs": [
    {
      "id": "mcpApiKey",
      "type": "promptString",
      "description": "Danske Bank MCP server API key",
      "password": true,
    },
    {
      "id": "keyPassphrase",
      "type": "promptString",
      "description": "Passphrase for CLIENT_KEY_PEM",
      "password": true,
    },
  ],
}
```

With `"password": true` the input box is masked while you type.

**Can it prompt every time instead of storing the value?** Not directly. The first time you start the server, VS Code asks once and then keeps the value in your OS's secure credential store (Keychain / Credential Manager / libsecret) — never in `mcp.json` and never in plain text — reusing it on later starts. There's no setting to force a fresh prompt every single start. To make it ask again (for example, after rotating the API key or changing the passphrase), run **MCP: Reset Cached Tools / Inputs** from the Command Palette and restart the server.

This `inputs` mechanism is specific to VS Code's `mcp.json`. For Claude Desktop and HTTP mode, use a settings file (Option A).

---

## Troubleshooting

| Problem                                | What to try                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `node --version` fails                 | Node.js is not installed or not on your `PATH` — see Step 1                            |
| The server does not appear under Tools | Check the config file path and syntax, then restart your AI client                     |
| `Cannot find module`                   | Re-run `npm install -g @danskebank/mcp-api-proxy`, or use the `npx` form above          |
| No tools / discovery unavailable       | Verify `MCP_SERVER_API_KEY` is set to a valid key, check network access to `https://mcp.danskebank.com/mcp`, and inspect the proxy log for an upstream connection error |
| `401` on API calls                     | Verify `CLIENT_ID`, the certificate/key pair, and that `TOKEN_SCOPE` matches your product. Payment Collection API: also set its token URLs ([README](README.md#token-url-defaults)) |
| `[auth]` token error                   | Check the credential files, client ID, scope and token URL. Invalid token responses name the tier and invalid fields, not their values; see [token response validation](README.md#oauth-token-response-validation). The token response body is hidden. |
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
- Bugs in this proxy: report them at the [Danske Bank Developer Portal](https://developers.danskebank.com)

Include your installed package version (`npm list -g @danskebank/mcp-api-proxy --depth=0`
for a global install), Node.js version, transport, environment/tier, safe error
category and redacted reproduction steps. See
[Release notes and feedback](README.md#release-notes-and-feedback).
