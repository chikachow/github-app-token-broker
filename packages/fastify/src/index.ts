import { Buffer } from "node:buffer";

import {
  maxTokenExchangeBodyBytes,
  tokenExchangeInvalidRequestResponse,
  type TokenExchangeHandler,
  type TokenExchangeObservation,
} from "@github-app-token-broker/token-exchange";
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

export interface GitHubAppTokenExchangePluginOptions {
  readonly tokenExchange: TokenExchangeHandler;
}

export const githubAppTokenExchangePlugin: FastifyPluginAsync<
  GitHubAppTokenExchangePluginOptions
> = async (fastify, options) => {
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

  fastify.all("/token", { bodyLimit: maxTokenExchangeBodyBytes }, async (request, reply) => {
    const response = await options.tokenExchange(fastifyRequestToWebRequest(request), {
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
    });

    await sendWebResponse(reply, response);
  });
};

function logObservation(request: FastifyRequest, observation: TokenExchangeObservation): void {
  const event = observation.fields["event"];
  const message =
    observation.message ?? (typeof event === "string" && event.length > 0 ? event : undefined);

  switch (observation.level) {
    case "error":
      logAtLevel(request, "error", observation.fields, message);
      return;
    case "info":
      logAtLevel(request, "info", observation.fields, message);
      return;
    case "warn":
      logAtLevel(request, "warn", observation.fields, message);
  }
}

function logAtLevel(
  request: FastifyRequest,
  level: TokenExchangeObservation["level"],
  fields: Readonly<Record<string, unknown>>,
  message: string | undefined,
): void {
  const log = request.log[level];

  if (message === undefined) {
    log.call(request.log, fields);
    return;
  }

  log.call(request.log, fields, message);
}

function fastifyRequestToWebRequest(request: FastifyRequest): Request {
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
  const body = mayHaveBody && requestBody !== undefined ? Uint8Array.from(requestBody) : undefined;
  const url = new URL(request.raw.url ?? request.url, `${request.protocol}://${request.host}`);

  return new Request(url, {
    ...(body === undefined ? {} : { body }),
    headers,
    method: request.method,
  });
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
