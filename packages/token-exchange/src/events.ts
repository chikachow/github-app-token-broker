import type { OidcIdTokenAuthenticationEvent } from "@github-app-token-broker/oidc/id-token-authenticator";

import type { OidcAuthenticationFailureReason } from "./authentication.ts";

type TokenExchangeAuthenticationEvent =
  | ({ readonly level: "warn" } & OidcIdTokenAuthenticationEvent)
  | {
      readonly diagnosticCode?: string;
      readonly event: "oidc_authentication_failed";
      readonly level: "warn";
      readonly path: string;
      readonly providerHttpStatus?: number;
      readonly reason: OidcAuthenticationFailureReason;
      readonly userAgent: string | null;
    };

export type TokenExchangeEvent =
  | TokenExchangeAuthenticationEvent
  | {
      readonly error: {
        readonly message: string;
        readonly name: string;
        readonly status: number | undefined;
      };
      readonly event: "installation_access_token_issuance_failed";
      readonly installation_access_token_request: Record<string, unknown>;
      readonly level: "error";
      readonly subject_token: Record<string, unknown>;
      readonly target_installation: Record<string, unknown>;
      readonly token_issuance_policy: { readonly permitted: boolean };
    }
  | {
      readonly event: "installation_access_token_issuance_succeeded";
      readonly expires_at: string;
      readonly installation_access_token_request: Record<string, unknown>;
      readonly level: "info";
      readonly subject_token: Record<string, unknown>;
      readonly target_installation: Record<string, unknown>;
      readonly token_issuance_policy: { readonly permitted: true };
    };

export interface TokenExchangeRequestContext {
  readonly observe: (event: TokenExchangeEvent) => void;
}

export interface TokenExchangeApplicationContext extends TokenExchangeRequestContext {
  readonly request: {
    readonly path: string;
    readonly userAgent: string | null;
  };
}
