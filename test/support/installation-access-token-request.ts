import {
  normalizeInstallationAccessTokenRequest,
  type InstallationAccessTokenRequest,
} from "../../workers/github-app-token-broker/src/installation-access-token-request.ts";

const fixtureSourceRepository = "fixture-owner/fixture-source-repository";
export const fixtureSourceResource = `https://api.github.com/repos/${fixtureSourceRepository}`;
export const fixtureTargetResource =
  "https://api.github.com/repos/fixture-target-owner/fixture-target-repository";

export function mustNormalizeTokenRequest(options: {
  resource: string;
  scope: string | null;
}): InstallationAccessTokenRequest {
  const result = normalizeInstallationAccessTokenRequest({
    resource: options.resource,
    scope: options.scope,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.tokenRequest;
}
