/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-code-runtime-kernels`.
 * @module @hy-sde-org/dsh-code-runtime-kernels/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@hy-sde-org/dsh-code-runtime-kernels'

/** Cordis companion plugin name. */
export const name = 'code-runtime-nodejs-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this process-boundary implementation exposes no
 * same-process event relation; kernel protocol tests and provider integration
 * tests cover it.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
