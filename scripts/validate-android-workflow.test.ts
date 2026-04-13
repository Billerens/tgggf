import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("android workflow", () => {
  it("exists and builds debug apk artifact", () => {
    const workflowPath = path.resolve(
      process.cwd(),
      ".github/workflows/android-build.yml",
    );
    expect(fs.existsSync(workflowPath)).toBe(true);

    const content = fs.readFileSync(workflowPath, "utf8");
    expect(content).toContain("assembleDebug");
    expect(content).toContain("android-debug-apk");
    expect(content).toContain("app-debug.apk");
  });
});
