// Pending-knock bookkeeping (spec §knock). One card per guest: a WS reconnect during
// the join flow re-knocks with a NEW connection id but the SAME fingerprint, and the
// stock ssh/browser flows can double-fire a knock too. Without dedup the host sees two
// cards for one guest and can admit the stale one (finding 3), landing a phantom in the
// roster and count. So a re-knock from the same fingerprint REPLACES the prior pending
// knock rather than stacking a duplicate.
//
// Pure, so it is unit-tested without a relay. bin/claude-share.js calls foldKnock on
// each relay KNOCK, swaps in the returned list, and denies the `replaced` connections.

/**
 * Fold a new knock into the pending list, replacing any earlier pending knock from the
 * same (non-empty) fingerprint. Keyless / tokenless guests carry an empty fp — every
 * one of those is a distinct person, so they are never deduped.
 *
 * @param {Array<{id:string,name:string,fp:string,seen:*}>} pending  current pending knocks
 * @param {{id:string,name:string,fp:string,seen:*}} knock            the arriving knock
 * @returns {{pending: Array, replaced: string[]}}  new list (newest knock last) + the
 *   connection ids of the superseded knocks the caller should deny/forget
 */
export function foldKnock(pending, knock) {
  const list = Array.isArray(pending) ? pending : [];
  if (!knock || !knock.fp) return { pending: [...list, knock], replaced: [] };
  const replaced = list.filter((k) => k.fp === knock.fp).map((k) => k.id);
  const kept = list.filter((k) => k.fp !== knock.fp);
  return { pending: [...kept, knock], replaced };
}
