export function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

export function formatShortTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
