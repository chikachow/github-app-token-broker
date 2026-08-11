# github-app-token-broker documentation

- [Service contract](service-contract.md): authoritative public API, security boundaries, provider and policy behavior, runtime bindings, and errors.
- [Implementation](implementation.md): package layout, composition Interface, request flow, and validation commands.
- [Deployment](deployment.md): interface between this public source repository and an external deployment system.
- [Release checklist](release.md): public-source and publish-readiness checks.
- [Domain glossary](../CONTEXT.md): project terminology.
- [OIDC authentication decision](decisions/oidc-id-token-authentication.md), [CEL-free policy decision](decisions/cel-free-token-issuance-policy.md), and [GitHub failure-classification decision](decisions/github-api-failure-classification.md): durable security rationale.

Decision records may describe source-supported capabilities. The service contract is authoritative for public behavior and security semantics. Each external deployment's reviewed TypeScript composition is authoritative for the OIDC Provider Registrations and Permit Statements compiled into its artifact.

The source-supported Fly OIDC registration capability is documented in the [service contract](service-contract.md#source-supported-fly-oidc-registration), [implementation reference](implementation.md#oidc-security-boundary), and [domain glossary](../CONTEXT.md). Its availability does not imply that any deployment registers it or grants it a Permit Statement.

The implemented public service surface is only `POST /token`.
