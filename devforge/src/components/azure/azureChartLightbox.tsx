// components/azure/atoms/ChartLightbox.tsx
// Atom: fullscreen lightbox overlay for zooming into a chart tile.

import { useEffect } from "react";
import type { AzureTileImage } from "@/hooks/useAzureCapture";

interface ChartLightboxProps {
    image: AzureTileImage;
    onClose: () => void;
}

export default function ChartLightbox({ image, onClose }: ChartLightboxProps) {
    // Close on Escape key
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose]);

    const label = image.name
        .replace(/\.png$/i, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.92)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
                cursor: 'zoom-out',
                padding: 24,
                backdropFilter: 'blur(4px)',
            }}
        >
            <img
                src={image.src}
                alt={label}
                onClick={e => e.stopPropagation()} // don't close when clicking the image itself
                style={{
                    maxWidth: '90vw',
                    maxHeight: '82vh',
                    borderRadius: 10,
                    boxShadow: '0 0 80px rgba(0,0,0,0.9)',
                    border: '1px solid #243044',
                    cursor: 'default',
                }}
            />
            {/* Chart Legends */}
            {image.legends && image.legends.length > 0 && (
                <div
                    onClick={e => e.stopPropagation()}
                    style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'center',
                        marginTop: 16,
                        gap: 12,
                        maxWidth: '90vw',
                        cursor: 'default',
                    }}
                >
                    {image.legends.map((legend, idx) => (
                        <div key={idx} style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 13,
                            fontFamily: 'monospace',
                            color: '#e2e8f0',
                            background: 'rgba(59,130,246,0.1)',
                            border: '1px solid rgba(59,130,246,0.2)',
                            padding: '6px 12px',
                            borderRadius: 8,
                        }}>
                            <span style={{ color: '#4b6280' }}>●</span>
                            <span style={{ fontWeight: 500 }}>{legend.metric}</span>
                            <span style={{ color: '#60a5fa', fontWeight: 600 }}>{legend.value}</span>
                        </div>
                    ))}
                </div>
            )}

            <div style={{
                marginTop: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 16,
            }}>
                <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#94a3b8', fontWeight: 500 }}>
                    {image.title || label}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#4b6280' }}>
                    ESC or click backdrop to close
                </span>
            </div>
        </div>
    );
}