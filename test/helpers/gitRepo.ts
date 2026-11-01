import { execFileSync } from "node:child_process";
import { devNull } from "node:os";

/**
 * An environment for git in a temporary repository: no GIT_* variable can point it at the real repository
 * (a git hook sets GIT_DIR, for one), and no user or system config (signing, hooks, default branch) applies.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"));
  return {
    ...Object.fromEntries(inherited),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Alex Doe",
    GIT_AUTHOR_EMAIL: "alex@contoso.example",
    GIT_COMMITTER_NAME: "Alex Doe",
    GIT_COMMITTER_EMAIL: "alex@contoso.example",
  };
}

/** Runs git in `cwd`, which must be a temporary folder, and returns its trimmed output. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: "pipe" }).trim();
