import { once } from "node:events";
import { createServer } from "node:http";

import {
  createGitHubAppInformation,
  GitHubAppUnavailableError,
  GitHubAppUpstreamError,
} from "@github-app-token-broker/github/app-information";
import { describe, expect, it, vi } from "vitest";

import { testPrivateKeyPem } from "../support/rsa-test-key-pair.ts";
import { testNow } from "../support/constants.ts";
import { testGitHubAppResponse } from "../support/github-app-information.ts";

const configuration = { appId: "2419473", privateKey: testPrivateKeyPem };

describe("GitHub HTTP Node runtime", () => {
  it("rejects malformed UTF-8 without replacing a GitHub App metadata field", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ ...testGitHubAppResponse, description: "\u007f" }),
    );
    body[body.indexOf(0x7f)] = 0xff;
    const information = createGitHubAppInformation(configuration, {
      fetch: async () => new Response(body),
      now: () => testNow,
    });

    await expect(information.getApp()).rejects.toEqual(new GitHubAppUpstreamError());
  });

  it("closes a native Fetch response after classifying an unfinished upstream error body", async () => {
    const responseClosed = Promise.withResolvers<void>();
    const upstream = createServer((_request, response) => {
      response.on("close", () => responseClosed.resolve());
      response.writeHead(503, { "content-type": "application/json" });
      response.write('{"message":"private upstream failure"}');
    });
    const listening = once(upstream, "listening");
    upstream.listen(0, "127.0.0.1");
    await listening;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;

    try {
      const address = upstream.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a loopback upstream address");
      }

      const information = createGitHubAppInformation(configuration, {
        fetch: async (input, init) => {
          expect(input).toEqual(new URL("https://api.github.com/app"));

          return fetch(`http://127.0.0.1:${address.port}`, init);
        },
        now: () => testNow,
      });

      await expect(information.getApp()).rejects.toBeInstanceOf(GitHubAppUnavailableError);
      await Promise.race([
        responseClosed.promise,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => {
            reject(new Error("upstream response was not promptly closed"));
          }, 1000);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it.each(["Fetch rejection", "cancellation rejection"] as const)(
    "contains a late $0 after the GitHub deadline",
    async (failure) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const upstream = Promise.withResolvers<Response>();
      const requestStarted = Promise.withResolvers<void>();
      const cancel = vi.fn(async () => {
        throw new Error("private cancellation failure");
      });
      const information = createGitHubAppInformation(configuration, {
        fetch: () => {
          requestStarted.resolve();

          return upstream.promise;
        },
        now: () => testNow,
      });

      try {
        const result = information.getApp();
        await requestStarted.promise;
        deadline.abort(new DOMException("private deadline failure", "TimeoutError"));
        await expect(result).rejects.toEqual(new GitHubAppUnavailableError());

        if (failure === "Fetch rejection") {
          upstream.reject(new Error("private late Fetch failure"));
        } else {
          upstream.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
        }

        await new Promise(setImmediate);
        await expect(result).rejects.toEqual(new GitHubAppUnavailableError());
        expect(cancel).toHaveBeenCalledTimes(failure === "Fetch rejection" ? 0 : 1);
      } finally {
        timeout.mockRestore();
      }
    },
  );
});
