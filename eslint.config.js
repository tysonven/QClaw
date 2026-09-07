/**
 * ESLint flat config.
 *
 * WHY THIS EXISTS
 * `npm run lint` was defined in package.json but had never run, because no
 * eslint config was ever committed. Meanwhile the CI job named `lint` ran two
 * greps instead, and the console.log one emitted `::warning::` with no
 * `exit 1`, so it reported 23 violations on every run and passed. That job is
 * a `needs:` dependency of `deploy`, so "lint passed" in the deploy chain
 * asserted nothing about logging.
 *
 * A validator replaces the grep for three reasons:
 *
 *   1. It understands scope. The grep matched `console.` inside string
 *      literals and comments (the repo has several `console.cloud.google.com`
 *      URLs), so its own count was never trustworthy.
 *   2. Legitimate exceptions carry an inline reason at the line that needs
 *      one, rather than accumulating in a central exclusion list. That list
 *      had already drifted twice: it named four CLI files by hand, and six
 *      newer entrypoint scripts were added afterwards without being added to
 *      it.
 *   3. A new console.log in library or server code is red immediately, rather
 *      than silently joining a tolerated backlog.
 *
 * The ruleset is deliberately narrow. `npm run lint` gates the deploy, so
 * every rule added here turns its existing violations into blocked deploys.
 * Add rules on purpose, not by pulling in a preset.
 */
export default [
  {
    // Vendored, not ours to lint.
    ignores: ["**/agex-sdk/**", "node_modules/**", "**/node_modules/**"],
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
    },
    rules: {
      /**
       * Library and server code logs through src/core/logger.js, so output is
       * structured and levelled and can be routed. console.* bypasses that.
       *
       * An executable script that legitimately prints to stdout should carry
       * an inline `// eslint-disable-next-line no-console -- <reason>` at the
       * line, so the exception is justified where it lives.
       */
      "no-console": "error",
    },
  },
  {
    /**
     * The CLI's whole job is to print to a terminal: its stdout is the
     * product, not a diagnostic, so routing it through the logger would be
     * wrong. This is a directory rule rather than a list of filenames, so
     * adding a new CLI file does not require editing this config.
     */
    files: ["src/cli/**/*.js"],
    rules: { "no-console": "off" },
  },
  {
    /**
     * The logger is what everything else defers to, so it is the one module
     * that has to write to the console directly.
     */
    files: ["src/core/logger.js"],
    rules: { "no-console": "off" },
  },
];
