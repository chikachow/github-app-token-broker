import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import { readRequestBodyUpTo } from "@github-app-token-broker/http/request-body";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubActionsTokenExchangeExternalTestDouble,
  githubActionsTokenExchangeRequest,
  testGitHubActionsTokenExchangeConfiguration as configuration,
} from "../support/github-actions-token-exchange.ts";
import { testNow } from "../support/constants.ts";
import { testPrivateKeyPem } from "../support/rsa-test-key-pair.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Token Exchange request lifetime", () => {
  it("attributes cancellation to an observation only after its callback starts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let depth = 0; depth <= 24; depth++) {
      const abort = new AbortController();
      const fetch = vi.fn<typeof globalThis.fetch>();
      let observations = 0;
      const exchange = createGitHubAppTokenExchange(configuration, { fetch, now: () => testNow });
      const request = new Request(
        await githubActionsTokenExchangeRequest({
          formOverrides: { subject_token: "not-a-jwt" },
        }),
        { signal: abort.signal },
      );
      const pending = exchange(request, {
        observe: () => {
          observations++;
          return new Promise<void>(() => {});
        },
      });
      let cancellation = Promise.resolve();
      for (let turn = 0; turn < depth; turn++) cancellation = cancellation.then(() => {});
      void cancellation.then(() => abort.abort());
      const response = await pending;
      expect(response.status, `cancellation after ${depth} microtasks`).toBe(
        observations === 0 ? 503 : 500,
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("retains credential ownership through the final clock read before response construction", async () => {
    const abort = new AbortController();
    let acknowledged = false;
    const methods: string[] = [];
    const exchange = createGitHubAppTokenExchange(configuration, {
      now() {
        if (acknowledged) abort.abort();
        return testNow;
      },
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "api.github.com") methods.push(request.method);
        if (request.method === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const response = await exchange(
      new Request(await githubActionsTokenExchangeRequest(), { signal: abort.signal }),
      {
        observe: async (event) => {
          if (event.fields["event"] === "installation_access_token_issuance_succeeded")
            acknowledged = true;
        },
      },
    );
    expect(response.status).toBe(503);
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  it("bounds body acquisition through the public handler", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://broker.example/github/apps/fixture-app/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const exchange = createGitHubAppTokenExchange(configuration, { fetch, now: () => testNow });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = exchange(request, { observe: async () => {} });
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await response).status).toBe(503);
    expect(cancelled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains a shared issuer refresh when one caller stops waiting", async () => {
    const started = deferred<void>();
    const discovery = deferred<Response>();
    const abort = new AbortController();
    const retained: Promise<void>[] = [];
    let discoveryRequests = 0;
    const exchange = createGitHubAppTokenExchange(configuration, {
      now: () => testNow,
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) {
          discoveryRequests++;
          started.resolve();
          return discovery.promise;
        }
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const first = exchange(
      new Request(await githubActionsTokenExchangeRequest(), { signal: abort.signal }),
      {
        observe: async () => {},
        waitUntil: (work) => {
          retained.push(work);
        },
      },
    );
    await started.promise;
    const second = exchange(await githubActionsTokenExchangeRequest(), { observe: async () => {} });
    abort.abort();
    expect((await first).status).toBe(503);
    let refreshCompleted = false;
    void retained[0]!.then(() => {
      refreshCompleted = true;
    });
    await Promise.resolve();
    expect(refreshCompleted).toBe(false);
    discovery.resolve(
      await fetchGitHubActionsTokenExchangeExternalTestDouble(
        "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
      ),
    );
    expect((await second).status).toBe(200);
    await Promise.all(retained);
    expect(discoveryRequests).toBe(1);
  });

  it("cancels a stalled body when its Request is aborted", async () => {
    const abort = new AbortController();
    let close!: () => void;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://broker.example", {
      method: "POST",
      body: stream,
      signal: abort.signal,
      duplex: "half",
    } as RequestInit);
    let rejected = false;
    const pending = readRequestBodyUpTo(request, 65536).catch(() => {
      rejected = true;
    });
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(cancelled).toBe(true);
      expect(rejected).toBe(true);
    } finally {
      if (!cancelled) close();
      await pending;
    }
  });

  it("bounds secret resolution and never mints after a late secret arrives", async () => {
    const entered = deferred<void>();
    const secret = deferred<string>();
    const requests: Request[] = [];
    const exchange = createGitHubAppTokenExchange(
      {
        ...configuration,
        githubApps: [
          {
            ...configuration.githubApps[0],
            privateKey: {
              get() {
                entered.resolve();
                return secret.promise;
              },
            },
          },
        ],
      },
      {
        now: () => testNow,
        fetch: (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
        },
      },
    );
    const request = await githubActionsTokenExchangeRequest();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let response: Response | undefined;
    const pending = exchange(request, { observe: async () => {} }).then((value) => {
      response = value;
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    try {
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ error: "temporarily_unavailable" });
    } finally {
      secret.resolve(testPrivateKeyPem);
      await pending;
    }
    expect(requests.filter((value) => new URL(value.url).hostname === "api.github.com")).toEqual(
      [],
    );
  });

  it.each([
    "installation_access_token_issuance_started",
    "installation_access_token_issuance_succeeded",
  ])("fails closed when %s acknowledgement times out", async (event) => {
    const entered = deferred<void>();
    const acknowledgement = deferred<void>();
    const githubMethods: string[] = [];
    const exchange = createGitHubAppTokenExchange(configuration, {
      now: () => testNow,
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "api.github.com") githubMethods.push(request.method);
        if (request.method === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const request = await githubActionsTokenExchangeRequest();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    let response: Response | undefined;
    const pending = exchange(request, {
      observe: (observation) => {
        if (observation.fields["event"] === event) {
          entered.resolve();
          return acknowledgement.promise;
        }
        return Promise.resolve();
      },
    }).then((value) => {
      response = value;
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    try {
      expect(response?.status).toBe(500);
      expect(await response?.json()).toEqual({ error: "server_error" });
    } finally {
      acknowledgement.resolve();
      await pending;
    }
    expect(githubMethods).toEqual(event.endsWith("started") ? [] : ["GET", "POST", "DELETE"]);
  });

  it("awaits an in-flight mint and revokes it after cancellation instead of releasing it", async () => {
    const mintStarted = deferred<void>();
    const mint = deferred<Response>();
    const abort = new AbortController();
    const methods: string[] = [];
    const exchange = createGitHubAppTokenExchange(configuration, {
      now: () => testNow,
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "api.github.com") methods.push(request.method);
        if (request.method === "POST") {
          mintStarted.resolve();
          return mint.promise;
        }
        if (request.method === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const request = new Request(await githubActionsTokenExchangeRequest(), {
      signal: abort.signal,
    });
    let settled = false;
    const pending = exchange(request, { observe: async () => {} }).then((response) => {
      settled = true;
      return response;
    });
    await mintStarted.promise;
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    mint.resolve(
      Response.json(
        {
          token: "synthetic-token",
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "write", pull_requests: "write" },
        },
        { status: 201 },
      ),
    );
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  it("revokes a token that expires while its success observation is acknowledged", async () => {
    let now = testNow;
    const methods: string[] = [];
    const exchange = createGitHubAppTokenExchange(configuration, {
      now: () => now,
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "api.github.com") methods.push(request.method);
        if (request.method === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const response = await exchange(await githubActionsTokenExchangeRequest(), {
      observe: async (observation) => {
        if (observation.fields["event"] === "installation_access_token_issuance_succeeded")
          now = new Date("2030-01-01T00:00:00Z");
      },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "server_error" });
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });
});
