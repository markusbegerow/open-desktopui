// Scroll position to use while a reply streams in: follow the bottom, but
// never past the point where the start of the reply would leave the top of
// the viewport. For a short question that means "stick to the bottom"; for a
// long question (whose bubble fills the screen) it means the reply start is
// pinned in view instead of hidden below the fold.
export function followScrollTop(opts: {
  scrollHeight: number;
  clientHeight: number;
  replyTop: number; // reply's top edge, in scroll-content coordinates
  margin?: number;
}): number {
  const { scrollHeight, clientHeight, replyTop, margin = 8 } = opts;
  const bottom = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(bottom, replyTop - margin));
}

// True when the user has moved away from where we last put the scroll
// position (i.e. the scroll event wasn't ours).
export function isUserScroll(scrollTop: number, lastProgrammaticTop: number, tolerance = 2): boolean {
  return Math.abs(scrollTop - lastProgrammaticTop) > tolerance;
}
