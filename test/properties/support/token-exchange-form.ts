import fc from "fast-check";
import { expect } from "vitest";

import { handleTokenExchangeRequest } from "../../../workers/github-app-token-broker/src/token-exchange.ts";

export const formGeneratedRunBudget = 750;
const tokenEndpoint = "https://broker.example/token";
const resource = "https://api.github.com/repos/fixture-owner/fixture-repository";
const scope = "contents:read";

type FormEntry = readonly [string, string];

interface FormScenario {
  readonly emptyFirst: readonly FormEntry[];
  readonly nonEmptyFirst: readonly FormEntry[];
}

const baseEntries = [
  ["grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"],
  ["requested_token_type", "urn:ietf:params:oauth:token-type:access_token"],
  ["resource", resource],
  ["scope", scope],
  ["subject_token", "subject-token"],
  ["subject_token_type", "urn:ietf:params:oauth:token-type:id_token"],
] as const satisfies readonly FormEntry[];

const emptyFieldNameArbitrary = fc.constantFrom(
  ...baseEntries.map(([name]) => name),
  "actor_token",
  "actor_token_type",
  "audience",
  "authorization_details",
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
  "future_extension",
  "x_broker_extension",
);

export const formScenarioArbitrary: fc.Arbitrary<FormScenario> = fc
  .constantFrom(...baseEntries)
  .chain((selected) => {
    const remainingEntries = baseEntries.filter(([name]) => name !== selected[0]);

    return fc
      .tuple(
        fc.shuffledSubarray(remainingEntries, {
          maxLength: remainingEntries.length,
          minLength: remainingEntries.length,
        }),
        fc.array(emptyFieldNameArbitrary, { maxLength: 10 }),
      )
      .map(([permutedRemainingEntries, emptyFieldNames]) => {
        const emptyEntries = emptyFieldNames.map((name) => [name, ""] as const);
        const selectedEmpty = [selected[0], ""] as const;

        return {
          emptyFirst: [selectedEmpty, ...permutedRemainingEntries, ...emptyEntries, selected],
          nonEmptyFirst: [selected, ...emptyEntries, ...permutedRemainingEntries, selectedEmpty],
        };
      });
  });

const expectedObservation = {
  exchangeCount: 1,
  kind: "success",
  resource,
  scope,
  status: 200,
  subjectToken: "subject-token",
} as const;

export async function expectFormScenario(scenario: FormScenario): Promise<void> {
  await expect(observeTokenExchangeForm(scenario.emptyFirst)).resolves.toEqual(expectedObservation);
  await expect(observeTokenExchangeForm(scenario.nonEmptyFirst)).resolves.toEqual(
    expectedObservation,
  );
}

type ObservedFormOutcome =
  | {
      readonly error: string;
      readonly exchangeCount: number;
      readonly kind: "error";
      readonly status: number;
    }
  | {
      readonly exchangeCount: number;
      readonly kind: "success";
      readonly resource: string;
      readonly scope: string;
      readonly status: number;
      readonly subjectToken: string;
    };

async function observeTokenExchangeForm(
  entries: readonly FormEntry[],
): Promise<ObservedFormOutcome> {
  type Runtime = Parameters<typeof handleTokenExchangeRequest>[1];
  type ExchangeInput = Parameters<Runtime["exchange"]>[0];
  let exchangeInput: ExchangeInput | undefined;
  let exchangeCount = 0;
  const form = new URLSearchParams();

  for (const [name, value] of entries) {
    form.append(name, value);
  }

  const response = await handleTokenExchangeRequest(
    new Request(tokenEndpoint, { body: form, method: "POST" }),
    {
      async exchange(input) {
        exchangeCount += 1;
        exchangeInput = input;
        return { expiresAt: "2030-01-01T00:00:00.000Z", ok: true, token: "ghs_property" };
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      rateLimit: async () => true,
    },
  );
  const responseBody: unknown = await response.json();

  if (response.status !== 200) {
    return {
      error:
        typeof responseBody === "object" &&
        responseBody !== null &&
        "error" in responseBody &&
        typeof responseBody.error === "string"
          ? responseBody.error
          : "missing_error",
      exchangeCount,
      kind: "error",
      status: response.status,
    };
  }

  if (exchangeInput === undefined) {
    throw new Error("successful Token Exchange did not invoke the exchange runtime");
  }

  return {
    exchangeCount,
    kind: "success",
    resource: exchangeInput.tokenRequest.resource.href,
    scope: exchangeInput.tokenRequest.scope,
    status: response.status,
    subjectToken: exchangeInput.subjectToken,
  };
}
