import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  createGitHubAppTokenExchange,
  type TokenExchangeObservation,
} from "@github-app-token-broker/token-exchange";
import fc from "fast-check";
import { expect } from "vitest";

import { testNow } from "../../support/constants.ts";
import { fetchGitHubTestDouble } from "../../support/github-api.ts";
import {
  fetchOidcRemoteDocumentResponseTestDouble,
  tokenExchangeRequestBody,
} from "../../support/oidc.ts";
import { testPrivateKeyPem } from "../../support/rsa-test-key-pair.ts";
import { testTokenIssuancePolicy } from "../../support/token-issuance-policy.ts";

export const formGeneratedRunBudget = 750;
const tokenEndpoint = "https://broker.example/token";
const fixtureForm = new URLSearchParams(await tokenExchangeRequestBody());
const resource = requiredFormValue(fixtureForm, "resource");
const scope = requiredFormValue(fixtureForm, "scope");

type FormEntry = readonly [string, string];

interface FormScenario {
  readonly emptyFirst: readonly FormEntry[];
  readonly nonEmptyFirst: readonly FormEntry[];
}

const baseEntries = [
  ["grant_type", requiredFormValue(fixtureForm, "grant_type")],
  ["requested_token_type", requiredFormValue(fixtureForm, "requested_token_type")],
  ["resource", resource],
  ["scope", scope],
  ["subject_token", requiredFormValue(fixtureForm, "subject_token")],
  ["subject_token_type", requiredFormValue(fixtureForm, "subject_token_type")],
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
  accessToken: "ghs_test_token",
  issuanceEvents: [
    "installation_access_token_issuance_started",
    "installation_access_token_issuance_succeeded",
  ],
  kind: "success",
  resource,
  scope,
  status: 200,
  subjectTokenKind: "id_token",
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
      readonly kind: "error";
      readonly status: number;
    }
  | typeof expectedObservation;

const tokenExchange = createGitHubAppTokenExchange(
  {
    composition: {
      oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
      tokenIssuancePolicy: testTokenIssuancePolicy,
    },
    githubApp: { appId: "2419473", privateKey: testPrivateKeyPem },
    subjectTokenAudience: "https://broker.example",
  },
  {
    fetch: (input, init) => {
      const request = new Request(input, init);

      return new URL(request.url).hostname === "token.actions.githubusercontent.com"
        ? fetchOidcRemoteDocumentResponseTestDouble(request)
        : fetchGitHubTestDouble(request);
    },
    now: () => testNow,
  },
);

async function observeTokenExchangeForm(
  entries: readonly FormEntry[],
): Promise<ObservedFormOutcome> {
  const observations: TokenExchangeObservation[] = [];
  const form = new URLSearchParams();

  for (const [name, value] of entries) {
    form.append(name, value);
  }

  const response = await tokenExchange(
    new Request(tokenEndpoint, {
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }),
    {
      observe: async (observation) => {
        observations.push(observation);
      },
      observeOidcDiagnostic: () => undefined,
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
      kind: "error",
      status: response.status,
    };
  }

  expect(responseBody).toMatchObject({ access_token: expectedObservation.accessToken, scope });
  expect(observations).toHaveLength(2);
  expect(observations[1]).toMatchObject({
    fields: {
      installation_access_token_request: { resource, scope },
      subject_token: { subject_token_kind: expectedObservation.subjectTokenKind },
    },
  });

  return {
    accessToken: expectedObservation.accessToken,
    issuanceEvents: observations.map(({ fields }) => fields["event"]),
    kind: "success",
    resource,
    scope,
    status: response.status,
    subjectTokenKind: expectedObservation.subjectTokenKind,
  };
}

function requiredFormValue(form: URLSearchParams, name: string): string {
  const value = form.get(name);

  if (value === null || value.length === 0) {
    throw new Error(`fixture Token Exchange form is missing ${name}`);
  }

  return value;
}
