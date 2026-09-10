// Fail loudly when the test glob matches nothing.
//
// `node --test "src/**/*.test.ts"` exits 0 when the pattern matches no files,
// which means a renamed directory or a moved test file would turn the CI test
// step green while running nothing at all. That is the one failure mode a test
// job must never have, so npm runs this as `pretest` before the suite.
import { globSync } from "node:fs";

const PATTERN = "src/**/*.test.ts";

const files = globSync(PATTERN);

if (files.length === 0) {
  console.error(
    `No test files matched ${PATTERN}.\n` +
      "Either the tests moved and the glob in package.json needs updating, or " +
      "they were deleted. Passing with zero tests is not a pass."
  );
  process.exit(1);
}

console.log(`${files.length} test file${files.length === 1 ? "" : "s"} found.`);
