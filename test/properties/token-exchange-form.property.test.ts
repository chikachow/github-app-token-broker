import { test } from "@fast-check/vitest";
import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  createGitHubAppTokenExchange,
  type TokenExchangeObservation,
} from "@github-app-token-broker/token-exchange";
import fc from "fast-check";
import { describe, expect } from "vitest";

import {
  fetchOidcRemoteDocumentResponseTestDouble,
  tokenExchangeRequestBody,
} from "../support/oidc.ts";
import { testNow } from "../support/constants.ts";
import { fetchGitHubTestDouble } from "../support/github-api.ts";
import { testPrivateKeyPem } from "../support/rsa-test-key-pair.ts";
import { testTokenIssuancePolicy } from "../support/token-issuance-policy.ts";

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

const formScenarioArbitrary: fc.Arbitrary<FormScenario> = fc
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

async function expectSuccessfulTokenExchangeForm(entries: readonly FormEntry[]): Promise<void> {
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

  expect(responseBody).toMatchObject({ access_token: "ghs_test_token", scope });
  expect(response.status).toBe(200);
  expect(observations).toHaveLength(2);
  expect(observations.map(({ fields }) => fields["event"])).toEqual([
    "installation_access_token_issuance_started",
    "installation_access_token_issuance_succeeded",
  ]);
  expect(observations[1]).toMatchObject({
    fields: {
      installation_access_token_request: { resource, scope },
      subject_token: { subject_token_kind: "id_token" },
    },
  });
}

function requiredFormValue(form: URLSearchParams, name: string): string {
  const value = form.get(name);

  if (value === null || value.length === 0) {
    throw new Error(`fixture Token Exchange form is missing ${name}`);
  }

  return value;
}

describe("Token Exchange form properties", () => {
  test.prop([formScenarioArbitrary], {
    numRuns: 750,
  })("keeps one non-empty form value regardless of empty-value ordering", async (scenario) => {
    await expectSuccessfulTokenExchangeForm(scenario.emptyFirst);
    await expectSuccessfulTokenExchangeForm(scenario.nonEmptyFirst);
  });
});
