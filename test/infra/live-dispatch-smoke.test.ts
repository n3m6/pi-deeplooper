import { test } from "node:test";

test(
  "live createAgentSession re-entrancy smoke",
  { skip: "Requires a real pi runtime session and credentials." },
  async () => {
    // This intentionally stays skipped in the default local gate. It documents the live
    // smoke that should be enabled when running inside an authenticated pi session.
  },
);
