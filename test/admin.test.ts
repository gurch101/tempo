import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, SELF } from "cloudflare:test";

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe("D1 admin integration", () => {
  it("mounts the package separately from private-area capability auth", async () => {
    const redirect = await SELF.fetch("https://tempo.test/admin", { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("https://tempo.test/admin/");
    const page = await SELF.fetch("https://tempo.test/admin/");
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("<title>Tempo</title>");
    expect(pageHtml).toContain("<h1>Tempo</h1>");
    const schema = await (await SELF.fetch("https://tempo.test/admin/api/schema")).json() as { tables: Array<{name:string;columns:Array<{name:string;sensitive:boolean;readOnly:boolean}>}> };
    expect(schema.tables.some(table => table.name === "timers")).toBe(true);
    expect(schema.tables.some(table => table.name === "d1_migrations")).toBe(false);
    expect(schema.tables.find(table => table.name === "spaces")?.columns.find(column => column.name === "access_key_hash")?.sensitive).toBe(true);
    expect(schema.tables.find(table => table.name === "timers")?.columns.find(column => column.name === "deleted_at")?.readOnly).toBe(true);

    const clientScript = await (await SELF.fetch("https://tempo.test/admin/assets/admin.js")).text();
    expect(clientScript).toContain('xmlns:"http://www.w3.org/2000/svg"');
    expect(clientScript).not.toMatch(/from\s+["']lucide["']/);
    expect(clientScript).toContain("/* reset foreign table list state */");
    expect(clientScript).toMatch(/\.activeViewId=null;\w+\.offset=0;\w+\.filters=\[\];const foreignDefaultSort=/);
  });
});
