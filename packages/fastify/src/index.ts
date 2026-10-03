// oxlint-disable-next-line import/no-nodejs-modules -- This package intentionally targets Node.js.
import { Buffer } from "node:buffer";

import {
  maxTokenExchangeBodyBytes,
  tokenExchangeInvalidRequestResponse,
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
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  fastify.setErrorHandler<FastifyError>(async (error, _request, reply) => {
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
        const pathname = new URL(request.raw.url ?? request.url, "http://localhost").pathname.slice(
          fastify.prefix.length,
        );
        if (tokenEndpointPaths.has(pathname)) return;
        // Unknown Apps must be rejected before Fastify consumes or classifies a body.
        const webRequest = fastifyRequestToWebRequest(request, fastify.prefix);
        const response =
          webRequest === null
            ? tokenExchangeInvalidRequestResponse(400)
            : await options.tokenExchange(webRequest, tokenExchangeContext(request));
        await sendWebResponse(reply, response);
      },
    },
    async (request, reply) => {
      const webRequest = fastifyRequestToWebRequest(request, fastify.prefix);

      if (webRequest === null) {
        await sendWebResponse(reply, tokenExchangeInvalidRequestResponse(400));
        return;
      }

      const response = await options.tokenExchange(webRequest, tokenExchangeContext(request));

      await sendWebResponse(reply, response);
    },
  );
};

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

function fastifyRequestToWebRequest(request: FastifyRequest, prefix: string): Request | null {
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
    const url = new URL(request.raw.url ?? request.url, `${request.protocol}://${request.host}`);

    url.pathname = url.pathname.slice(prefix.length);

    return new Request(url, {
      ...(body === undefined ? {} : { body }),
      headers,
      method: request.method,
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
