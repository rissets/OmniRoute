import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { toSafeFts5Query } from "../retrieval/fts";

describe("toSafeFts5Query", () => {
  test("treats normal chat punctuation as literal search terms", () => {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(content)");
    db.prepare("INSERT INTO memory_fts(content) VALUES (?)").run(
      "Edit foto terlampir dan pertahankan pakaian.",
    );

    const query = toSafeFts5Query("Edit foto terlampir: pertahankan pakaian, pose, dan latar.");
    expect(() =>
      db.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?").all(query),
    ).not.toThrow();
    expect(
      db.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?").all(query),
    ).toHaveLength(1);
    db.close();
  });

  test("does not allow FTS column/operator injection", () => {
    const query = toSafeFts5Query('tambahan OR no_such_column: value "broken');
    expect(query).not.toContain(":");
    expect(query).toContain('"tambahan"');
    expect(query).toContain('"value"');
  });
});
