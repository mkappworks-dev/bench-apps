/// <reference types="node" />
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: Dirent) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("Base UI boundary", () => {
  it("is imported only from src/components/ui/", () => {
    const offenders = walk(SRC)
      .filter((path) => !path.includes(join("components", "ui")))
      .filter((path) => readFileSync(path, "utf8").includes("@base-ui-components/react"))
      .map((path) => path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });
});
