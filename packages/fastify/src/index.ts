// oxlint-disable-next-line import/no-nodejs-modules -- This package intentionally targets Node.js.
import { Buffer } from "node:buffer";

import { problemResponse } from "@github-app-token-broker/http/problem-details";
import {
  maxTokenExchangeBodyBytes,
  createTokenExchangeLifetime,
  tokenExchangeInvalidRequestResponse,
  tokenExchangeUnavailableResponse,
  type GitHubAppTokenExchangeHandler,
  type TokenExchangeRequestContext,
  type TokenExchangeObservation,
} from "@github-app-token-broker/token-exchange";
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

export interface GitHubAppTokenExchangePluginOptions {
  readonly tokenExchange: GitHubAppTokenExchangeHandler;
}

export const githubAppTokenExchangePlugin: FastifyPluginAsync<
  GitHubAppTokenExchangePluginOptions
> = async (fastify, options) => {
  const tokenEndpointPaths = new Set(options.tokenExchange.tokenEndpointPaths);
  const lifetimes = new WeakMap<FastifyRequest, FastifyTokenExchangeLifetime>();
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  fastify.setErrorHandler<FastifyError>(async (error, request, reply) => {
    const lifetime = lifetimes.get(request);
    if (lifetime?.responseStarted === true || reply.sent || reply.raw.destroyed) return;
    if (lifetime !== undefined) {
      lifetime.responseStarted = true;
      lifetime.dispose();
    }
    if (lifetime?.signal.aborted === true) {
      await sendWebResponse(reply, tokenExchangeUnavailableResponse());
      return;
    }
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

    switch (code) {
      case "FST_ERR_CTP_BODY_TOO_LARGE":
        await sendWebResponse(reply, tokenExchangeInvalidRequestResponse(413));
        return;
      case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
      case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
        await sendWebResponse(reply, tokenExchangeInvalidRequestResponse(400));
        return;
      default:
        throw error;
    }
  });

  fastify.all(
    "/github/apps/:app_slug/token",
    {
      bodyLimit: maxTokenExchangeBodyBytes,
      async onRequest(request, reply) {
        const url = tokenExchangeRequestUrl(request, fastify.prefix);
        // App selection precedes Fetch method validation and Fastify body parsing.
        if (url !== null && !tokenEndpointPaths.has(url.pathname)) {
          await sendWebResponse(reply, problemResponse(404));
          return;
        }
        if (fastifyRequestToWebRequest(request, url) === null) {
          await sendWebResponse(reply, tokenExchangeInvalidRequestResponse(400));
          return;
        }
        lifetimes.set(request, startFastifyTokenExchangeLifetime(request, reply));
      },
    },
    async (request, reply) => {
      const lifetime = lifetimes.get(request);
      if (lifetime?.responseStarted === true || reply.sent || reply.raw.destroyed) return;
      if (lifetime !== undefined) lifetime.handlerStarted = true;
      try {
        if (lifetime?.signal.aborted === true) {
          await sendWebResponse(reply, tokenExchangeUnavailableResponse());
          return;
        }
        const webRequest = fastifyRequestToWebRequest(
          request,
          tokenExchangeRequestUrl(request, fastify.prefix),
          lifetime?.signal,
        );

        if (webRequest === null) {
          await sendWebResponse(reply, tokenExchangeInvalidRequestResponse(400));
          return;
        }

        const response = await options.tokenExchange(webRequest, tokenExchangeContext(request));

        if (!reply.raw.destroyed) await sendWebResponse(reply, response);
      } finally {
        lifetime?.dispose();
        lifetimes.delete(request);
      }
    },
  );
};

interface FastifyTokenExchangeLifetime {
  readonly signal: AbortSignal;
  handlerStarted: boolean;
  responseStarted: boolean;
  dispose(): void;
}

function startFastifyTokenExchangeLifetime(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyTokenExchangeLifetime {
  const disconnect = new AbortController();
  const lifetime = createTokenExchangeLifetime(disconnect.signal);
  let disconnected = false;
  let disposed = false;
  const onFinished = () => {
    if (state.responseStarted && !request.raw.complete) request.raw.destroy();
    state.dispose();
  };
  const onDisconnect = () => {
    disconnected = true;
    disconnect.abort();
  };
  const onClose = () => {
    // IncomingMessage close also occurs on healthy request completion; response close does not.
    if (!reply.raw.writableFinished) onDisconnect();
    state.dispose();
  };
  const onCancelled = () => {
    if (
      state.handlerStarted ||
      state.responseStarted ||
      disconnected ||
      reply.sent ||
      reply.raw.destroyed
    )
      return;
    state.responseStarted = true;
    reply.header("connection", "close");
    void sendWebResponse(reply, tokenExchangeUnavailableResponse()).catch(() =>
      reply.raw.destroy(),
    );
  };
  const state: FastifyTokenExchangeLifetime = {
    signal: lifetime.signal,
    handlerStarted: false,
    responseStarted: false,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.dispose();
      request.raw.removeListener("aborted", onDisconnect);
      reply.raw.removeListener("close", onClose);
      reply.raw.removeListener("finish", onFinished);
      lifetime.signal.removeEventListener("abort", onCancelled);
    },
  };
  request.raw.once("aborted", onDisconnect);
  reply.raw.once("close", onClose);
  reply.raw.once("finish", onFinished);
  lifetime.signal.addEventListener("abort", onCancelled, { once: true });
  if (request.raw.aborted || reply.raw.destroyed) onDisconnect();
  return state;
}

function tokenExchangeContext(request: FastifyRequest): TokenExchangeRequestContext {
  return {
    async observe(observation) {
      logObservation(request, observation);
    },
    observeOidcDiagnostic(observation) {
      try {
        logObservation(request, observation);
      } catch {
        // Optional OIDC diagnostics never control Token Exchange outcomes.
      }
      return undefined;
    },
  };
}

function logObservation(request: FastifyRequest, observation: TokenExchangeObservation): void {
  const event = observation.fields["event"];
  const message =
    observation.message ?? (typeof event === "string" && event.length > 0 ? event : undefined);

  if (message === undefined) {
    request.log[observation.level](observation.fields);
    return;
  }

  request.log[observation.level](observation.fields, message);
}

function tokenExchangeRequestUrl(request: FastifyRequest, prefix: string): URL | null {
  try {
    const url = new URL(request.url, `${request.protocol}://${request.host}`);
    url.pathname = url.pathname.slice(prefix.length);
    return url;
  } catch {
    return null;
  }
}

function fastifyRequestToWebRequest(
  request: FastifyRequest,
  url: URL | null,
  signal?: AbortSignal,
): Request | null {
  if (url === null) return null;

  try {
    const headers = new Headers();

    for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
      const name = request.raw.rawHeaders[index];
      const value = request.raw.rawHeaders[index + 1];

      if (name !== undefined && value !== undefined) {
        headers.append(name, value);
      }
    }

    const requestBody = isNodeBuffer(request.body) ? request.body : undefined;
    const mayHaveBody = request.method !== "GET" && request.method !== "HEAD";
    const body =
      mayHaveBody && requestBody !== undefined ? Uint8Array.from(requestBody) : undefined;
    return new Request(url, {
      ...(body === undefined ? {} : { body }),
      headers,
      method: request.method,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return null;
  }
}

function isNodeBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value);
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);

  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") {
      reply.header(name, value);
    }
  }

  for (const value of response.headers.getSetCookie()) {
    reply.header("set-cookie", value);
  }

  await reply.send(Buffer.from(await response.arrayBuffer()));
}
