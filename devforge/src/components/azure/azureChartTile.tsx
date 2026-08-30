// components/azure/atoms/ChartTile.tsx
// Atom: renders a single Azure chart PNG tile with title, zoom, and stat overlay.

import { useState } from "react";
import type { AzureTileImage } from "@/hooks/useAzureCapture";
import { UI } from '@/lib/chart-colors';

interface ChartTileProps {
    image:   AzureTileImage;
    index:   number;
    onZoom?: (image: AzureTileImage) => void;
}

export default function ChartTile({ image, index, onZoom }: ChartTileProps) {
    const [hovered, setHovered] = useState(false);

    // Parse a clean display name from "tile_3.png" → "Tile 3"
    const label = image.name
        .replace(/\.png$/i, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    return (
        <div
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={() => onZoom?.(image)}
            style={{
                position:     'relative',
                borderRadius: 10,
                overflow:     'hidden',
                cursor:       onZoom ? 'zoom-in' : 'default',
                background:   UI.surface,
                border:       `1px solid ${hovered ? UI.info : UI.border}`,
                boxShadow:    hovered ? '0 8px 28px rgba(59,130,246,0.15)' : '0 2px 8px rgba(0,0,0,0.3)',
                transform:    hovered ? 'translateY(-2px)' : 'translateY(0)',
                transition:   'all 0.18s ease',
            }}
        >
            {/* Chart image */}
            <img
                src={image.src}
                alt={label}
                style={{ width: '100%', display: 'block' }}
            />

            {/* Bottom label bar */}
            <div style={{
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'space-between',
                padding:        '7px 12px',
                borderTop:      `1px solid ${UI.border}`,
                background:     UI.background,
            }}>
                <span style={{
                    fontSize:    11,
                    fontFamily:  'monospace',
                    color:       UI.textDim,
                    letterSpacing: 0.5,
                }}>
                    {label}
                </span>
                <span style={{
                    fontSize:   10,
                    fontFamily: 'monospace',
                    color:      UI.textDim,
                }}>
                    #{index + 1}
                </span>
            </div>

            {/* Zoom hint overlay on hover */}
            {hovered && onZoom && (
                <div style={{
                    position:       'absolute',
                    top:            8,
                    right:          8,
                    background:     'rgba(59,130,246,0.85)',
                    borderRadius:   5,
                    padding:        '3px 7px',
                    fontSize:       10,
                    fontFamily:     'monospace',
                    color:          '#fff',
                    letterSpacing:  0.8,
                    pointerEvents:  'none',
                }}>
                    ZOOM
                </div>
            )}
        </div>
    );
}