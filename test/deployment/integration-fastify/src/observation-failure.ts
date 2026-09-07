import { startServer } from "./server.ts";

await startServer({
  logger: {
    stream: {
      write(message: string) {
        if (JSON.parse(message).event === "installation_access_token_issuance_succeeded") {
          throw new Error("synthetic observation failure");
        }
      },
    },
  },
});
