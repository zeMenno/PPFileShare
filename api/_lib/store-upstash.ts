import { Redis } from '@upstash/redis';
import type { Store } from './signal-core.js';

let cached: Store | null = null;

/**
 * Store backed by Upstash Redis (the Vercel Marketplace integration).
 * Works with either the KV_* or UPSTASH_REDIS_* variable names the integration sets.
 */
export function upstashStore(): Store {
  if (cached) return cached;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not configured (missing KV_REST_API_URL / KV_REST_API_TOKEN).');
  const redis = new Redis({ url, token, automaticDeserialization: false });

  cached = {
    async get(key) {
      return (await redis.get<string>(key)) ?? null;
    },
    async set(key, value, ttl) {
      await redis.set(key, value, { ex: ttl });
    },
    async del(...keys) {
      if (keys.length) await redis.del(...keys);
    },
    async expire(key, ttl) {
      await redis.expire(key, ttl);
    },
    async mget(keys) {
      if (!keys.length) return [];
      return (await redis.mget<(string | null)[]>(...keys)).map((v) => v ?? null);
    },
    async push(key, value, ttl) {
      await redis.pipeline().rpush(key, value).expire(key, ttl).exec();
    },
    async drain(key) {
      const [items] = await redis.multi().lrange<string>(key, 0, -1).del(key).exec<[string[], number]>();
      return items ?? [];
    },
    async hset(key, field, value, ttl) {
      await redis.pipeline().hset(key, { [field]: value }).expire(key, ttl).exec();
    },
    async hget(key, field) {
      return (await redis.hget<string>(key, field)) ?? null;
    },
    async hdel(key, field) {
      await redis.hdel(key, field);
    },
    async hgetall(key) {
      return ((await redis.hgetall<Record<string, string>>(key)) ?? {}) as Record<string, string>;
    },
    async incr(key, ttl) {
      const [n] = await redis.pipeline().incr(key).expire(key, ttl, 'NX').exec<[number, number]>();
      return n;
    },
  };
  return cached;
}
