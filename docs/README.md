# github-app-token-broker documentation

- [Service contract](service-contract.md): authoritative public API, security boundaries, provider and policy behavior, runtime bindings, and errors.
- [Implementation](implementation.md): package layout, composition seam, request flow, and validation commands.
- [Deployment](deployment.md): interface between this public source repository and an external deployment system.
- [Release checklist](release.md): public-source and publish-readiness checks.
- [Domain glossary](../CONTEXT.md): project terminology.
- [OIDC authentication decision](decisions/oidc-id-token-authentication.md), [CEL-free policy decision](decisions/cel-free-token-issuance-policy.md), and [GitHub failure-classification decision](decisions/github-api-failure-classification.md): durable security rationale.

Decision records may describe source-supported capabilities. The service contract is authoritative for public behavior and security semantics; the checked-in [`configured-token-exchange-composition.ts`](../workers/github-app-token-broker/src/configured-token-exchange-composition.ts) and [`configured-token-issuance-policy.ts`](../workers/github-app-token-broker/src/policy/configured-token-issuance-policy.ts) source are authoritative for the exact configured OIDC Provider Registration and Permit Statement inventories.

The source-supported Fly OIDC registration capability is documented in the [service contract](service-contract.md#source-supported-fly-oidc-registration), [implementation reference](implementation.md#oidc-security-boundary), and [domain glossary](../CONTEXT.md). It is not part of the default production registration or policy inventory.

The implemented public service surface is only `POST /token`.
