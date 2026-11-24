import type { Asset, AssetMeta } from './types';

/** Public metadata must never carry image blobs or local redaction sources. */
export function toAssetMeta(asset: Asset): AssetMeta {
  const { blob: _blob, localScreenshotRedaction: _local, ...meta } = asset;
  return meta;
}
