import { describe, expect, it } from 'vitest';
import { PB_URL, pb } from './pocketbase';

describe('pocketbase client', () => {
  it('未设置 VITE_PB_URL 时使用本地默认地址', () => {
    expect(PB_URL).toBe('http://127.0.0.1:8090');
  });

  it('pb client 以 PB_URL 初始化', () => {
    expect(pb.baseUrl).toBe(PB_URL);
  });
});
