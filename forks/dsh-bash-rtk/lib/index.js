import { wrapWithRtk } from "./wrap.js";
import { spawnSync } from "node:child_process";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
//#region src/index.ts
/**
* rtk (Rust Token Killer) bash executor plugin for the DeepSeek Harness.
* Two providers wrap the stock bash executors and rewrite the shell source at
* the `resolve` boundary, so workdir/timeout/env/exit-code/background-job and
* (for the sandbox variant) confinement semantics are all inherited unchanged.
* A command that is not eligible for wrapping (complex shell, non-whitelisted
* tool, or a missing `rtk` binary) passes through byte-for-byte.
*
* @module @deeptrial/dsh-bash-rtk
*/
/** Probe for the `rtk` binary on PATH; absence degrades to the identity transform. */
function resolveRtk() {
	try {
		return spawnSync("rtk", ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		/* v8 ignore next -- spawnSync throws only on a broken runtime, not a missing binary */
		return false;
	}
}
/**
* rtk-wrapping LOCAL bash executor (no file sandbox). Registers as `ctx.shell`
* in place of `dsh-bash-local`; use where confinement is not required (e.g.
* `danger-full-access` deployments).
*/
var RtkBashExecutor = class extends LocalBashExecutor {
	rtkAvailable;
	constructor(ctx, config) {
		super(ctx, config);
		this.rtkAvailable = config.rtkAvailable ?? resolveRtk();
	}
	resolve(request) {
		const spec = super.resolve(request);
		return {
			...spec,
			command: wrapWithRtk(spec.command, this.rtkAvailable)
		};
	}
};
/**
* rtk-wrapping SANDBOX bash executor (preserves file confinement). Registers
* as `ctx.shell` in place of `dsh-bash-sandbox`; the wrap happens before
* `run`/`start` read `spec.command`, so both the `danger-full-access` and the
* confined paths run the already-wrapped source.
*/
var RtkSandboxBashExecutor = class extends SandboxBashExecutor {
	static inject = [
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
	rtkAvailable;
	constructor(ctx, config) {
		super(ctx, config);
		this.rtkAvailable = config.rtkAvailable ?? resolveRtk();
	}
	resolve(request) {
		const spec = super.resolve(request);
		return {
			...spec,
			command: wrapWithRtk(spec.command, this.rtkAvailable)
		};
	}
};
//#endregion
export { RtkBashExecutor, RtkSandboxBashExecutor, RtkSandboxBashExecutor as default, wrapWithRtk };
