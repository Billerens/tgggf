import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop workflow", () => {
  it("exists and has OS matrix", () => {
    const workflowPath = path.resolve(
      process.cwd(),
      ".github/workflows/desktop-build.yml",
    );
    expect(fs.existsSync(workflowPath)).toBe(true);

    const content = fs.readFileSync(workflowPath, "utf8");
    expect(content).toContain("matrix:");
    expect(content).toContain("windows-latest");
    expect(content).toContain("ubuntu-latest");
    expect(content).toContain("macos-latest");
  });
});
