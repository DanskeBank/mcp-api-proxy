import { describe, expect, it } from "vitest";
import {
  createListenerHostCheck,
  isLoopbackListenHost,
  parseHttpListenOptions,
} from "../src/cli-options.js";

describe("parseHttpListenOptions", () => {
  it("defaults to loopback on port 3001", () => {
    expect(parseHttpListenOptions(["node", "proxy", "--transport", "http"])).toEqual({
      port: 3001,
      host: "127.0.0.1",
    });
  });

  it.each([
    [["--port", "8080"], 8080, "127.0.0.1"],
    [["--port=8080"], 8080, "127.0.0.1"],
    [["--host", "0.0.0.0"], 3001, "0.0.0.0"],
    [["--host=::1", "--port", "65535"], 65535, "::1"],
    [["--port", "1", "--host", "localhost"], 1, "localhost"],
  ])("reads %j", (flags, port, host) => {
    expect(parseHttpListenOptions(["node", "proxy", ...flags])).toEqual({ port, host });
  });

  it.each(["0", "65536", "-1", "80abc", "1e3", "0x50", " 80", "8.5", "not-a-port", "00000000000000000000070000"])(
    "rejects --port %j without echoing it",
    (value) => {
      let message = "";
      try {
        parseHttpListenOptions(["--port", value]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe(
        "[configuration]: Invalid --port. Must be an integer between 1 and 65535.",
      );
    },
  );

  it.each([
    [["--port"], "--port needs a value, e.g. --port 3001"],
    [["--port="], "--port needs a value"],
    [["--port", "--host", "127.0.0.1"], "--port needs a value"],
    [["--host"], "--host needs a value, e.g. --host 127.0.0.1"],
    [["--host="], "--host needs a value"],
    [["--host", "--port", "8080"], "--host needs a value"],
  ])("rejects a missing value (%j)", (flags, message) => {
    expect(() => parseHttpListenOptions(flags)).toThrow(message);
  });

  it("does not mistake flags that merely start with the same letters", () => {
    expect(parseHttpListenOptions(["--portable", "x", "--hostile", "y"])).toEqual({
      port: 3001,
      host: "127.0.0.1",
    });
  });
});

describe("isLoopbackListenHost", () => {
  it.each(["127.0.0.1", "localhost", "LOCALHOST", "::1"])("treats %j as loopback", (host) => {
    expect(isLoopbackListenHost(host)).toBe(true);
  });

  it.each(["0.0.0.0", "::", "192.0.2.10", "127.0.0.2", "[::1]", "my-host.example", ""])(
    "does not treat %j as loopback",
    (host) => {
      expect(isLoopbackListenHost(host)).toBe(false);
    },
  );
});

describe("createListenerHostCheck", () => {
  it("holds a loopback listener to loopback host names", () => {
    const isAllowed = createListenerHostCheck("127.0.0.1", 3001);
    expect(isAllowed("localhost:3001")).toBe(true);
    expect(isAllowed("evil.example:3001")).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });

  it.each(["0.0.0.0", "::", "my-host.example"])(
    "accepts any Host header on a listener bound to %j, which is reached under other names",
    (host) => {
      const isAllowed = createListenerHostCheck(host, 3001);
      expect(isAllowed("proxy.internal:3001")).toBe(true);
      expect(isAllowed(undefined)).toBe(true);
    },
  );
});
