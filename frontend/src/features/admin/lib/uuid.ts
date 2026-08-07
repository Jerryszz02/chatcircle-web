/**
 * 生成 UUID v4。
 *
 * 原生 `crypto.randomUUID()` 仅在安全上下文（HTTPS / localhost）可用，
 * 通过 http://局域网IP 等非安全来源访问时该方法不存在，会直接抛
 * "crypto.randomUUID is not a function"。
 * `crypto.getRandomValues()` 在非安全上下文也可用，因此作为降级实现。
 */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // 兜底：极端老旧环境（理论上不会走到）
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 按 RFC 4122 设置 version(4) 与 variant 位
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
    .slice(8, 10)
    .join('')}-${hex.slice(10).join('')}`;
}
