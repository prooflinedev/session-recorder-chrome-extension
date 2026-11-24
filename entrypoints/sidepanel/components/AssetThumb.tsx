/**
 * Small inline thumbnail for a screenshot or annotation timeline row.
 *
 * Loads the asset blob from IndexedDB by id, turns it into an object URL, and
 * revokes it on unmount. Renders nothing until the blob resolves, so the row
 * stays clean if the asset is missing.
 */
import React, { useEffect, useState } from 'react';
import { getAsset } from '@/lib/storage';
import { onBroadcast } from '@/lib/messaging';

export function AssetThumb({
  assetId,
  alt,
}: {
  assetId: string | undefined;
  alt: string;
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!assetId) return;
    let objectUrl: string | null = null;
    let active = true;
    void getAsset(assetId).then((asset) => {
      if (!active || !asset) return;
      objectUrl = URL.createObjectURL(asset.blob);
      setUrl(objectUrl);
    });
    const unsubscribe = onBroadcast((event) => {
      if (event.kind !== 'asset/redaction-updated' || event.assetId !== assetId) return;
      void getAsset(assetId).then((asset) => {
        if (!active || !asset) return;
        const next = URL.createObjectURL(asset.blob);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = next;
        setUrl(next);
      });
    });
    return () => {
      active = false;
      unsubscribe();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  if (!assetId || !url) return null;
  return <img className="tl-thumb" src={url} alt={alt} loading="lazy" />;
}
