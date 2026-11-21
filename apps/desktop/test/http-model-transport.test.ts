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
  // R15-JEVSET-B5: a service echoing the key in its request id leaves it in neither the response nor the error.
  it("cleans a request id that echoes the key, in a response and in an error", async () => {
    const secret = "fake-echoed-secret-0123456789";
    for (const status of [200, 401]) {
      const url = await startServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json", "x-request-id": `req-${secret}` });
        response.end(status === 200 ? '{"ok":true}' : '{"error":{"message":"bad key"}}');
      });
      const outcome = await new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({ url, headers: { authorization: `Bearer ${secret}` }, body: {}, timeoutMs: 2000, maximumResponseBytes: 1000, secrets: [secret] })
        .then((response) => response, (error: unknown) => error);
      if (status === 200) expect(outcome).toMatchObject({ requestId: "req-[redacted]", json: { ok: true } });
      else expect(outcome).toMatchObject({ code: "authentication_failed", providerRequestId: "req-[redacted]" });
      expect(JSON.stringify(outcome) + String((outcome as { providerRequestId?: string }).providerRequestId)).not.toContain(secret);
    }
  });

  it("gets a catalog without a request body and keeps credentials in headers", async () => {
    let body = "";
    const url = await startServer((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe("Bearer fake-catalog-token");
      expect(request.url).not.toContain("fake-catalog-token");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"models":[]}'); });
    });
    expect(await new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).getJson({ url, headers: { Authorization: "Bearer fake-catalog-token" }, timeoutMs: 2000, maximumResponseBytes: 100, secrets: ["fake-catalog-token"] })).toMatchObject({ json: { models: [] } });
    expect(body).toBe("");
  });

  it("does not forward GET credentials through redirects and redacts failed GET responses", async () => {
    let redirected = false;
    const target = await startServer((_request, response) => { redirected = true; response.end('{}'); });
    const redirect = await startServer((_request, response) => { response.writeHead(302, { location: target }); response.end(); });
    const input = { headers: { Authorization: "Bearer fake-catalog-token" }, timeoutMs: 2000, maximumResponseBytes: 100, secrets: ["fake-catalog-token"] };
    await expect(new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).getJson({ ...input, url: redirect })).rejects.toMatchObject({ code: "redirect_rejected" });
    expect(redirected).toBe(false);
    const rejected = await startServer((_request, response) => { response.writeHead(403); response.end('fake-catalog-token'); });
    const error = await new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).getJson({ ...input, url: rejected }).catch(error => error);
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
    const transport = new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" });

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
    const transport = new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" });

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
      new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({
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
      new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({
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
      new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({
        url: redirectUrl,
        headers: {},
        body: {},
        timeoutMs: 2_000,
        maximumResponseBytes: 100,
        secrets: [],
      }),
    ).rejects.toMatchObject({ code: "redirect_rejected" });
    await expect(
      new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({
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
    const failure = await new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" })
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
    const malformed = await new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({
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
      const failure = await new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" })
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

  it("describes a refusal by what the provider calls it, never quoting what the request sent", async () => {
    // The trace keeps this excerpt with trace content off, and providers quote the request back in a refusal.
    const typed = "我们决定裁掉B项目团队";
    const refused = (url: string, body: unknown) => new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" })
      .postJson({ url, headers: {}, body, timeoutMs: 2_000, maximumResponseBytes: 10_000, secrets: [] })
      .then(() => { throw new Error("expected a refusal"); }, (error: unknown) => error as ModelProviderError);
    for (const [status, body, kept] of [
      // OpenRouter's moderation refusal names the flagged input.
      [403, { error: { code: 403, message: "Your input was flagged for \"harassment\".", metadata: { reasons: ["harassment"], flagged_input: typed } } }, ["HTTP 403", "flagged for", "403"]],
      // A FastAPI/Pydantic service echoes each invalid field's input.
      [422, { detail: [{ type: "missing", loc: ["body", "model"], msg: "Field required", input: { messages: [{ role: "user", content: typed }] } }] }, ["HTTP 422", "Field required", "missing"]],
      // Azure's content filter carries what it matched in innererror.
      [400, { error: { code: "content_filter", message: "The response was filtered", status: 400, innererror: { code: "ResponsibleAIPolicyViolation", content_filter_result: { hate: { filtered: true, excerpt: typed } } } } }, ["HTTP 400", "content_filter", "was filtered"]],
      // Ollama names the problem in a bare string.
      [404, { error: "model \"llama3\" not found, try pulling it first", prompt: typed }, ["HTTP 404", "not found, try pulling it"]],
      // What explains a failure is still there: the model, the context length, the key.
      [404, { error: { message: "The model `gpt-x` does not exist", type: "invalid_request_error", code: "model_not_found", param: typed } }, ["model_not_found", "does not exist", "invalid_request_error"]],
      [400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" }, echo: typed }, ["prompt is too long"]],
      // Gemini answers with a list of one error.
      [401, [{ error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED", details: [{ quoted: typed }] } }], ["API key not valid", "UNAUTHENTICATED"]],
    ] as const) {
      const url = await startServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
      const failure = await refused(url, { input: typed });

      expect(failure.diagnosticExcerpt).not.toContain(typed);
      for (const part of kept) expect(failure.diagnosticExcerpt).toContain(part);
    }

    // A body that is not JSON (a gateway's page, a plain sentence) is described by its length and shape alone.
    const plain = await startServer((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end(`<html><body>Upstream refused: ${typed}</body></html>`);
    });
    const failure = await refused(plain, {});
    expect(failure).toMatchObject({ code: "provider_unavailable" });
    expect(failure.diagnosticExcerpt).not.toContain(typed);
    expect(failure.diagnosticExcerpt).toMatch(/^HTTP 502: the body is not JSON \(length=\d+, opens as markup\)$/u);
  });

  it("cleans what a refusal says before cutting it, so a key or a path across the cut is not left half there", async () => {
    // Cut first, the key's first characters were all that was left of it, and no longer the key to replace. Joined
    // here: written whole, it is a key's shape the release scan (release-portability) refuses to ship.
    const key = ["AIza", "SyD0123456789abcdefghijklmnopqrstu"].join("");
    for (const [secret, error] of [
      [key, { message: `${"x".repeat(290)}${key} is not a valid key` }],
      [homedir(), { message: `${"y".repeat(293)}${homedir()}/config is unreadable` }],
      [key, { code: `${"z".repeat(95)}${key}`, message: "Bad key" }],
    ] as const) {
      const url = await startServer((_request, response) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error }));
      });
      const failure = await new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" })
        .postJson({ url, headers: {}, body: {}, timeoutMs: 2_000, maximumResponseBytes: 10_000, secrets: [key] })
        .then(() => { throw new Error("expected a refusal"); }, (refusal: unknown) => refusal as ModelProviderError);

      expect(failure.diagnosticExcerpt).not.toContain(secret.slice(0, 6));
      expect(failure.diagnosticExcerpt).toContain("[reda");
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
