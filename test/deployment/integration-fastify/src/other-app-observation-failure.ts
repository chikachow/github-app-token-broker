import { startServer } from "./server.ts";

await startServer({
  logger: {
    stream: {
      write(message: string) {
        const observation = JSON.parse(message);
        if (
          observation.event === "installation_access_token_issuance_succeeded" &&
          observation.github_app?.client_id === "Iv1.otherApp"
        ) {
          throw new Error("synthetic App B observation failure");
        }
      },
    },
  },
});
