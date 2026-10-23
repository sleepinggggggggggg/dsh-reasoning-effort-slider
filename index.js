/**
 * dsh-reasoning-effort-slider — Host half.
 *
 * The control is entirely Client-side: it reads and writes the same Session
 * model selection the shipped composer model menu uses, through the generated
 * `ctx.remote.session` namespace. No Host-side state, route, or tool is needed,
 * so this half deliberately stays empty — the row exists only so the bundle is
 * installed into the profile and its `dsh.client` half is loaded by the page.
 *
 * @module dsh-reasoning-effort-slider
 */

/** Mount the bundle row. No Host resources are registered. */
export function apply() {}
