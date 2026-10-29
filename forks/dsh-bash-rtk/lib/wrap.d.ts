//#region src/wrap.d.ts
/**
 * Command wrapping for the rtk (Rust Token Killer) bash executor. Pure,
 * side-effect-free decision logic: whether a shell command may be routed
 * through `rtk` and, when it may, the exact `rtk` argv to replace the raw
 * `bash -c` source with.
 *
 * The policy is conservative on purpose — wrapping is a best-effort token
 * optimization, never a semantic change. Three independent guards, in order:
 *
 * 1. **Complexity**: any shell metacharacter that would survive rtk's
 *    single-command boundary (pipelines, lists, redirections, command
 *    substitution, shell variables) disqualifies the command. Wrapping those
 *    would silently change what runs, so they pass through unchanged.
 * 2. **Whitelist**: only a fixed prefix map of development tools that rtk
 *    actually implements is eligible. The map keys are the *executable* name
 *    the shell invokes; the value is the rtk subcommand name (they differ for
 *    a few tools).
 * 3. **Availability**: when the `rtk` binary is absent the whole transform is
 *    the identity, so a deployment without rtk behaves exactly like the plain
 *    local executor.
 *
 * @module @deeptrial/dsh-bash-rtk/wrap
 */
/**
 * Decide whether `command` should be routed through `rtk`, and the argv to use
 * when it should. Returns the original command unchanged for every
 * non-eligible case (complex shell, non-whitelisted tool, or rtk absent).
 *
 * The returned string is handed straight to `bash -c`, so a wrapped result is
 * still executed through the shell and preserves the executor's
 * workdir/timeout/env/exit-code semantics unchanged.
 *
 * @param command - the raw shell command the model asked to run.
 * @param rtkAvailable - whether the `rtk` binary resolved on PATH.
 * @returns the command to execute (possibly wrapped), always non-empty.
 */
declare function wrapWithRtk(command: string, rtkAvailable: boolean): string;
//#endregion
export { wrapWithRtk };