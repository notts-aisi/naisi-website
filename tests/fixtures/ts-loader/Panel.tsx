/**
 * Half of the two-file fixture behind one case in `tests/ts-loader.test.mjs`:
 * a plain `.ts` module importing a relative `.tsx` neighbour.
 *
 * It is a fixture rather than a real module because `src` has no server-side
 * example to borrow. The seven `.ts` files there that import a relative `.tsx`
 * are all client feature modules whose graphs reach CSS modules, which the
 * loader refuses by design, so loading one would fail for an unrelated reason
 * and prove nothing about the case under test.
 *
 * Keep it dependency-free: the point is the resolution step and the JSX
 * compiler option, not what the markup says.
 */
export default function Panel({ name }: { name: string }) {
  return <span>Hello {name}</span>;
}
