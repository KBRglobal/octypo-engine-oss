import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  signParams,
  publicIdFor,
  deliveryUrl,
  cloudinaryConfigFromEnv,
  uploadToCloudinary,
  DEFAULT_TRANSFORM,
  type CloudinaryConfig,
} from './cloudinary.js';

const config: CloudinaryConfig = {
  cloudName: 'demo',
  apiKey: 'key',
  apiSecret: 'secret',
  folder: 'octypo',
};

describe('signature', () => {
  it('signs the sorted parameter string with the secret appended', () => {
    // Cloudinary's rule: signed params sorted by name, joined with &, secret
    // appended, SHA-1. Asserted against the construction rather than a copied
    // digest, and confirmed end to end against the live API — a wrong
    // signature 401s every upload.
    const expected = createHash('sha1')
      .update('public_id=sample_image&timestamp=1315060510abcd')
      .digest('hex');
    expect(signParams({ timestamp: '1315060510', public_id: 'sample_image' }, 'abcd')).toBe(expected);
  });

  it('sorts parameters regardless of the order they were given in', () => {
    const a = signParams({ timestamp: '1', overwrite: 'true', public_id: 'p' }, 's');
    const b = signParams({ public_id: 'p', timestamp: '1', overwrite: 'true' }, 's');
    expect(a).toBe(b);
    expect(a).toBe(
      createHash('sha1').update('overwrite=true&public_id=p&timestamp=1s').digest('hex')
    );
  });

  it('excludes the parameters Cloudinary excludes', () => {
    const withExtras = signParams(
      { timestamp: '1', public_id: 'p', file: 'ignored', api_key: 'ignored', resource_type: 'image' },
      'secret'
    );
    const without = signParams({ timestamp: '1', public_id: 'p' }, 'secret');
    expect(withExtras).toBe(without);
  });
});

describe('public ids', () => {
  it('drops the extension, because the format is chosen at delivery', () => {
    expect(publicIdFor('articles/led-truck.webp', 'octypo')).toBe('octypo/articles/led-truck');
  });

  it('does not produce a double slash from a leading one', () => {
    expect(publicIdFor('/articles/x.jpg', 'octypo')).toBe('octypo/articles/x');
  });

  it('works without a folder', () => {
    expect(publicIdFor('articles/x.jpg')).toBe('articles/x');
  });
});

describe('delivery url', () => {
  it('carries the automatic format and quality transform', () => {
    expect(deliveryUrl(config, 'octypo/articles/x')).toBe(
      `https://res.cloudinary.com/demo/image/upload/${DEFAULT_TRANSFORM}/octypo/articles/x`
    );
  });

  it('honours a custom transform', () => {
    expect(deliveryUrl({ ...config, transform: 'f_auto,q_auto,w_1200' }, 'p')).toContain('w_1200');
  });
});

describe('configuration', () => {
  it('is null unless all three values are present', () => {
    expect(cloudinaryConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      cloudinaryConfigFromEnv({
        CLOUDINARY_CLOUD_NAME: 'demo',
        CLOUDINARY_API_KEY: 'k',
      } as NodeJS.ProcessEnv)
    ).toBeNull();
  });

  it('defaults the folder and transform', () => {
    const cfg = cloudinaryConfigFromEnv({
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
    } as NodeJS.ProcessEnv);
    expect(cfg?.folder).toBe('octypo');
    expect(cfg?.transform).toBe(DEFAULT_TRANSFORM);
  });
});

describe('upload', () => {
  it('signs the request and returns the delivery url for what came back', async () => {
    let sentTo = '';
    let sent: FormData | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      sentTo = url;
      sent = init.body as FormData;
      return new Response(JSON.stringify({ public_id: 'octypo/articles/led-truck' }), { status: 200 });
    }) as unknown as typeof fetch;

    const url = await uploadToCloudinary(config, Buffer.from('bytes'), 'articles/led-truck.webp', 'image/webp', {
      fetchImpl,
      now: () => 1_700_000_000_000,
    });

    expect(sentTo).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(sent!.get('public_id')).toBe('octypo/articles/led-truck');
    expect(sent!.get('timestamp')).toBe('1700000000');
    // Overwriting a stable public id keeps a regenerated image from becoming a
    // second stored copy the customer pays for.
    expect(sent!.get('overwrite')).toBe('true');
    expect(sent!.get('signature')).toBe(
      signParams(
        { public_id: 'octypo/articles/led-truck', timestamp: '1700000000', overwrite: 'true', invalidate: 'true' },
        'secret'
      )
    );
    expect(url).toContain(`/${DEFAULT_TRANSFORM}/octypo/articles/led-truck`);
  });

  it('throws on a rejected upload so the caller can fall back', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(
      uploadToCloudinary(config, Buffer.from('b'), 'a.webp', 'image/webp', { fetchImpl })
    ).rejects.toThrow(/401/);
  });
});
