import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees (.claude/worktrees/*) hold whole copies of the repository.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
