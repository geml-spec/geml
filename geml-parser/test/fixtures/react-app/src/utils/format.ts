export function formatCount(count: number): string {
  return count === 1 ? "1 item left" : `${count} items left`;
}

export function formatDate(epochMs: number): string {
  return truncate(new Date(epochMs).toISOString(), 10);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
