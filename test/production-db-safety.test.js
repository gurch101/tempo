import { describe, expect, it } from "vitest";
import { assertSafeProductionDbArguments, normalizeD1Export } from "../scripts/production-db-safety.mjs";
import shellPipeline from "../scripts/pull-production-db.sh?raw";

describe("production database snapshot safety", () => {
  it("allows only a read-only export against production", () => {
    expect(() => assertSafeProductionDbArguments(["d1","export","tempo-production","--remote","--env","production","--output","snapshot.sql"])).not.toThrow();
    expect(() => assertSafeProductionDbArguments(["d1","execute","tempo-production","--remote","--command","DELETE FROM spaces"])).toThrow(/Refusing/);
    expect(() => assertSafeProductionDbArguments(["d1","migrations","apply","tempo-production","--remote","--env","production"])).toThrow(/Refusing/);
    expect(() => assertSafeProductionDbArguments(["d1","migrations","apply","tempo-production","--env","production"])).toThrow(/Refusing/);
  });

  it("requires SQL imports to target local persistence", () => {
    expect(() => assertSafeProductionDbArguments(["d1","execute","tempo-production","--local","--persist-to","snapshot","--file","snapshot.sql"])).not.toThrow();
    expect(() => assertSafeProductionDbArguments(["d1","execute","tempo-production","--file","snapshot.sql"])).toThrow(/Refusing/);
  });

  it("allows only the local foreign-key validation command", () => {
    expect(() => assertSafeProductionDbArguments(["d1","execute","tempo-production","--local","--persist-to","snapshot","--command","PRAGMA foreign_key_check;","--json"])).not.toThrow();
    expect(() => assertSafeProductionDbArguments(["d1","execute","tempo-production","--local","--persist-to","snapshot","--command","DELETE FROM spaces"])).toThrow(/Refusing/);
  });

  it("normalizes D1 dumps for schema-order-independent local replay", () => {
    const normalized = normalizeD1Export("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE spaces(active_id INTEGER REFERENCES mesocycles(id));\nINSERT INTO spaces VALUES(1);\nCREATE TABLE mesocycles(id INTEGER);\nINSERT INTO mesocycles VALUES(1);\n");
    expect(normalized).toBe("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE spaces(active_id INTEGER REFERENCES mesocycles(id));\nCREATE TABLE mesocycles(id INTEGER);\nINSERT INTO spaces VALUES(1);\nINSERT INTO mesocycles VALUES(1);\n");
  });

  it("keeps the shell pipeline one-way", async () => {
    const remoteLines = shellPipeline.split("\n").filter(line => line.includes("--remote"));
    expect(remoteLines).toEqual(["  --remote --env production --skip-confirmation --output \"$EXPORT_FILE\""]);
    expect(shellPipeline.match(/d1 execute tempo-production/g)).toHaveLength(2);
    expect(shellPipeline.match(/--local --env production/g)).toHaveLength(2);
    expect(shellPipeline).toContain("mktemp -d /tmp/tempo-production-export.XXXXXX");
  });
});
