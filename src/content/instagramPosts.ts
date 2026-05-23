/**
 * Instagram posts surfaced in the homepage carousel.
 *
 * How to swap a post:
 *   1. Save the post's image as ~800×800 JPG/WebP into public/instagram/<id>.jpg
 *   2. Add or edit the entry below with the post's permalink, alt text, and
 *      optional caption snippet.
 *   3. Commit + push. No build step needed beyond `npm run build`.
 *
 * If this array is empty the carousel section hides itself.
 *
 * Future: an /admin/homepage editor route will Firestore-back this same
 * shape so non-engineers can update without touching the file.
 */
export type InstagramPost = {
  /** Stable key, also used in URLs / logs. Lowercase, hyphen-separated. */
  id: string;
  /** Public permalink to the post on Instagram. */
  permalink: string;
  /** Local image path under public/. Recommended: public/instagram/<id>.jpg */
  imagePath: string;
  /** Alt text for the image. Required for a11y. */
  alt: string;
  /** Optional caption snippet shown beneath the image (2-line clamp). */
  caption?: string;
};

export const INSTAGRAM_POSTS: InstagramPost[] = [
  // Seed entries — replace with real posts. The carousel hides if empty.
];
