import { expect, test } from "bun:test";
import { readConfig } from "../src/config";
import { connectDatabase } from "../src/database";
import { connectTestDatabase, testDatabaseUrl } from "./helpers";

const fixture = connectTestDatabase(1);
let plaintextFixture: boolean;
try {
  plaintextFixture = (await fixture`SHOW ssl`)[0].ssl === "off";
} finally {
  await fixture.close({ timeout: 5 });
}

// TLS-capable supplied fixtures cannot demonstrate rejection of a plaintext server.
test.skipIf(!plaintextFixture)(
  "production TLS overrides URL sslmode=disable; private-network explicitly permits plaintext",
  async () => {
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("sslmode", "disable");
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: url.href,
      API_KEYS: crypto.randomUUID(),
    };
    const production = readConfig(env, "api");
    const privateNetwork = readConfig(
      { ...env, DATABASE_TLS: "private-network" },
      "api",
    );
    const secure = connectDatabase(url.href, 1, production.databaseSsl);
    const plaintext = connectDatabase(url.href, 1, privateNetwork.databaseSsl);
    try {
      expect((await plaintext`SHOW ssl`)[0].ssl).toBe("off");
      await expect(secure`SELECT 1`.execute()).rejects.toMatchObject({
        code: "ERR_POSTGRES_TLS_NOT_AVAILABLE",
      });
      expect((await plaintext`SELECT 1 AS connected`)[0].connected).toBe(1);
    } finally {
      await Promise.all([
        secure.close({ timeout: 5 }),
        plaintext.close({ timeout: 5 }),
      ]);
    }
  },
);
