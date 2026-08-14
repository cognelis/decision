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

  it("maps malformed JSON and provider statuses without leaking diagnostics", async () => {
    const invalidUrl = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end("{not-json");
    });
    await expect(
      new HttpModelTransport().postJson({
        url: invalidUrl,
        headers: {},
        body: {},
        timeoutMs: 100,
        maximumResponseBytes: 100,
        secrets: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_output" });

    for (const [status, code] of [
      [401, "authentication_failed"],
      [429, "rate_limited"],
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
