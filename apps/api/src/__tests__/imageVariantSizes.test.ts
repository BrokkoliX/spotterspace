import { IMAGE_VARIANT_SIZES } from '@spotterspace/shared';
import { describe, it, expect } from 'vitest';

import { s3KeyFromOriginalUrl } from '../scripts/backfillDisplayVariants.js';

/**
 * Pins the `IMAGE_VARIANT_SIZES` contract so an accidental edit to one of
 * the long-edge values is caught in CI rather than in production. The
 * `display` value in particular was previously 640px and produced
 * strongly-downscaled photos; the bump to 2048px is what users see, so it
 * must not silently regress.
 *
 * Also covers `s3KeyFromOriginalUrl`, the helper the backfill task uses to
 * walk back from a stored `Photo.originalUrl` to the S3 object key, since
 * the production backfill cannot run anywhere else and a logic bug here
 * would corrupt every photo's variants.
 */
describe('IMAGE_VARIANT_SIZES', () => {
  it('pins the expected long-edge dimensions', () => {
    expect(IMAGE_VARIANT_SIZES).toEqual({
      thumbnail: 150,
      thumbnail16x9: 640,
      display: 2048,
      fullRes2048: 2048,
      fullRes4096: 4096,
    });
  });

  it('serves a display variant large enough for high-quality viewing', () => {
    // The detail page uses `display` as its primary image. Anything below
    // ~1600px on the long edge is visibly downscaled on common monitors,
    // which was the user-reported "platform resizes my photos" complaint.
    expect(IMAGE_VARIANT_SIZES.display).toBeGreaterThanOrEqual(1600);
  });
});

describe('s3KeyFromOriginalUrl', () => {
  it('extracts the key from a CloudFront-fronted URL', () => {
    expect(
      s3KeyFromOriginalUrl('https://d2ur47prd8ljwz.cloudfront.net/uploads/abc-user/photo-123.jpg'),
    ).toBe('uploads/abc-user/photo-123.jpg');
  });

  it('extracts the key from a direct S3 virtual-hosted URL', () => {
    expect(
      s3KeyFromOriginalUrl(
        'https://spotterspace-photos.s3.us-east-1.amazonaws.com/uploads/u/p.jpg',
      ),
    ).toBe('uploads/u/p.jpg');
  });

  it('extracts the key from a LocalStack path-style URL (dev env)', () => {
    expect(s3KeyFromOriginalUrl('http://localhost:4566/spotterhub-photos/uploads/u/p.jpg')).toBe(
      'spotterhub-photos/uploads/u/p.jpg',
    );
  });

  it('preserves nested key paths and query strings stripped', () => {
    // URL.pathname intentionally drops query params and fragments — that's
    // what we want, since the S3 key never contains them.
    expect(
      s3KeyFromOriginalUrl('https://cdn.example.com/uploads/2026/05/photo.heic?signed=1#x'),
    ).toBe('uploads/2026/05/photo.heic');
  });
});
