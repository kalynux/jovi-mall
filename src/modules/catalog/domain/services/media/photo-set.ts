/**
 * Did a write change WHICH files an entity shows?
 *
 * Used to decide whether a variant edit must re-send its product to the
 * vectoriser: the image search embeds a product's photos, variant photos
 * included (api-doc/n8n/vectoriser/README.md § 15), so a photo added to or
 * removed from a variant is invisible to that search until the product is
 * re-sent.
 *
 * A SET comparison, on purpose. Re-sending costs the vendor credits, and a
 * reorder changes nothing the search can find. Duplicates are ignored for the
 * same reason.
 */
export function photoSetChanged(before: readonly string[], after: readonly string[]): boolean {
  const was = new Set(before);
  const now = new Set(after);
  if (was.size !== now.size) return true;
  for (const id of now) {
    if (!was.has(id)) return true;
  }
  return false;
}
