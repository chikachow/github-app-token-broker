import { describe, expect, it } from "vitest";

import { configuredTokenIssuancePolicy } from "../workers/github-app-token-broker/src/policy/configured-token-issuance-policy.ts";
import { tokenIssuancePolicyPermits } from "../workers/github-app-token-broker/src/policy/token-issuance-policy.ts";
import type { GitHubInstallationPermissions } from "../workers/github-app-token-broker/src/installation-access-token-request.ts";
import {
  configuredPermitStatementExpectations,
  requestForExpectation,
  subjectTokenForExpectation,
} from "./support/configured-token-issuance-policy.ts";

const standardPermissionNames = ["actions", "contents", "pull_requests"] as const;

describe("configured Token Issuance Policy", () => {
  it("permits every configured event with its exact request", () => {
    let acceptedEvents = 0;

    for (const expectation of configuredPermitStatementExpectations) {
      for (const eventName of expectation.eventNames) {
        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            subjectTokenForExpectation(expectation, { event_name: eventName }),
            requestForExpectation(expectation, expectation.permissions),
          ),
          `${expectation.workflowRef}: ${eventName}`,
        ).toBe(true);
        acceptedEvents += 1;
      }
    }

    expect(acceptedEvents).toBe(29);
  });

  it("does not permit permissions beyond each configured expectation", () => {
    let permissionDenials = 0;

    for (const expectation of configuredPermitStatementExpectations) {
      const subjectToken = subjectTokenForExpectation(expectation);

      for (const permissionName of standardPermissionNames) {
        const requestedLevel =
          expectation.permissions[permissionName] === undefined ? "read" : "admin";
        const permissions: GitHubInstallationPermissions = {
          [permissionName]: requestedLevel,
        };

        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            subjectToken,
            requestForExpectation(expectation, permissions),
          ),
          `${expectation.workflowRef}: ${permissionName}:${requestedLevel}`,
        ).toBe(false);
        permissionDenials += 1;
      }

      expect(
        tokenIssuancePolicyPermits(
          configuredTokenIssuancePolicy,
          subjectToken,
          requestForExpectation(expectation, { issues: "read" }),
        ),
        `${expectation.workflowRef}: issues:read`,
      ).toBe(false);
      permissionDenials += 1;
    }

    expect(permissionDenials).toBe(16 * 4);
  });

  it("does not permit issuer, selected-Claim, Claim-type, or Repository Resource mutations", () => {
    let mutations = 0;
    const nonMatchingClaimValues: readonly unknown[] = ["unconfigured", null, false, 123, [], {}];

    for (const expectation of configuredPermitStatementExpectations) {
      for (const claimName of [
        "repository",
        "event_name",
        "ref_type",
        "ref",
        "workflow_ref",
      ] as const) {
        for (const claimValue of nonMatchingClaimValues) {
          expect(
            tokenIssuancePolicyPermits(
              configuredTokenIssuancePolicy,
              subjectTokenForExpectation(expectation, { [claimName]: claimValue }),
              requestForExpectation(expectation, expectation.permissions),
            ),
            `${expectation.workflowRef}: ${claimName}=${JSON.stringify(claimValue)}`,
          ).toBe(false);
          mutations += 1;
        }

        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            withoutClaim(subjectTokenForExpectation(expectation), claimName),
            requestForExpectation(expectation, expectation.permissions),
          ),
          `${expectation.workflowRef}: missing ${claimName}`,
        ).toBe(false);
        mutations += 1;
      }

      for (const [resourceRepositoryFullName, mutationName] of [
        [expectation.resourceRepositoryFullName.replace("/", "-other/"), "resource owner"],
        [`${expectation.resourceRepositoryFullName}-other`, "resource repository"],
      ] as const) {
        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            subjectTokenForExpectation(expectation),
            requestForExpectation(expectation, expectation.permissions, resourceRepositoryFullName),
          ),
          `${expectation.workflowRef}: ${mutationName}`,
        ).toBe(false);
        mutations += 1;
      }

      expect(
        tokenIssuancePolicyPermits(
          configuredTokenIssuancePolicy,
          subjectTokenForExpectation(
            expectation,
            {},
            { issuer: "https://unconfigured-issuer.example" },
          ),
          requestForExpectation(expectation, expectation.permissions),
        ),
        `${expectation.workflowRef}: issuer`,
      ).toBe(false);
      mutations += 1;
    }

    expect(mutations).toBe(16 * (5 * 7 + 2 + 1));
  });

  it("permits every legacy, immutable, customized, missing, and malformed sub form", () => {
    for (const expectation of configuredPermitStatementExpectations) {
      const subjectTokens = [
        ["legacy", subjectTokenForExpectation(expectation)],
        [
          "immutable",
          subjectTokenForExpectation(expectation, {
            sub: `repo:${expectation.workflowRepositoryFullName.replace("/", "@555555/")}@123456789:ref:refs/heads/main`,
          }),
        ],
        [
          "customized",
          subjectTokenForExpectation(expectation, { sub: `custom:${expectation.workflowRef}` }),
        ],
        ["missing", withoutClaim(subjectTokenForExpectation(expectation), "sub")],
        ["malformed", subjectTokenForExpectation(expectation, { sub: 123 })],
      ] as const;

      for (const [subForm, subjectToken] of subjectTokens) {
        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            subjectToken,
            requestForExpectation(expectation, expectation.permissions),
          ),
          `${expectation.workflowRef}: ${subForm}`,
        ).toBe(true);
      }
    }
  });
});

function withoutClaim<
  ClaimName extends string,
  SubjectToken extends ReturnType<typeof subjectTokenForExpectation>,
>(subjectToken: SubjectToken, claimName: ClaimName): SubjectToken {
  const claims = { ...subjectToken.claims };
  delete claims[claimName];

  return { ...subjectToken, claims: Object.freeze(claims) };
}
