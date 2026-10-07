import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const directory = "test/integration/.generated";
mkdirSync(directory, { recursive: true });
for (const name of [
  "app",
  "other-app",
  "github-actions",
  "buildkite",
  "google",
  "fly",
  "rotated",
  "untrusted",
]) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(`${directory}/${name}.pem`, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  if (name === "app" || name === "other-app") {
    writeFileSync(
      `${directory}/${name}.public.pem`,
      publicKey.export({ type: "spki", format: "pem" }),
    );
    writeFileSync(
      `${directory}/${name === "app" ? ".env" : ".other-env"}`,
      `${name === "app" ? "GITHUB_APP_PRIVATE_KEY" : "OTHER_GITHUB_APP_PRIVATE_KEY"}=${JSON.stringify(privateKey.export({ type: "pkcs8", format: "pem" }))}\n`,
      { mode: 0o600 },
    );
  }
}
// Wrangler reads both independently generated App secrets from one disposable env file.
appendFileSync(`${directory}/.env`, readFileSync(`${directory}/.other-env`));
writeFileSync(`${directory}/bad-other-app.pem`, "invalid synthetic private key", { mode: 0o600 });
writeFileSync(
  `${directory}/.bad-other-env`,
  `${readFileSync(`${directory}/.env`, "utf8").split("\n")[0]}\nOTHER_GITHUB_APP_PRIVATE_KEY="invalid synthetic private key"\n`,
  { mode: 0o600 },
);
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Integration test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    `${directory}/ca.key`,
    "-out",
    `${directory}/ca.pem`,
  ],
  { stdio: "ignore" },
);
for (const { name, hostnames } of [
  {
    name: "oidc",
    hostnames: [
      "token.actions.githubusercontent.com",
      "agent.buildkite.com",
      "accounts.google.com",
      "www.googleapis.com",
      "oidc.fly.io",
    ],
  },
  { name: "github", hostnames: ["api.github.com"] },
]) {
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${hostnames[0]}`,
      "-keyout",
      `${directory}/${name}.tls.key`,
      "-out",
      `${directory}/${name}.csr`,
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    `${directory}/${name}.ext`,
    `subjectAltName=${hostnames.map((hostname) => `DNS:${hostname}`).join(",")}\nextendedKeyUsage=serverAuth\n`,
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      `${directory}/${name}.csr`,
      "-CA",
      `${directory}/ca.pem`,
      "-CAkey",
      `${directory}/ca.key`,
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      `${directory}/${name}.ext`,
      "-out",
      `${directory}/${name}.crt`,
    ],
    { stdio: "ignore" },
  );
}
