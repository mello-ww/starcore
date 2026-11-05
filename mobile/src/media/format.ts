export function duration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function longDuration(seconds: number | null | undefined): string {
  const minutes = Math.round((seconds ?? 0) / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

export function bytes(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  if (size < 1024 ** 3) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

export function trackCount(value: number | unknown[]): number {
  return Array.isArray(value) ? value.length : Number(value) || 0;
}
