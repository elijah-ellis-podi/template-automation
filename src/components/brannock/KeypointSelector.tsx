import type { KeypointLocation, KeypointName } from '@/schemas/brannock';
import { KEYPOINT_NAMES } from '@/schemas/brannock';
import { cn } from '@/utils/classes';
import type { FC, KeyboardEvent } from 'react';

type FootConfig = 'bilateral' | 'left_only' | 'right_only';

interface KeypointSelectorProps {
  activeKeypoint: KeypointName;
  keypoints: Record<KeypointName, KeypointLocation>;
  onActiveKeypointChange: (name: KeypointName) => void;
  footConfig: FootConfig;
}

function isPlaced(kp: KeypointLocation, footConfig: FootConfig): boolean {
  switch (footConfig) {
    case 'bilateral':
      return kp.left_normalized_coordinate !== null && kp.right_normalized_coordinate !== null;
    case 'left_only':
      return kp.left_normalized_coordinate !== null;
    case 'right_only':
      return kp.right_normalized_coordinate !== null;
  }
}

function placementLabel(kp: KeypointLocation, footConfig: FootConfig): string {
  if (footConfig === 'bilateral') {
    const hasLeft = kp.left_normalized_coordinate !== null;
    const hasRight = kp.right_normalized_coordinate !== null;
    if (hasLeft && hasRight) return 'L+R';
    if (hasLeft) return 'L';
    if (hasRight) return 'R';
    return '';
  }
  const coord = footConfig === 'left_only' ? kp.left_normalized_coordinate : kp.right_normalized_coordinate;
  return coord !== null ? 'Set' : '';
}

export const KeypointSelector: FC<KeypointSelectorProps> = ({ activeKeypoint, keypoints, onActiveKeypointChange, footConfig }) => {
  const allPlaced = KEYPOINT_NAMES.every((name) => isPlaced(keypoints[name], footConfig));
  const placedCount = KEYPOINT_NAMES.filter((name) => isPlaced(keypoints[name], footConfig)).length;

  const handleKeyDown = (e: KeyboardEvent, name: KeypointName) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActiveKeypointChange(name);
    }
    // Arrow key navigation
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = KEYPOINT_NAMES.indexOf(name);
      const nextIdx = e.key === 'ArrowDown' ? Math.min(idx + 1, KEYPOINT_NAMES.length - 1) : Math.max(idx - 1, 0);
      onActiveKeypointChange(KEYPOINT_NAMES[nextIdx]);
    }
  };

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-black">Set Keypoints</h3>
        <span className={cn('text-xs', allPlaced ? 'font-medium text-green-600' : 'text-gray-400')}>
          {allPlaced ? 'All set' : `${placedCount}/${KEYPOINT_NAMES.length}`}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-400">Select a keypoint, then click on the foot template to place it</p>

      <div className="mt-2 rounded-md border border-gray-200" role="listbox" aria-label="Keypoints" aria-activedescendant={`kp-${activeKeypoint}`}>
        {KEYPOINT_NAMES.map((name) => {
          const kp = keypoints[name];
          const placed = isPlaced(kp, footConfig);
          const label = placementLabel(kp, footConfig);
          const isActive = activeKeypoint === name;

          return (
            <div
              key={name}
              id={`kp-${name}`}
              role="option"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onActiveKeypointChange(name)}
              onKeyDown={(e) => handleKeyDown(e, name)}
              className={cn(
                'flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 text-sm last:border-b-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-400',
                isActive ? 'bg-blue-50 text-[#0B77FB]' : 'hover:bg-gray-50'
              )}
            >
              <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full transition-colors', placed ? 'bg-green-500' : 'bg-gray-300')} />
              <span className="flex-1">{name}</span>
              {label && <span className={cn('text-xs', isActive ? 'text-blue-400' : 'text-gray-400')}>{label}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};
