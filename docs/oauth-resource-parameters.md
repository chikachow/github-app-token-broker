# OAuth Token Endpoint: repeated and empty `resource` parameters

## Conclusion

For this RFC 8693 token-exchange profile, evaluate `resource` parameters as follows:

1. Decode the `application/x-www-form-urlencoded` body into its ordered name/value tuples.
2. Treat every `resource` occurrence whose decoded value is the empty string as omitted.
3. Require exactly one remaining, non-empty `resource` value.
4. Return `invalid_target` when no non-empty value remains, when more than one non-empty value remains, or when the remaining value is not an acceptable repository resource.

Consequently:

| Encoded occurrences              | Profile result                     |
| -------------------------------- | ---------------------------------- |
| no `resource`                    | `invalid_target`                   |
| `resource=`                      | `invalid_target`                   |
| `resource=&resource=`            | `invalid_target`                   |
| `resource=&resource=https%3A...` | process the one non-empty resource |
| `resource=https%3A...&resource=` | process the one non-empty resource |
| two non-empty `resource` values  | `invalid_target`                   |

This differs from ordinary RFC 6749 parameters: RFC 8693 expressly permits repeating `resource`, while this deployment may validly reject requests for more target services than it supports.

## Standards analysis

### Empty values are omitted

[RFC 6749 Section 3.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-3.2) governs the Token Endpoint and states that parameters sent without a value **MUST** be treated as omitted.

For the wire representation, RFC 8693 uses an `application/x-www-form-urlencoded` UTF-8 entity body ([RFC 8693 Section 2.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-2.1)). The [WHATWG URL Standard, Section 5.1](https://url.spec.whatwg.org/#urlencoded-parsing) parses both `resource=` and `resource` into a tuple whose value is the empty string: a final `=` has an empty value, and a tuple without `=` is also assigned an empty value. Thus both spellings are value-less OAuth parameters and must be treated as omitted.

The OAuth rule does not say to trim whitespace. A decoded value containing spaces is non-empty and should proceed to URI/profile validation rather than being treated as omitted.

### Repetition is parameter-specific

The uncorrected text of [RFC 6749 Section 3.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-3.2) says request and response parameters **MUST NOT** occur more than once, and [Section 5.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2) includes repetition among the causes of `invalid_request`.

That general rule does not prohibit RFC 8693's repeated `resource` parameter:

- [Verified RFC 6749 erratum 5708](https://www.rfc-editor.org/errata/eid5708) clarifies that the no-repetition restriction applies to parameters defined by RFC 6749, not parameters defined by extensions.
- [RFC 8693 Section 2.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-2.1) expressly says multiple `resource` parameters may indicate multiple intended resources. It similarly permits multiple `audience` parameters.
- [RFC 8707 Section 2](https://www.rfc-editor.org/rfc/rfc8707.html#section-2) independently defines the same multiple-`resource` convention.

Two March 2026 RFC 6749 errata, [8790](https://www.rfc-editor.org/errata/eid8790) and [8791](https://www.rfc-editor.org/errata/eid8791), propose making the extension override explicit and cite RFCs 8693 and 8707 as examples. They remain **Reported**, not verified, so they are supporting context rather than normative corrections. Erratum 5708 is verified and RFC 8693 itself unambiguously permits repeated `resource`.

### RFC 8693 permits multiple targets; it does not require this service to do so

Under [RFC 8693 Section 2.1.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-2.1.1), all requested scopes apply across all requested target services. The same section says an authorization server can return `invalid_target` when too many target services are requested.

[RFC 8707 Section 2.2](https://www.rfc-editor.org/rfc/rfc8707.html#section-2.2) is also explicit that the resource values acceptable in a token request are at the authorization server's sole discretion under local policy or configuration. RFC 8707 defines `invalid_target` for a resource that is invalid, missing, unknown, or malformed.

Therefore, a documented single-resource profile may:

- require a target even though RFC 8693 defines `resource` as optional in the general protocol;
- accept exactly one non-empty resource;
- reject zero or multiple effective target resources with `invalid_target`.

This restriction is local target policy, not an RFC 6749 duplicate-parameter syntax error.

## Why mixed empty and non-empty occurrences should be accepted

An empty occurrence must be treated as omitted. RFC 8693 also makes `resource` repeatable, so merely seeing two wire-level occurrences is not an `invalid_request`. After the required omission step, a request containing one empty occurrence and one non-empty occurrence has exactly one effective target resource and satisfies the proposed single-resource profile.

Rejecting that combination solely because two raw `resource` names appeared would conflict with the RFC 6749 requirement to treat the value-less occurrence as omitted. It would also incorrectly apply RFC 6749's general repeat prohibition to an extension parameter that RFC 8693 expressly defines as repeatable.

## Error selection

- **No effective resource**, including one or more empty occurrences: `invalid_target`. The service requires a target, and RFC 8707 defines this error for a missing resource.
- **More than one effective resource**: `invalid_target`. RFC 8693 specifically identifies this error when the authorization server cannot fulfill the number of requested targets.
- **One malformed, unknown, or profile-disallowed resource**: `invalid_target`.
- **Repeated RFC 6749-defined singleton parameters** such as `grant_type` or `scope`: `invalid_request`, subject to the general OAuth token-endpoint rules.

## Security BCP

[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) does not alter empty-value or repeated-parameter processing. Its relevant guidance is to resource-restrict access tokens; it does not require a multi-resource authorization server to accept every requested combination.
