import { importPKCS8, SignJWT } from "jose";

export async function signRs256Jwt(
  privateKeyPem: string,
  payload: Record<string, unknown>,
  kid = "test-key-1",
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");

  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid }).sign(privateKey);
}
