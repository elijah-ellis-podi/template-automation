import type { NormalizedCoordinate } from '@/schemas/brannock';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { cn } from '@/utils/classes';
import { type FC, useEffect, useRef } from 'react';

export interface KeypointResult {
  name: string;
  left?: NormalizedCoordinate;
  right?: NormalizedCoordinate;
}

// ── Color palette for keypoint markers ──
const KEYPOINT_COLORS: Record<string, string> = {
  Hallux: '#ef4444',
  '1st Metatarsal Head': '#f97316',
  '3rd Metatarsal Head': '#eab308',
  '5th Metatarsal Head': '#22c55e',
  Arch: '#3b82f6',
  Heel: '#a855f7'
};

interface KeypointOverlayCanvasProps {
  thermogramData: Array<Array<number>>;
  keypoints: Array<KeypointResult>;
  className?: string;
}

// ── Copper palette (same as ThermogramHeatmap) ──
function temperatureToRgba(value: number, min: number, max: number): [number, number, number, number] {
  if (value <= 0) return [0, 0, 0, 0];
  const t = max > min ? (value - min) / (max - min) : 0;
  const r = Math.min(255, Math.round(t * 1.3 * 255));
  const g = Math.min(255, Math.round(t * 0.78 * 255));
  const b = Math.min(255, Math.round(t * 0.5 * 255));
  return [r, g, b, 255];
}

export const KeypointOverlayCanvas: FC<KeypointOverlayCanvasProps> = ({ thermogramData, keypoints, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || thermogramData.length === 0) return;

    const rows = thermogramData.length;
    const cols = thermogramData[0].length;

    // Render at 2x for crisp markers
    const scale = 2;
    canvas.width = cols * scale;
    canvas.height = rows * scale;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // ── Draw thermogram ──
    // Create a temp canvas at native resolution, then scale up
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = cols;
    tmpCanvas.height = rows;
    const tmpCtx = tmpCanvas.getContext('2d')!;

    let min = Infinity;
    let max = -Infinity;
    for (const row of thermogramData) {
      for (const val of row) {
        if (val > 0) {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
    }
    if (min === Infinity) {
      min = 0;
      max = 1;
    }

    const imageData = tmpCtx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = (r * cols + c) * 4;
        const [red, green, blue, alpha] = temperatureToRgba(thermogramData[r][c], min, max);
        imageData.data[idx] = red;
        imageData.data[idx + 1] = green;
        imageData.data[idx + 2] = blue;
        imageData.data[idx + 3] = alpha;
      }
    }
    tmpCtx.putImageData(imageData, 0, 0);

    // Scale up
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmpCanvas, 0, 0, cols * scale, rows * scale);

    // ── Draw keypoint markers ──
    const w = cols * scale;
    const h = rows * scale;
    // The thermogram shows both feet side-by-side. Left foot is in the right
    // half of the image, right foot in the left half (anatomical convention).
    // Normalized coords are per-foot (0-1 within each foot's bounding box).
    // For the full-mat view, we just overlay at absolute positions.
    // Since we don't have separate foot bounding boxes, we draw keypoints
    // using full-image normalized coords if available.

    for (const kp of keypoints) {
      const color = KEYPOINT_COLORS[kp.name] || '#ffffff';

      // Draw left-foot keypoint (right half of image)
      if (kp.left) {
        const x = (0.5 + kp.left.x * 0.5) * w;
        const y = kp.left.y * h;
        drawMarker(ctx, x, y, color, scale);
      }
      // Draw right-foot keypoint (left half of image)
      if (kp.right) {
        const x = kp.right.x * 0.5 * w;
        const y = kp.right.y * h;
        drawMarker(ctx, x, y, color, scale);
      }
    }
  }, [thermogramData, keypoints]);

  return <canvas ref={canvasRef} className={cn('h-auto w-full rounded', className)} />;
};

function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, scale: number) {
  const radius = 4 * scale;

  // Outer ring
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 * scale;
  ctx.stroke();

  // Inner filled circle
  ctx.beginPath();
  ctx.arc(x, y, radius - scale, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Center dot
  ctx.beginPath();
  ctx.arc(x, y, scale, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// ── Legend component ──
export const KeypointLegend: FC = () => (
  <div className="flex flex-wrap gap-x-4 gap-y-1">
    {KEYPOINT_NAMES.map((name) => (
      <div key={name} className="flex items-center gap-1.5 text-xs text-gray-600">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: KEYPOINT_COLORS[name] }} />
        {name}
      </div>
    ))}
  </div>
);
