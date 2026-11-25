/** Keep only image files from a picker/drop, sorted by name (numeric-aware). */
export function filterImageFiles(list: FileList | File[]): File[] {
  return Array.from(list)
    .filter(
      (f) =>
        f.type.startsWith("image/") ||
        /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name)
    )
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
