export const VIRTUAL_LIST_THRESHOLD = 80;
export const VIRTUAL_LIST_OVERSCAN = 5;

export function visibleWindow({ scrollTop, viewportHeight, rowHeight, itemCount, overscan = VIRTUAL_LIST_OVERSCAN }) {
  if (!itemCount) return { start: 0, end: 0 };
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(itemCount, firstVisible + visibleCount + overscan),
  };
}
