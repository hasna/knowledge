/**
 * Validate a path that will later be handed to `rm -rf` on a remote host.
 *
 * `mktemp -d <absolute-template>` returns the created directory on stdout and prints nothing
 * there on failure. Consuming that output unchecked means an `rm -rf` whose target is
 * whatever the remote shell happened to produce. `shellQuote('')` renders as `''` and is
 * inert today, but the value is one appended `/*` away from the 2026-07-24 incident in which
 * an empty command substitution turned `rm -rf "$(cmd)"/*` into `rm -rf /*` and destroyed a
 * machine's checkouts. So the check belongs at the assignment, not at the delete, and it
 * does not lean on quoting.
 *
 * Accepts only what this exact template could have produced: `mktemp` replaces the trailing
 * run of `X` in place, so the result is the template's fixed prefix followed by a single
 * non-empty path component. Checking against the template's parent directory alone is not
 * enough - it would accept any unrelated directory that happens to sit beside the temp dir.
 * The bound is derived from the template, so it stays correct if the template moves.
 *
 * @param {string} remote Remote host, used in the error message only.
 * @param {unknown} dir Trimmed stdout of the remote `mktemp -d`.
 * @param {string} template Absolute template passed to `mktemp -d`, ending in `XXX...`.
 * @returns {string} The validated directory.
 * @throws {Error} If the value is anything other than a directory that template could create.
 */
export function assertRemoteTempDir(remote, dir, template) {
  const fail = (why) => {
    throw new Error(
      `Refusing to use remote temp dir from ${remote}: ${why}. `
      + `Template ${template}, got ${JSON.stringify(dir)}. `
      + 'This value is used as an `rm -rf` target on the remote host.'
    );
  };

  if (typeof template !== 'string' || !template.startsWith('/')) {
    throw new Error(`Remote temp dir template must be an absolute path, got ${JSON.stringify(template)}.`);
  }
  // POSIX mktemp requires at least three trailing X in the final component.
  const match = template.match(/^(.*[^X])(X{3,})$/);
  if (!match) {
    throw new Error(`Remote temp dir template must end in at least three X, got ${JSON.stringify(template)}.`);
  }
  const [, prefix] = match;
  if (prefix.includes('/') === false) {
    throw new Error(`Remote temp dir template must have a directory component, got ${JSON.stringify(template)}.`);
  }

  if (typeof dir !== 'string' || dir === '') fail('mktemp -d produced no path');
  if (/[\r\n]/.test(dir)) fail('path spans multiple lines');
  if (!dir.startsWith('/')) fail('path is not absolute');
  if (!dir.startsWith(prefix)) fail(`path does not start with the template prefix ${prefix}`);

  const suffix = dir.slice(prefix.length);
  if (suffix === '') fail('path is the bare template prefix, so mktemp created nothing');
  if (suffix.includes('/')) fail('path descends below the directory the template would create');

  return dir;
}
