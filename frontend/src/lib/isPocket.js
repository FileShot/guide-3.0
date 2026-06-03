/** True when built for Pocket cloud IDE (VITE_POCKET=true). */
export default function isPocket() {
  if (import.meta.env.VITE_POCKET === 'true') return true;
  if (typeof window !== 'undefined' && window.__POCKET__) return true;
  return false;
}