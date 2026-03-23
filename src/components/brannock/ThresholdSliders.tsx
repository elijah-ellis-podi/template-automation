import type { FC } from 'react';

interface ThresholdSlidersProps {
  leftThreshold: number;
  rightThreshold: number;
  onLeftChange: (value: number) => void;
  onRightChange: (value: number) => void;
  showLeft: boolean;
  showRight: boolean;
}

export const ThresholdSliders: FC<ThresholdSlidersProps> = ({ leftThreshold, rightThreshold, onLeftChange, onRightChange, showLeft, showRight }) => {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h3 className="text-lg font-semibold text-black">Set Thresholds</h3>
      <div className="mt-3 flex flex-col gap-3">
        {showLeft && (
          <div className="flex items-center gap-3">
            <label className="w-14 text-sm text-gray-600">Left</label>
            <input
              type="range"
              min={1}
              max={99}
              value={Math.round(leftThreshold * 100)}
              onChange={(e) => onLeftChange(Number(e.target.value) / 100)}
              className="flex-1 accent-gray-900"
            />
            <span className="w-10 text-right text-sm font-medium text-gray-700">{Math.round(leftThreshold * 100)}%</span>
          </div>
        )}
        {showRight && (
          <div className="flex items-center gap-3">
            <label className="w-14 text-sm text-gray-600">Right</label>
            <input
              type="range"
              min={1}
              max={99}
              value={Math.round(rightThreshold * 100)}
              onChange={(e) => onRightChange(Number(e.target.value) / 100)}
              className="flex-1 accent-gray-900"
            />
            <span className="w-10 text-right text-sm font-medium text-gray-700">{Math.round(rightThreshold * 100)}%</span>
          </div>
        )}
      </div>
    </div>
  );
};
