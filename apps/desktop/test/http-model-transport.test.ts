import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  HttpModelTransport,
  ModelProviderError,
  providerEndpoint,
} from "../src/main/model/http-model-transport.js";

const servers: Server[] = [];

const startServer = async (
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void,
): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind TCP");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("HttpModelTransport", () => {
  it("gets a catalog without a request body and keeps credentials in headers", async () => {
    let body = "";
    const url = await startServer((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe("Bearer fake-catalog-token");
      expect(request.url).not.toContain("fake-catalog-token");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"models":[]}'); });
    });
    expect(await new HttpModelTransport().getJson({ url, headers: { Authorization: "Bearer fake-catalog-token" }, timeoutMs: 2000, maximumResponseBytes: 100, secrets: ["fake-catalog-token"] })).toMatchObject({ json: { models: [] } });
    expect(body).toBe("");
  });

  it("does not forward GET credentials through redirects and redacts failed GET responses", async () => {
    let redirected = false;
    const target = await startServer((_request, response) => { redirected = true; response.end('{}'); });
    const redirect = await startServer((_request, response) => { response.writeHead(302, { location: target }); response.end(); });
    const input = { headers: { Authorization: "Bearer fake-catalog-token" }, timeoutMs: 2000, maximumResponseBytes: 100, secrets: ["fake-catalog-token"] };
    await expect(new HttpModelTransport().getJson({ ...input, url: redirect })).rejects.toMatchObject({ code: "redirect_rejected" });
    expect(redirected).toBe(false);
    const rejected = await startServer((_request, response) => { response.writeHead(403); response.end('fake-catalog-token'); });
    const error = await new HttpModelTransport().getJson({ ...input, url: rejected }).catch(error => error);
    expect(error.code).toBe("authorization_failed");
    expect(error.diagnosticExcerpt).not.toContain("fake-catalog-token");
  });

  it("posts bounded JSON to loopback and returns request metadata", async () => {
    let received = "";
    const url = await startServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        received += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": "request-1",
        });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const transport = new HttpModelTransport();

    const result = await transport.postJson({
      url: `${url}/v1/responses`,
      headers: {
        authorization: "Bearer sk-secret",
        "content-type": "application/json",
      },
      body: { model: "test", input: "hello" },
      timeoutMs: 2_000,
      maximumResponseBytes: 1_048_576,
      secrets: ["sk-secret"],
    });

    expect(JSON.parse(received)).toEqual({
      model: "test",
      input: "hello",
    });
    expect(result).toMatchObject({
      status: 200,
      requestId: "request-1",
      json: { ok: true },
    });
  });

  it("reaches a loopback endpoint directly, never through a proxy the key would pass through", async () => {
    const url = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    // A proxy nothing listens on: a request sent through it fails.
    const transport = new HttpModelTransport({ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" });

    for (const proxy of [undefined, { mode: "custom" as const, url: "http://127.0.0.1:9" }]) {
      await expect(
        transport.postJson({
          url: `${url}/v1/responses`,
          headers: { authorization: "Bearer sk-secret", "content-type": "application/json" },
          body: {},
          timeoutMs: 2_000,
          maximumResponseBytes: 1_048_576,
          secrets: ["sk-secret"],
          ...(proxy === undefined ? {} : { proxy }),
        }),
      ).resolves.toMatchObject({ status: 200 });
    }
  });

  it("rejects timeout, oversized responses, redirects, and insecure remote HTTP", async () => {
    const timeoutUrl = await startServer(() => undefined);
    await expect(
      new HttpModelTransport().postJson({
        url: timeoutUrl,
        headers: {},
        body: {},
        timeoutMs: 10,
        maximumResponseBytes: 100,
        secrets: [],
      }),
    ).rejects.toMatchObject({ code: "timeout" });

    const oversizedUrl = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ value: "x".repeat(500) }));
    });
    await expect(
      new HttpModelTransport().postJson({
        url: oversizedUrl,
        headers: {},
        body: {},
        timeoutMs: 2_000,
        maximumResponseBytes: 50,
        secrets: [],
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });

    const redirectUrl = await startServer((_request, response) => {
      response.writeHead(307, {
        location: "https://example.com/elsewhere",
      });
      response.end();
    });
    await expect(
      new HttpModelTransport().postJson({
        url: redirectUrl,
        headers: {},
        body: {},
        timeoutMs: 2_000,
        maximumResponseBytes: 100,
        secrets: [],
      }),
    ).rejects.toMatchObject({ code: "redirect_rejected" });
    await expect(
      new HttpModelTransport().postJson({
        url: "http://api.example.com/v1/responses",
        headers: {},
        body: {},
        timeoutMs: 2_000,
        maximumResponseBytes: 100,
        secrets: [],
      }),
    ).rejects.toThrow(/HTTPS|loopback/u);
  });

  it("says why a request could not be made, not only that fetch failed", async () => {
    // A port nothing listens on: a proxy port typed wrong, say.
    const server = await startServer(() => undefined);
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    const failure = await new HttpModelTransport()
      .postJson({ url: server, headers: {}, body: {}, timeoutMs: 2_000, maximumResponseBytes: 100, secrets: [] })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "network_error" });
    expect((failure as ModelProviderError).diagnosticExcerpt).toContain("ECONNREFUSED");
  });

  it("maps malformed JSON and provider statuses without leaking diagnostics", async () => {
    const invalidUrl = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end("{not-json");
    });
    const malformed = await new HttpModelTransport().postJson({
      url: invalidUrl,
      headers: {},
      body: {},
      timeoutMs: 100,
      maximumResponseBytes: 100,
      secrets: [],
    }).catch((error: unknown) => error);
    expect(malformed).toMatchObject({ code: "invalid_output" });
    // A 200 body is the model's output: the excerpt says what it looked like, not what it said.
    expect((malformed as ModelProviderError).diagnosticExcerpt).not.toContain("not-json");
    expect((malformed as ModelProviderError).diagnosticExcerpt).toContain("length=9");

    for (const [status, code] of [
      [401, "authentication_failed"],
      [429, "rate_limited"],
      // No such address or model: the configuration, not the answer.
      [404, "invalid_configuration"],
      // A refused request was never output: a wrong model name or parameter, a prompt too long.
      [400, "invalid_configuration"],
      [422, "invalid_configuration"],
      // Out of credit: only a top-up fixes it.
      [402, "quota_exhausted"],
    ] as const) {
      const secret = "sk-super-private";
      const temporaryPath = "/private/tmp/model-provider-private";
      const errorUrl = await startServer((_request, response) => {
        response.writeHead(status, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: `${secret} ${homedir()} ${temporaryPath}`,
          }),
        );
      });
      const failure = await new HttpModelTransport()
        .postJson({
          url: errorUrl,
          headers: { authorization: `Bearer ${secret}` },
          body: {},
          timeoutMs: 2_000,
          maximumResponseBytes: 1_000,
          secrets: [secret],
          sensitivePaths: [temporaryPath],
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelProviderError);
      if (!(failure instanceof ModelProviderError)) {
        throw new Error("Expected ModelProviderError");
      }
      expect(failure).toMatchObject({ code });
      expect(failure.diagnosticExcerpt).not.toContain(secret);
      expect(failure.diagnosticExcerpt).not.toContain(homedir());
      expect(failure.diagnosticExcerpt).not.toContain(temporaryPath);
    }
  });
});

describe("providerEndpoint", () => {
  it("keeps a version the base URL already names, and adds /v1 to one without", () => {
    for (const [base, path, expected] of [
      ["https://api.openai.com", "/chat/completions", "https://api.openai.com/v1/chat/completions"],
      ["https://api.openai.com/", "/responses", "https://api.openai.com/v1/responses"],
      ["https://api.moonshot.cn/v1", "/chat/completions", "https://api.moonshot.cn/v1/chat/completions"],
      ["http://localhost:1234/v1/", "/chat/completions", "http://localhost:1234/v1/chat/completions"],
      ["https://open.bigmodel.cn/api/paas/v4", "/chat/completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
      ["https://generativelanguage.googleapis.com/v1beta/openai", "/chat/completions",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
      ["https://api.anthropic.com", "/messages", "https://api.anthropic.com/v1/messages"],
      // A host that merely looks like a version is not one.
      ["https://v1.example.com", "/messages", "https://v1.example.com/v1/messages"],
      // A query the service wants on every call stays at the end, after the path.
      ["https://gateway.example.com/v1?key=abc", "/chat/completions", "https://gateway.example.com/v1/chat/completions?key=abc"],
      ["https://gateway.example.com/?team=a", "/messages", "https://gateway.example.com/v1/messages?team=a"],
    ] as const) {
      expect(providerEndpoint(base, path)).toBe(expected);
    }
  });
});
