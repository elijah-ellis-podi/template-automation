import type { FC } from 'react';

interface FootSideControlsProps {
  footSide: number; // 1=left, 0=right
  onChangeFootSide: () => void;
  onRotate: () => void;
}

export const FootSideControls: FC<FootSideControlsProps> = ({ footSide, onChangeFootSide, onRotate }) => {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-600">
          Current Foot Side: <span className="font-semibold text-black">{footSide === 1 ? 'Left' : 'Right'}</span>
        </span>
        <button onClick={onChangeFootSide} className="cursor-pointer rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
          Change Foot Side
        </button>
        <button onClick={onRotate} className="cursor-pointer rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
          Rotate 180°
        </button>
      </div>
    </div>
  );
};
