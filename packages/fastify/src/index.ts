import {
  maxTokenExchangeBodyBytes,
  oauthErrorResponse,
  type TokenExchangeEvent,
  type TokenExchangeHandler,
} from "@github-app-token-broker/token-exchange";
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

export interface GitHubAppTokenExchangePluginOptions {
  readonly tokenExchange: TokenExchangeHandler;
}

export const githubAppTokenExchangePlugin: FastifyPluginAsync<
  GitHubAppTokenExchangePluginOptions
> = async (fastify, options) => {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );

  fastify.setErrorHandler<FastifyError>(async (error, _request, reply) => {
    switch (error.code) {
      case "FST_ERR_CTP_BODY_TOO_LARGE":
        await sendWebResponse(reply, oauthErrorResponse(413, "invalid_request"));
        return;
      case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
        await sendWebResponse(reply, oauthErrorResponse(400, "invalid_request"));
        return;
      default:
        throw error;
    }
  });

  fastify.all(
    "/token",
    {
      bodyLimit: maxTokenExchangeBodyBytes,
    },
    async (request, reply) => {
      const response = await options.tokenExchange(fastifyRequestToWebRequest(request), {
        observe(event) {
          logEvent(request, event);
        },
      });

      await sendWebResponse(reply, response);
    },
  );
};

export default githubAppTokenExchangePlugin;

function fastifyRequestToWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  const rawHeaders = request.raw.rawHeaders;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];

    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }

  const requestBody = request.body as Buffer | undefined;

  return new Request(new URL(request.raw.url ?? request.url, "http://localhost"), {
    ...(requestBody === undefined ? {} : { body: Uint8Array.from(requestBody) }),
    headers,
    method: request.method,
  });
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status).headers(Object.fromEntries(response.headers));
  reply.send(Buffer.from(await response.arrayBuffer()));
}

function logEvent(request: FastifyRequest, event: TokenExchangeEvent): void {
  const { level, ...eventFields } = event;
  const fields = { ...eventFields, requestId: request.id };

  switch (level) {
    case "error":
      request.log.error(fields, event.event);
      return;
    case "info":
      request.log.info(fields, event.event);
      return;
    case "warn":
      request.log.warn(fields, event.event);
  }
}
