## Changes

- Require Node.js 22.13.0 or newer within 22.x, or Node.js 24 or newer,
  covering both runtime and development dependencies.
- Update the MCP SDK, HTTP client, matched test/coverage tools and affected
  transitive packages to resolve the reported dependency advisories.
- Advertise the installed package version in both MCP server and upstream
  client initialization, including prerelease identifiers.
- Remove the internal export command from package scripts.
- Keep curated release notes with known limits and feedback guidance.
- Replace the checked-in personal VS Code MCP configuration with a portable
  example; local settings remain private.

## Known limits

- Catalog discovery requires an available hosted MCP server and, where
  enabled, an authorized MCP API key.
- Calling bank APIs requires the appropriate API access and credentials;
  catalog visibility does not grant API entitlement.
- One HTTP proxy process shares its configured bank credentials across its
  sessions. Use separate instances for separate bank tenants.
- Live API calls are GET-only. Discovery and mock checks do not verify
  customer mTLS/OAuth access or live API behavior.
- This package does not include client credentials or a private CA bundle.

## Feedback

Report proxy issues through:
https://developers.danskebank.com/premium-apis/contact-us

Include the installed package version, Node.js version, transport, runtime
environment/tier, a safe error category and redacted reproduction steps.
Never include credentials, unredacted API data or private settings files.
