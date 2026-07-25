const title = process.env.WATCHPAIR_PR_TITLE ?? "";
const conventionalTitle =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: \S.+$/;

if (!conventionalTitle.test(title)) {
  console.error(
    'Pull request titles must use Conventional Commits, for example "fix: describe the change".',
  );
  process.exitCode = 1;
}
