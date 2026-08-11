export type SecretTextBinding =
  | string
  | {
      readonly get: () => Promise<string>;
    };

export async function resolveSecretText(
  binding: SecretTextBinding | undefined,
): Promise<string | undefined> {
  if (binding === undefined || typeof binding === "string") {
    return binding;
  }

  return binding.get();
}
