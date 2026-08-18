import fc from "fast-check";
import { expect } from "vitest";

import { handleTokenExchangeRequest } from "../../../workers/github-app-token-broker/src/token-exchange.ts";

export const formGeneratedRunBudget = 750;
const tokenEndpoint = "https://broker.example/token";
const grantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const requestedTokenType = "urn:ietf:params:oauth:token-type:access_token";
const subjectTokenType = "urn:ietf:params:oauth:token-type:id_token";
const resource = "https://api.github.com/repos/fixture-owner/fixture-repository";
const scope = "contents:read";

type FormEntry = readonly [string, string];
type ExpectedFormOutcome =
  | { readonly error: "invalid_request" | "invalid_target" }
  | { readonly success: true };

interface FormScenario {
  readonly entries: readonly FormEntry[];
  readonly expected: ExpectedFormOutcome;
  readonly permutation: readonly FormEntry[];
}

interface FormScenarioWithoutPermutation {
  readonly entries: readonly FormEntry[];
  readonly expected: ExpectedFormOutcome;
}

const baseEntries: readonly FormEntry[] = [
  ["grant_type", grantType],
  ["requested_token_type", requestedTokenType],
  ["resource", resource],
  ["scope", scope],
  ["subject_token", "subject-token"],
  ["subject_token_type", subjectTokenType],
];

const singleValuedFields = [
  "grant_type",
  "requested_token_type",
  "resource",
  "scope",
  "subject_token",
  "subject_token_type",
] as const;
const invalidRequestExtensionFields = [
  "actor_token",
  "actor_token_type",
  "authorization_details",
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
] as const;
const emptyIgnoredFieldArbitrary = fc.constantFrom(
  ...singleValuedFields,
  "audience",
  ...invalidRequestExtensionFields,
);
const ignoredExtensionEntryArbitrary = fc
  .constantFrom("future_extension", "x_broker_extension")
  .map((name) => [name, ""] as const);
const acceptedNoiseEntryArbitrary: fc.Arbitrary<FormEntry> = fc.oneof(
  emptyIgnoredFieldArbitrary.map((name) => [name, ""] as const),
  ignoredExtensionEntryArbitrary,
);

const acceptedScenarioArbitrary: fc.Arbitrary<FormScenarioWithoutPermutation> = fc
  .array(acceptedNoiseEntryArbitrary, { maxLength: 10 })
  .map((noise) => ({
    entries: [...baseEntries, ...noise],
    expected: { success: true } as const,
  }));

const duplicateFieldCases = [
  { error: "invalid_request", name: "grant_type", value: grantType },
  { error: "invalid_request", name: "requested_token_type", value: requestedTokenType },
  { error: "invalid_target", name: "resource", value: resource },
  { error: "invalid_request", name: "scope", value: scope },
  { error: "invalid_request", name: "subject_token", value: "other-subject-token" },
  { error: "invalid_request", name: "subject_token_type", value: subjectTokenType },
] as const;
const duplicateScenarioArbitrary: fc.Arbitrary<FormScenarioWithoutPermutation> = fc
  .constantFrom(...duplicateFieldCases)
  .map(({ error, name, value }) => ({
    entries: [...baseEntries, [name, value] as const],
    expected: { error },
  }));

const rejectedExtensionCases = [
  ...invalidRequestExtensionFields.map((name) => ({ error: "invalid_request" as const, name })),
  { error: "invalid_target" as const, name: "audience" },
] as const;
const rejectedExtensionScenarioArbitrary: fc.Arbitrary<FormScenarioWithoutPermutation> = fc
  .tuple(fc.constantFrom(...rejectedExtensionCases), fc.string({ maxLength: 12, minLength: 1 }))
  .map(([{ error, name }, value]) => ({
    entries: [...baseEntries, [name, value] as const],
    expected: { error },
  }));

export const formScenarioArbitrary: fc.Arbitrary<FormScenario> = fc
  .oneof(
    { arbitrary: acceptedScenarioArbitrary, weight: 3 },
    { arbitrary: duplicateScenarioArbitrary, weight: 3 },
    { arbitrary: rejectedExtensionScenarioArbitrary, weight: 2 },
  )
  .chain((scenario) =>
    fc
      .shuffledSubarray([...scenario.entries], {
        maxLength: scenario.entries.length,
        minLength: scenario.entries.length,
      })
      .map((permutation) => ({ ...scenario, permutation })),
  );

export const formScenarioExamples: [FormScenario][] = [
  [
    scenarioWithPermutation([["grant_type", ""], ...baseEntries], { success: true }, [
      ...baseEntries,
      ["grant_type", ""],
    ]),
  ],
  [
    scenarioWithPermutation(
      [["resource", ""], ...baseEntries, ["resource", ""]],
      { success: true },
      [...baseEntries, ["resource", ""], ["resource", ""]],
    ),
  ],
  [
    scenarioWithPermutation(
      [...baseEntries, ["grant_type", grantType]],
      { error: "invalid_request" },
      [["grant_type", grantType], ...baseEntries],
    ),
  ],
  [
    scenarioWithPermutation(
      [...baseEntries, ["audience", "https://audience.example"]],
      { error: "invalid_target" },
      [["audience", "https://audience.example"], ...baseEntries],
    ),
  ],
];

export async function expectFormScenario(scenario: FormScenario): Promise<void> {
  const expected = expectedObservation(scenario.expected);

  await expect(observeTokenExchangeForm(scenario.entries)).resolves.toEqual(expected);
  await expect(observeTokenExchangeForm(scenario.permutation)).resolves.toEqual(expected);
}

function scenarioWithPermutation(
  entries: readonly FormEntry[],
  expected: ExpectedFormOutcome,
  permutation: readonly FormEntry[],
): FormScenario {
  return { entries, expected, permutation };
}

function expectedObservation(expected: ExpectedFormOutcome): ObservedFormOutcome {
  return "success" in expected
    ? {
        exchangeCount: 1,
        kind: "success",
        resource,
        scope,
        status: 200,
        subjectToken: "subject-token",
      }
    : { error: expected.error, exchangeCount: 0, kind: "error", status: 400 };
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
